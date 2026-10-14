import type { Kysely, Transaction } from 'kysely';
import { LibrarianError } from '../../domain/errors.js';
import type { CommitRevisionInput, ArticleRevision, ArticleRevisionSummary, ArticleHead, CreateTagInput, Post, PostLocale, Tag } from '../../contracts/articles.js';
import type { Page } from '../../domain/pagination.js';
import type { ArticleRepository } from '../../ports/articles.js';
import { decodeJsonObject, decodeTimestamp } from './codecs.js';
import type { Database, LocaleRow, RevisionRow } from './schema.js';
import { translatePostgresError } from './errors.js';

type Executor = Kysely<Database> | Transaction<Database>;
function cursorEncode(value: number): string { return Buffer.from(String(value)).toString('base64url'); }
function cursorDecode(value?: string): number | undefined {
  if (!value) return undefined;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) throw new LibrarianError('VALIDATION', 'Pagination cursor is invalid');
  return Number(decoded);
}
function localeDto(row: LocaleRow): PostLocale { return { id: row.id, postId: row.post_id, locale: row.locale, headRevisionId: row.head_revision_id, headRevisionNumber: row.head_revision_number, createdAt: decodeTimestamp(row.created_at) }; }

export class PostgresArticleRepository implements ArticleRepository {
  constructor(private readonly db: Executor) {}
  async createPost(): Promise<Post> {
    const row = await this.db.insertInto('posts').defaultValues().returningAll().executeTakeFirstOrThrow();
    return { id: row.id, createdAt: decodeTimestamp(row.created_at) };
  }
  async createLocale(postId: string, locale: 'pt-BR' | 'en-US'): Promise<PostLocale> {
    try { return localeDto(await this.db.insertInto('post_locales').values({ post_id: postId, locale }).returningAll().executeTakeFirstOrThrow()); }
    catch (error) { throw translatePostgresError(error); }
  }
  async getPost(postId: string): Promise<Post | undefined> {
    const row = await this.db.selectFrom('posts').selectAll().where('id', '=', postId).executeTakeFirst();
    return row ? { id: row.id, createdAt: decodeTimestamp(row.created_at) } : undefined;
  }
  async getLocale(localeId: string): Promise<PostLocale | undefined> {
    const row = await this.db.selectFrom('post_locales').selectAll().where('id', '=', localeId).executeTakeFirst();
    return row ? localeDto(row) : undefined;
  }
  async listPostLocales(postId: string): Promise<readonly PostLocale[]> {
    const rows = await this.db.selectFrom('post_locales').selectAll().where('post_id', '=', postId).orderBy('locale').execute();
    return rows.map(localeDto);
  }
  async createTag(input: CreateTagInput): Promise<Tag> {
    try { const row = await this.db.insertInto('tags').values({ slug: input.slug }).returningAll().executeTakeFirstOrThrow(); return { id: row.id, slug: row.slug, createdAt: decodeTimestamp(row.created_at) }; }
    catch (error) { throw translatePostgresError(error); }
  }
  async resolveTags(slugs: readonly string[]): Promise<readonly Tag[]> {
    if (!slugs.length) return [];
    const rows = await this.db.selectFrom('tags').selectAll().where('slug', 'in', [...slugs]).execute();
    return rows.map((row) => ({ id: row.id, slug: row.slug, createdAt: decodeTimestamp(row.created_at) }));
  }
  async commitRevision(input: CommitRevisionInput, tags: readonly Tag[]): Promise<ArticleRevision> {
    try {
      const head = await this.db.selectFrom('post_locales').selectAll().where('id', '=', input.localeId).forUpdate().executeTakeFirst();
      if (!head) throw new LibrarianError('NOT_FOUND', 'Article locale was not found');
      if (head.head_revision_id !== input.expectedHeadId || head.head_revision_number !== input.expectedHeadNumber) throw new LibrarianError('REVISION_CONFLICT', 'Article editing head changed; reload before committing');
      const revisionNumber = head.head_revision_number + 1;
      const parentRevisionId = head.head_revision_id;
      const row = await this.db.insertInto('post_revisions').values({
        post_locale_id: input.localeId, revision_number: revisionNumber, parent_revision_id: parentRevisionId,
        title: input.title, subtitle: input.subtitle ?? null, slug: input.slug, markdown: input.markdown,
        excerpt: input.excerpt ?? null, seo: JSON.stringify(input.seo), presentation: JSON.stringify(input.presentation),
      }).returningAll().executeTakeFirstOrThrow();
      if (tags.length) await this.db.insertInto('post_revision_tags').values(tags.map((tag) => ({ post_revision_id: row.id, tag_id: tag.id }))).execute();
      await this.db.updateTable('post_revisions').set({ finalized: true }).where('id', '=', row.id).executeTakeFirstOrThrow();
      let update = this.db.updateTable('post_locales').set({ head_revision_id: row.id, head_revision_number: revisionNumber }).where('id', '=', input.localeId).where('head_revision_number', '=', input.expectedHeadNumber);
      update = input.expectedHeadId === null ? update.where('head_revision_id', 'is', null) : update.where('head_revision_id', '=', input.expectedHeadId);
      const changed = await update.returning('id').executeTakeFirst();
      if (!changed) throw new LibrarianError('REVISION_CONFLICT', 'Article editing head changed; reload before committing');
      return this.hydrateRevision(row, tags.map((tag) => tag.slug));
    } catch (error) { throw translatePostgresError(error); }
  }
  async getHead(localeId: string): Promise<ArticleHead | undefined> {
    const row = await this.db.selectFrom('post_locales').select(['id', 'head_revision_id', 'head_revision_number']).where('id', '=', localeId).executeTakeFirst();
    return row ? { localeId: row.id, revisionId: row.head_revision_id, revisionNumber: row.head_revision_number } : undefined;
  }
  async getRevision(revisionId: string): Promise<ArticleRevision | undefined> {
    const row = await this.db.selectFrom('post_revisions').selectAll().where('id', '=', revisionId).where('finalized', '=', true).executeTakeFirst();
    if (!row) return undefined;
    const tags = await this.db.selectFrom('post_revision_tags').innerJoin('tags', 'tags.id', 'post_revision_tags.tag_id').select('tags.slug').where('post_revision_tags.post_revision_id', '=', revisionId).orderBy('tags.slug').execute();
    return this.hydrateRevision(row, tags.map((tag) => tag.slug));
  }
  async listRevisions(localeId: string, limit: number, cursor?: string): Promise<Page<ArticleRevisionSummary>> {
    const before = cursorDecode(cursor);
    let query = this.db.selectFrom('post_revisions').select(['id', 'post_locale_id', 'revision_number', 'parent_revision_id', 'title', 'subtitle', 'slug', 'excerpt', 'created_at']).where('post_locale_id', '=', localeId).where('finalized', '=', true);
    if (before !== undefined) query = query.where('revision_number', '<', before);
    const rows = await query.orderBy('revision_number', 'desc').limit(limit + 1).execute();
    const visible = rows.slice(0, limit);
    const tagRows = visible.length ? await this.db.selectFrom('post_revision_tags').innerJoin('tags', 'tags.id', 'post_revision_tags.tag_id').select(['post_revision_tags.post_revision_id as revision_id', 'tags.slug']).where('post_revision_tags.post_revision_id', 'in', visible.map((row) => row.id)).orderBy('tags.slug').execute() : [];
    const tagsByRevision = new Map<string, string[]>();
    for (const item of tagRows) tagsByRevision.set(item.revision_id, [...(tagsByRevision.get(item.revision_id) ?? []), item.slug]);
    const items: ArticleRevisionSummary[] = visible.map((row) => ({ id: row.id, localeId: row.post_locale_id, revisionNumber: row.revision_number, parentRevisionId: row.parent_revision_id, title: row.title, subtitle: row.subtitle, slug: row.slug, excerpt: row.excerpt, tags: [...(tagsByRevision.get(row.id) ?? [])], createdAt: decodeTimestamp(row.created_at) }));
    const last = visible.at(-1);
    return { items, nextCursor: rows.length > limit && last ? cursorEncode(last.revision_number) : null };
  }
  private hydrateRevision(row: RevisionRow, tags: string[]): ArticleRevision {
    return { id: row.id, localeId: row.post_locale_id, revisionNumber: row.revision_number, parentRevisionId: row.parent_revision_id, title: row.title, subtitle: row.subtitle, slug: row.slug, markdown: row.markdown, excerpt: row.excerpt, seo: decodeJsonObject(row.seo), presentation: decodeJsonObject(row.presentation), tags, createdAt: decodeTimestamp(row.created_at) };
  }
}
