import type { PublishedArticle, PublishedArticleSummary } from '../contracts/publications.js';
import type { Locale } from '../domain/identifiers.js';
import type { Page } from '../domain/pagination.js';
export interface DiscoveryRepository {
  getPublishedArticle(locale: Locale, slug: string): Promise<PublishedArticle | undefined>;
  listPublishedArticles(locale: Locale, limit: number, cursor?: string): Promise<Page<PublishedArticleSummary>>;
  listPublishedByTag(locale: Locale, tag: string, limit: number, cursor?: string): Promise<Page<PublishedArticleSummary>>;
}
