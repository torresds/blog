import { sql, type Kysely, type Transaction } from 'kysely';
import { LibrarianError } from '../../domain/errors.js';
import type { PublishedArticle, PublishedArticleSummary } from '../../contracts/publications.js';
import type { Locale } from '../../domain/identifiers.js';
import type { Page } from '../../domain/pagination.js';
import type { DiscoveryRepository } from '../../ports/discovery.js';
import { decodeJsonObject, decodeTextArray, decodeTimestamp } from './codecs.js';
import type { Database } from './schema.js';
type Executor = Kysely<Database> | Transaction<Database>;
interface Cursor { readonly id: string; readonly publishedAt: string }
function encodeCursor(value: Cursor): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(cursor?: string): { id: string; publishedAt: Date } | undefined {
  if (!cursor) return undefined;
  try { const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); if (typeof value !== 'object' || value === null || !('id' in value) || !('publishedAt' in value) || typeof value.id !== 'string' || typeof value.publishedAt !== 'string') throw new Error(); const publishedAt = new Date(value.publishedAt); if (Number.isNaN(publishedAt.getTime())) throw new Error(); return { id: value.id, publishedAt }; }
  catch { throw new LibrarianError('VALIDATION', 'Pagination cursor is invalid'); }
}
export class PostgresDiscoveryRepository implements DiscoveryRepository {
  constructor(private readonly db: Executor) {}
  async getPublishedArticle(locale: Locale, slug: string): Promise<PublishedArticle | undefined> {
    const row = await this.db.selectFrom('published_articles as p').innerJoin('article_artifacts as a', 'a.id', 'p.artifact_id').select(['p.locale', 'p.slug', 'p.title', 'p.excerpt', 'p.seo', 'p.tags', 'p.published_at', 'p.revision_id', 'p.artifact_id', 'a.html']).where('p.locale', '=', locale).where('p.slug', '=', slug).where('a.finalized', '=', true).executeTakeFirst();
    return row ? { locale: row.locale, slug: row.slug, title: row.title, excerpt: row.excerpt, seo: decodeJsonObject(row.seo), tags: decodeTextArray(row.tags), publishedAt: decodeTimestamp(row.published_at), revisionId: row.revision_id, artifactId: row.artifact_id, html: row.html } : undefined;
  }
  async listPublishedArticles(locale: Locale, limit: number, cursor?: string): Promise<Page<PublishedArticleSummary>> { return this.list(locale, limit, cursor); }
  async listPublishedByTag(locale: Locale, tag: string, limit: number, cursor?: string): Promise<Page<PublishedArticleSummary>> { return this.list(locale, limit, cursor, tag); }
  private async list(locale: Locale, limit: number, cursor?: string, tag?: string): Promise<Page<PublishedArticleSummary>> {
    const decoded = decodeCursor(cursor); let query = this.db.selectFrom('published_articles').select(['post_locale_id', 'locale', 'slug', 'title', 'excerpt', 'seo', 'tags', 'published_at', 'revision_id', 'artifact_id']).where('locale', '=', locale);
    // PostgreSQL array containment needs an explicitly typed array expression; passing a JS array here is encoded as a scalar by pg.
    if (tag !== undefined) query = query.where('tags', '@>', sql<readonly string[]>`ARRAY[${tag}]::text[]`);
    if (decoded) query = query.where((eb) => eb.or([eb('published_at', '<', decoded.publishedAt), eb.and([eb('published_at', '=', decoded.publishedAt), eb('post_locale_id', '<', decoded.id)])]));
    const rows = await query.orderBy('published_at', 'desc').orderBy('post_locale_id', 'desc').limit(limit + 1).execute(); const visible = rows.slice(0, limit);
    const items: PublishedArticleSummary[] = visible.map((row) => ({ locale: row.locale, slug: row.slug, title: row.title, excerpt: row.excerpt, seo: decodeJsonObject(row.seo), tags: decodeTextArray(row.tags), publishedAt: decodeTimestamp(row.published_at), revisionId: row.revision_id, artifactId: row.artifact_id }));
    const last = visible.at(-1); return { items, nextCursor: rows.length > limit && last ? encodeCursor({ id: last.post_locale_id, publishedAt: last.published_at.toISOString() }) : null };
  }
}
