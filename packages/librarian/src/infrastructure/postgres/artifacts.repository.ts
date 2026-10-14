import type { Kysely, Transaction } from 'kysely';
import { LibrarianError } from '../../domain/errors.js';
import type { ArticleArtifact, ArticleArtifactSummary, RecordArtifactInput } from '../../contracts/artifacts.js';
import type { Page } from '../../domain/pagination.js';
import type { ArtifactRepository } from '../../ports/artifacts.js';
import { AssetManifestEntrySchema, TocNodeSchema } from '../../contracts/artifacts.js';
import { decodeJsonObject, decodeTimestamp } from './codecs.js';
import type { ArtifactRow, Database } from './schema.js';
import { translatePostgresError } from './errors.js';
type Executor = Kysely<Database> | Transaction<Database>;
function encode(value: { id: string; createdAt: string }): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value?: string): { id: string; createdAt: Date } | undefined {
  if (!value) return undefined;
  try { const data: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); if (typeof data !== 'object' || data === null || !('id' in data) || !('createdAt' in data) || typeof data.id !== 'string' || typeof data.createdAt !== 'string') throw new Error(); const createdAt = new Date(data.createdAt); if (Number.isNaN(createdAt.getTime())) throw new Error(); return { id: data.id, createdAt }; }
  catch { throw new LibrarianError('VALIDATION', 'Pagination cursor is invalid'); }
}
export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: Executor) {}
  async record(input: RecordArtifactInput): Promise<ArticleArtifact> {
    try {
      const revision = await this.db.selectFrom('post_revisions').select(['id', 'post_locale_id', 'finalized']).where('id', '=', input.revisionId).where('post_locale_id', '=', input.localeId).executeTakeFirst();
      if (!revision || !revision.finalized) throw new LibrarianError('INVALID_ARTIFACT', 'Artifact revision does not exist or is not finalized');
      if (input.dependencies.length) {
        const ids = [...new Set(input.dependencies.map((item) => item.revisionId))];
        const valid = await this.db.selectFrom('reference_revisions').select(['id', 'reference_id']).where('id', 'in', ids).execute();
        const byId = new Map(valid.map((row) => [row.id, row.reference_id]));
        if (input.dependencies.some((dep) => byId.get(dep.revisionId) !== dep.referenceId) || new Set(input.dependencies.map((dep) => dep.referenceId)).size !== input.dependencies.length) throw new LibrarianError('INVALID_ARTIFACT', 'Artifact bibliography dependencies are invalid or duplicated');
      }
      const row = await this.db.insertInto('article_artifacts').values({ post_locale_id: input.localeId, post_revision_id: input.revisionId, compiler_fingerprint: input.compilerFingerprint, dependency_fingerprint: input.dependencyFingerprint, html: input.html, toc: JSON.stringify(input.toc), asset_manifest: JSON.stringify(input.assetManifest) }).returningAll().executeTakeFirstOrThrow();
      if (input.dependencies.length) await this.db.insertInto('artifact_reference_revisions').values(input.dependencies.map((dep) => ({ artifact_id: row.id, reference_id: dep.referenceId, reference_revision_id: dep.revisionId }))).execute();
      await this.db.updateTable('article_artifacts').set({ finalized: true }).where('id', '=', row.id).executeTakeFirstOrThrow();
      return this.hydrate(row, input.dependencies);
    } catch (error) { throw translatePostgresError(error); }
  }
  async get(id: string): Promise<ArticleArtifact | undefined> {
    const row = await this.db.selectFrom('article_artifacts').selectAll().where('id', '=', id).where('finalized', '=', true).executeTakeFirst();
    if (!row) return undefined;
    const deps = await this.db.selectFrom('artifact_reference_revisions').select(['reference_id', 'reference_revision_id as revision_id']).where('artifact_id', '=', id).orderBy('reference_id').execute();
    return this.hydrate(row, deps.map((dep) => ({ referenceId: dep.reference_id, revisionId: dep.revision_id })));
  }
  async listForRevision(revisionId: string, limit: number, cursor?: string): Promise<Page<ArticleArtifactSummary>> {
    const before = decode(cursor); let query = this.db.selectFrom('article_artifacts').where('post_revision_id', '=', revisionId).where('finalized', '=', true);
    if (before) query = query.where((eb) => eb.or([eb('created_at', '<', before.createdAt), eb.and([eb('created_at', '=', before.createdAt), eb('id', '<', before.id)])]));
    const rows = await query.select(['id', 'post_locale_id', 'post_revision_id', 'compiler_fingerprint', 'dependency_fingerprint', 'toc', 'created_at']).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute(); const visible = rows.slice(0, limit);
    const deps = visible.length ? await this.db.selectFrom('artifact_reference_revisions').select(['artifact_id', 'reference_id', 'reference_revision_id']).where('artifact_id', 'in', visible.map((row) => row.id)).orderBy('reference_id').execute() : [];
    const depsByArtifact = new Map<string, { referenceId: string; revisionId: string }[]>();
    for (const dep of deps) depsByArtifact.set(dep.artifact_id, [...(depsByArtifact.get(dep.artifact_id) ?? []), { referenceId: dep.reference_id, revisionId: dep.reference_revision_id }]);
    const summaries: ArticleArtifactSummary[] = visible.map((row) => ({ id: row.id, localeId: row.post_locale_id, revisionId: row.post_revision_id, compilerFingerprint: row.compiler_fingerprint, dependencyFingerprint: row.dependency_fingerprint, toc: decodeJson(row.toc) as ArticleArtifact['toc'], dependencies: depsByArtifact.get(row.id) ?? [], createdAt: decodeTimestamp(row.created_at) }));
    const last = visible.at(-1);
    return { items: summaries, nextCursor: rows.length > limit && last ? encode({ id: last.id, createdAt: last.created_at.toISOString() }) : null };
  }
  private hydrate(row: ArtifactRow, dependencies: readonly { readonly referenceId: string; readonly revisionId: string }[]): ArticleArtifact {
    const rawToc = decodeJson(row.toc); const rawManifest = decodeJson(row.asset_manifest);
    const toc = rawToc.map((node) => TocNodeSchema.parse(node)); const assetManifest = rawManifest.map((entry) => AssetManifestEntrySchema.parse(entry));
    return { id: row.id, localeId: row.post_locale_id, revisionId: row.post_revision_id, compilerFingerprint: row.compiler_fingerprint, dependencyFingerprint: row.dependency_fingerprint, html: row.html, toc, assetManifest, dependencies, createdAt: decodeTimestamp(row.created_at) };
  }
}
function decodeJson(value: unknown): readonly unknown[] {
  let result = value;
  if (typeof result === 'string') { try { result = JSON.parse(result) as unknown; } catch (cause) { throw new LibrarianError('INVALID_ARTIFACT', 'Stored artifact JSON is invalid', { cause }); } }
  if (!Array.isArray(result)) throw new LibrarianError('INVALID_ARTIFACT', 'Stored artifact collection is invalid');
  return result;
}
