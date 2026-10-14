import type { ArticleHead, ArticleRevision, ArticleRevisionSummary, CommitRevisionInput, CreateTagInput, Post, PostLocale, Tag } from '../contracts/articles.js';
import type { Page } from '../domain/pagination.js';
import type { JsonValue } from '../domain/json.js';
export interface ArticleRepository {
  createPost(): Promise<Post>;
  createLocale(postId: string, locale: 'pt-BR' | 'en-US'): Promise<PostLocale>;
  getPost(postId: string): Promise<Post | undefined>;
  getLocale(localeId: string): Promise<PostLocale | undefined>;
  listPostLocales(postId: string): Promise<readonly PostLocale[]>;
  createTag(input: CreateTagInput): Promise<Tag>;
  commitRevision(input: CommitRevisionInput, tags: readonly Tag[]): Promise<ArticleRevision>;
  getHead(localeId: string): Promise<ArticleHead | undefined>;
  getRevision(revisionId: string): Promise<ArticleRevision | undefined>;
  listRevisions(localeId: string, limit: number, cursor?: string): Promise<Page<ArticleRevisionSummary>>;
  resolveTags(slugs: readonly string[]): Promise<readonly Tag[]>;
}
