import type { ColumnType, Generated, Selectable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type JsonObject = ColumnType<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>> | string, Readonly<Record<string, unknown>> | string>;
type TextArray = ColumnType<readonly string[], readonly string[] | string, readonly string[] | string>;
type BigIntNumber = ColumnType<bigint, bigint | string | number | undefined, bigint | string | number>;

export interface PostsTable { id: Generated<string>; created_at: Timestamp }
export interface PostLocalesTable { id: Generated<string>; post_id: string; locale: 'pt-BR' | 'en-US'; head_revision_id: string | null; head_revision_number: Generated<number>; created_at: Timestamp }
export interface PostRevisionsTable { id: Generated<string>; post_locale_id: string; revision_number: number; parent_revision_id: string | null; title: string; subtitle: string | null; slug: string; markdown: string; excerpt: string | null; seo: JsonObject; presentation: JsonObject; created_at: Timestamp; finalized: Generated<boolean> }
export interface TagsTable { id: Generated<string>; slug: string; created_at: Timestamp }
export interface PostRevisionTagsTable { post_revision_id: string; tag_id: string }
export interface ReferencesTable { id: Generated<string>; citation_key: string; head_revision_id: string | null; head_revision_number: number; created_at: Timestamp }
export interface ReferenceRevisionsTable { id: Generated<string>; reference_id: string; revision_number: number; csl_json: JsonObject; created_at: Timestamp }
export interface ArticleArtifactsTable { id: Generated<string>; post_locale_id: string; post_revision_id: string; compiler_fingerprint: string; dependency_fingerprint: string; html: string; toc: ColumnType<readonly unknown[], readonly unknown[] | string, readonly unknown[] | string>; asset_manifest: ColumnType<readonly unknown[], readonly unknown[] | string, readonly unknown[] | string>; created_at: Timestamp; finalized: Generated<boolean> }
export interface ArtifactReferenceRevisionsTable { artifact_id: string; reference_id: string; reference_revision_id: string }
export interface PostPublicationsTable { post_locale_id: string; post_revision_id: string | null; artifact_id: string | null; version: BigIntNumber; published_at: Timestamp | null; updated_at: Timestamp }
export interface PublicationEventsTable { id: Generated<string>; post_locale_id: string; event_type: 'publish' | 'unpublish' | 'rollback'; post_revision_id: string | null; artifact_id: string | null; previous_version: BigIntNumber | null; new_version: BigIntNumber | null; previous_revision_id: string | null; previous_artifact_id: string | null; created_at: Timestamp }
export interface PublishedArticlesTable { post_locale_id: string; locale: 'pt-BR' | 'en-US'; slug: string; revision_id: string; artifact_id: string; title: string; excerpt: string | null; seo: JsonObject; tags: TextArray; published_at: Timestamp; route_metadata: JsonObject }

export interface Database {
  posts: PostsTable; post_locales: PostLocalesTable; post_revisions: PostRevisionsTable;
  tags: TagsTable; post_revision_tags: PostRevisionTagsTable;
  references: ReferencesTable; reference_revisions: ReferenceRevisionsTable;
  article_artifacts: ArticleArtifactsTable; artifact_reference_revisions: ArtifactReferenceRevisionsTable;
  post_publications: PostPublicationsTable; publication_events: PublicationEventsTable;
  published_articles: PublishedArticlesTable;
}
export type PostRow = Selectable<PostsTable>;
export type LocaleRow = Selectable<PostLocalesTable>;
export type RevisionRow = Selectable<PostRevisionsTable>;
export type ReferenceRow = Selectable<ReferencesTable>;
export type ReferenceRevisionRow = Selectable<ReferenceRevisionsTable>;
export type ArtifactRow = Selectable<ArticleArtifactsTable>;
export type PublicationRow = Selectable<PostPublicationsTable>;
export type EventRow = Selectable<PublicationEventsTable>;
export type PublishedRow = Selectable<PublishedArticlesTable>;
