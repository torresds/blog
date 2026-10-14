import type { Kysely, Transaction } from 'kysely';
import { LibrarianError } from '../../domain/errors.js';
import type { PublicationEvent } from '../../contracts/publications.js';
import type { Page } from '../../domain/pagination.js';
import type { PublicationState } from '../../domain/publication-state.js';
import type { PublicationRepository } from '../../ports/publications.js';
import { decodeBigInt, decodeJsonObject, decodeTimestamp } from './codecs.js';
import type { Database, EventRow } from './schema.js';
import { translatePostgresError } from './errors.js';
type Executor = Kysely<Database> | Transaction<Database>;
function encodeCursor(value: { id: string; createdAt: string }): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(cursor?: string): { id: string; createdAt: Date } | undefined {
  if (!cursor) return undefined;
  try { const data: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); if (typeof data !== 'object' || data === null || !('id' in data) || !('createdAt' in data) || typeof data.id !== 'string' || typeof data.createdAt !== 'string') throw new Error(); const createdAt = new Date(data.createdAt); if (Number.isNaN(createdAt.getTime())) throw new Error(); return { id: data.id, createdAt }; }
  catch { throw new LibrarianError('VALIDATION', 'Pagination cursor is invalid'); }
}
function eventDto(row: EventRow): PublicationEvent {
  return { id: row.id, localeId: row.post_locale_id, action: row.event_type, previousVersion: row.previous_version === null ? null : decodeBigInt(row.previous_version), newVersion: row.new_version === null ? null : decodeBigInt(row.new_version), previousRevisionId: row.previous_revision_id, previousArtifactId: row.previous_artifact_id, revisionId: row.post_revision_id, artifactId: row.artifact_id, createdAt: decodeTimestamp(row.created_at) };
}
export class PostgresPublicationRepository implements PublicationRepository {
  constructor(private readonly db: Executor) {}
  async get(localeId: string): Promise<PublicationState | undefined> {
    const locale = await this.db.selectFrom('post_locales').select('id').where('id', '=', localeId).executeTakeFirst(); if (!locale) return undefined;
    const row = await this.db.selectFrom('post_publications').selectAll().where('post_locale_id', '=', localeId).executeTakeFirst();
    if (!row || row.post_revision_id === null || row.artifact_id === null) return { status: 'unpublished', localeId, version: row ? decodeBigInt(row.version) : 0n };
    if (row.published_at === null) throw new LibrarianError('INVALID_REVISION', 'Publication pointer is missing its activation time');
    return { status: 'published', localeId, version: decodeBigInt(row.version), revisionId: row.post_revision_id, artifactId: row.artifact_id, publishedAt: decodeTimestamp(row.published_at) };
  }
  async publish(input: { localeId: string; revisionId: string; artifactId: string; expectedVersion: bigint }): Promise<PublicationState> {
    try {
      await this.lockLocale(input.localeId);
      const previous = await this.get(input.localeId); if (!previous) throw new LibrarianError('NOT_FOUND', 'Article locale was not found');
      if (previous.version !== input.expectedVersion) throw new LibrarianError('PUBLICATION_CONFLICT', 'Publication version changed; reload before publishing');
      const artifact = await this.db.selectFrom('article_artifacts').selectAll().where('id', '=', input.artifactId).where('post_locale_id', '=', input.localeId).where('post_revision_id', '=', input.revisionId).where('finalized', '=', true).executeTakeFirst();
      if (!artifact) throw new LibrarianError('INVALID_ARTIFACT', 'Artifact must be finalized and belong to the selected locale and revision');
      const revision = await this.db.selectFrom('post_revisions').selectAll().where('id', '=', input.revisionId).where('post_locale_id', '=', input.localeId).where('finalized', '=', true).executeTakeFirst();
      if (!revision) throw new LibrarianError('INVALID_REVISION', 'Selected article revision is not finalized');
      const locale = await this.db.selectFrom('post_locales').select(['locale', 'post_id']).where('id', '=', input.localeId).executeTakeFirstOrThrow();
      const tagRows = await this.db.selectFrom('post_revision_tags').innerJoin('tags', 'tags.id', 'post_revision_tags.tag_id').select('tags.slug').where('post_revision_tags.post_revision_id', '=', input.revisionId).orderBy('tags.slug').execute();
      const now = new Date(); const next = previous.version + 1n;
      if (previous.status === 'published') await this.db.updateTable('post_publications').set({ post_revision_id: input.revisionId, artifact_id: input.artifactId, version: next, published_at: now, updated_at: now }).where('post_locale_id', '=', input.localeId).execute();
      else await this.db.insertInto('post_publications').values({ post_locale_id: input.localeId, post_revision_id: input.revisionId, artifact_id: input.artifactId, version: next, published_at: now, updated_at: now }).execute();
      await this.db.insertInto('published_articles').values({ post_locale_id: input.localeId, locale: locale.locale, slug: revision.slug, revision_id: revision.id, artifact_id: artifact.id, title: revision.title, excerpt: revision.excerpt, seo: JSON.stringify(decodeJsonObject(revision.seo)), tags: tagRows.map((tag) => tag.slug), published_at: now, route_metadata: JSON.stringify({ postId: locale.post_id }) }).onConflict((oc) => oc.column('post_locale_id').doUpdateSet({ locale: locale.locale, slug: revision.slug, revision_id: revision.id, artifact_id: artifact.id, title: revision.title, excerpt: revision.excerpt, seo: JSON.stringify(decodeJsonObject(revision.seo)), tags: tagRows.map((tag) => tag.slug), published_at: now, route_metadata: JSON.stringify({ postId: locale.post_id }) })).execute();
      await this.db.insertInto('publication_events').values({ post_locale_id: input.localeId, event_type: 'publish', post_revision_id: input.revisionId, artifact_id: input.artifactId, previous_version: previous.version, new_version: next, previous_revision_id: previous.status === 'published' ? previous.revisionId : null, previous_artifact_id: previous.status === 'published' ? previous.artifactId : null }).execute();
      return { status: 'published', localeId: input.localeId, version: next, revisionId: input.revisionId, artifactId: input.artifactId, publishedAt: now };
    } catch (error) { throw translatePostgresError(error); }
  }
  async unpublish(input: { localeId: string; expectedVersion: bigint }): Promise<PublicationState> {
    try {
      await this.lockLocale(input.localeId); const previous = await this.get(input.localeId); if (!previous) throw new LibrarianError('NOT_FOUND', 'Article locale was not found');
      if (previous.version !== input.expectedVersion) throw new LibrarianError('PUBLICATION_CONFLICT', 'Publication version changed; reload before unpublishing');
      if (previous.status !== 'published') throw new LibrarianError('INVALID_PUBLICATION_TRANSITION', 'An unpublished article cannot be unpublished again');
      const next = previous.version + 1n; const now = new Date();
      await this.db.updateTable('post_publications').set({ post_revision_id: null, artifact_id: null, version: next, published_at: null, updated_at: now }).where('post_locale_id', '=', input.localeId).execute();
      await this.db.deleteFrom('published_articles').where('post_locale_id', '=', input.localeId).execute();
      await this.db.insertInto('publication_events').values({ post_locale_id: input.localeId, event_type: 'unpublish', post_revision_id: null, artifact_id: null, previous_version: previous.version, new_version: next, previous_revision_id: previous.revisionId, previous_artifact_id: previous.artifactId }).execute();
      return { status: 'unpublished', localeId: input.localeId, version: next };
    } catch (error) { throw translatePostgresError(error); }
  }
  async rollback(input: { localeId: string; revisionId: string; artifactId: string; expectedVersion: bigint }): Promise<PublicationState> {
    try {
      await this.lockLocale(input.localeId); const previous = await this.get(input.localeId); if (!previous) throw new LibrarianError('NOT_FOUND', 'Article locale was not found');
      if (previous.version !== input.expectedVersion) throw new LibrarianError('PUBLICATION_CONFLICT', 'Publication version changed; reload before rollback');
      if (previous.status !== 'published') throw new LibrarianError('INVALID_PUBLICATION_TRANSITION', 'Only a published article can be rolled back');
      if (previous.revisionId === input.revisionId && previous.artifactId === input.artifactId) throw new LibrarianError('INVALID_PUBLICATION_TRANSITION', 'Rollback target must differ from the active publication');
      const historical = await this.db.selectFrom('publication_events').select('id').where('post_locale_id', '=', input.localeId).where('event_type', 'in', ['publish', 'rollback']).where('post_revision_id', '=', input.revisionId).where('artifact_id', '=', input.artifactId).executeTakeFirst();
      if (!historical) throw new LibrarianError('INVALID_PUBLICATION_TRANSITION', 'Rollback target was not previously published for this locale');
      const artifact = await this.db.selectFrom('article_artifacts').selectAll().where('id', '=', input.artifactId).where('post_locale_id', '=', input.localeId).where('post_revision_id', '=', input.revisionId).where('finalized', '=', true).executeTakeFirst();
      const revision = await this.db.selectFrom('post_revisions').selectAll().where('id', '=', input.revisionId).where('post_locale_id', '=', input.localeId).where('finalized', '=', true).executeTakeFirst();
      if (!artifact || !revision) throw new LibrarianError('INVALID_PUBLICATION_TRANSITION', 'Rollback target is no longer a valid published revision and artifact pair');
      const locale = await this.db.selectFrom('post_locales').select(['locale', 'post_id']).where('id', '=', input.localeId).executeTakeFirstOrThrow();
      const tags = await this.db.selectFrom('post_revision_tags').innerJoin('tags', 'tags.id', 'post_revision_tags.tag_id').select('tags.slug').where('post_revision_tags.post_revision_id', '=', input.revisionId).orderBy('tags.slug').execute();
      const next = previous.version + 1n; const now = new Date();
      await this.db.updateTable('post_publications').set({ post_revision_id: input.revisionId, artifact_id: input.artifactId, version: next, published_at: now, updated_at: now }).where('post_locale_id', '=', input.localeId).execute();
      await this.db.updateTable('published_articles').set({ locale: locale.locale, slug: revision.slug, revision_id: revision.id, artifact_id: artifact.id, title: revision.title, excerpt: revision.excerpt, seo: JSON.stringify(decodeJsonObject(revision.seo)), tags: tags.map((tag) => tag.slug), published_at: now, route_metadata: JSON.stringify({ postId: locale.post_id }) }).where('post_locale_id', '=', input.localeId).execute();
      await this.db.insertInto('publication_events').values({ post_locale_id: input.localeId, event_type: 'rollback', post_revision_id: input.revisionId, artifact_id: input.artifactId, previous_version: previous.version, new_version: next, previous_revision_id: previous.revisionId, previous_artifact_id: previous.artifactId }).execute();
      return { status: 'published', localeId: input.localeId, version: next, revisionId: input.revisionId, artifactId: input.artifactId, publishedAt: now };
    } catch (error) { throw translatePostgresError(error); }
  }
  async history(localeId: string, limit: number, cursor?: string): Promise<Page<PublicationEvent>> {
    const before = decodeCursor(cursor); let query = this.db.selectFrom('publication_events').selectAll().where('post_locale_id', '=', localeId);
    if (before) query = query.where((eb) => eb.or([eb('created_at', '<', before.createdAt), eb.and([eb('created_at', '=', before.createdAt), eb('id', '<', before.id)])]));
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute(); const visible = rows.slice(0, limit); const last = visible.at(-1);
    return { items: visible.map(eventDto), nextCursor: rows.length > limit && last ? encodeCursor({ id: last.id, createdAt: last.created_at.toISOString() }) : null };
  }
  private async lockLocale(localeId: string): Promise<void> {
    const row = await this.db.selectFrom('post_locales').select('id').where('id', '=', localeId).forUpdate().executeTakeFirst();
    if (!row) throw new LibrarianError('NOT_FOUND', 'Article locale was not found');
  }
}
