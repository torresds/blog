import { z } from 'zod';
import { JsonObjectSchema } from '../domain/json.js';
import { PageInputSchema } from '../domain/pagination.js';
import { ArticleTitleSchema, LocaleSchema, MarkdownSchema, SlugSchema, UUIDSchema } from './common.js';

export const SubtitleSchema = z.string().max(400);
export const ExcerptSchema = z.string().max(1000);
export const TagSlugSchema = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const SEOMetadataSchema = JsonObjectSchema;
export const PresentationMetadataSchema = JsonObjectSchema;

export const ArticleMetadataSchema = z.strictObject({
  title: ArticleTitleSchema,
  subtitle: SubtitleSchema.nullable().optional(),
  slug: SlugSchema,
  markdown: MarkdownSchema,
  excerpt: ExcerptSchema.nullable().optional(),
  seo: SEOMetadataSchema.default({}),
  presentation: PresentationMetadataSchema.default({}),
  tags: z.array(TagSlugSchema).max(32).transform((tags) => [...new Set(tags)]).default([]),
});
export type ArticleMetadata = z.output<typeof ArticleMetadataSchema>;
export const CreateLocaleInputSchema = z.strictObject({ postId: UUIDSchema, locale: LocaleSchema });
export const GetPostInputSchema = z.strictObject({ postId: UUIDSchema });
export const GetLocaleInputSchema = z.strictObject({ localeId: UUIDSchema });
export const ListPostLocalesInputSchema = z.strictObject({ postId: UUIDSchema });
export const CreateTagInputSchema = z.strictObject({ slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) });
export const CommitRevisionInputSchema = ArticleMetadataSchema.extend({
  localeId: UUIDSchema,
  expectedHeadId: UUIDSchema.nullable(),
  expectedHeadNumber: z.number().int().nonnegative(),
});
export const GetArticleHeadInputSchema = z.strictObject({ localeId: UUIDSchema });
export const GetArticleRevisionInputSchema = z.strictObject({ revisionId: UUIDSchema });
export const ListArticleRevisionsInputSchema = z.strictObject({ localeId: UUIDSchema, ...PageInputSchema.shape });

export interface Post { readonly id: string; readonly createdAt: Date }
export interface PostLocale { readonly id: string; readonly postId: string; readonly locale: z.infer<typeof LocaleSchema>; readonly headRevisionId: string | null; readonly headRevisionNumber: number; readonly createdAt: Date }
export interface Tag { readonly id: string; readonly slug: string; readonly createdAt: Date }
export interface ArticleRevision extends ArticleMetadata { readonly id: string; readonly localeId: string; readonly revisionNumber: number; readonly parentRevisionId: string | null; readonly createdAt: Date }
export type ArticleRevisionSummary = Omit<ArticleRevision, 'markdown' | 'seo' | 'presentation'>;
export interface ArticleHead { readonly localeId: string; readonly revisionId: string | null; readonly revisionNumber: number }
export type CreateLocaleInput = z.input<typeof CreateLocaleInputSchema>;
export type GetPostInput = z.input<typeof GetPostInputSchema>;
export type GetLocaleInput = z.input<typeof GetLocaleInputSchema>;
export type ListPostLocalesInput = z.input<typeof ListPostLocalesInputSchema>;
export type CreateTagInput = z.input<typeof CreateTagInputSchema>;
export type CommitRevisionInput = z.input<typeof CommitRevisionInputSchema>;
export type GetArticleHeadInput = z.input<typeof GetArticleHeadInputSchema>;
export type GetArticleRevisionInput = z.input<typeof GetArticleRevisionInputSchema>;
export type ListArticleRevisionsInput = z.input<typeof ListArticleRevisionsInputSchema>;
