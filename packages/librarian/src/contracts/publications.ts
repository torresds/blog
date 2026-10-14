import { z } from 'zod';
import { PageInputSchema } from '../domain/pagination.js';
import { LocaleSchema, UUIDSchema } from './common.js';
export const GetPublicationInputSchema = z.strictObject({ localeId: UUIDSchema });
export const PublishInputSchema = z.strictObject({ localeId: UUIDSchema, revisionId: UUIDSchema, artifactId: UUIDSchema, expectedVersion: z.bigint().nonnegative() });
export const UnpublishInputSchema = z.strictObject({ localeId: UUIDSchema, expectedVersion: z.bigint().nonnegative() });
export const RollbackPublicationInputSchema = z.strictObject({ localeId: UUIDSchema, revisionId: UUIDSchema, artifactId: UUIDSchema, expectedVersion: z.bigint().nonnegative() });
export const PublicationHistoryInputSchema = z.strictObject({ localeId: UUIDSchema, ...PageInputSchema.shape });
export const GetPublishedArticleInputSchema = z.strictObject({ locale: LocaleSchema, slug: z.string().min(1).max(200) });
export const ListPublishedArticlesInputSchema = z.strictObject({ locale: LocaleSchema, ...PageInputSchema.shape });
export const ListPublishedByTagInputSchema = z.strictObject({ locale: LocaleSchema, tag: z.string().min(1).max(80), ...PageInputSchema.shape });
export interface PublicationEvent { readonly id: string; readonly localeId: string; readonly action: 'publish' | 'unpublish' | 'rollback'; readonly previousVersion: bigint | null; readonly newVersion: bigint | null; readonly previousRevisionId: string | null; readonly previousArtifactId: string | null; readonly revisionId: string | null; readonly artifactId: string | null; readonly createdAt: Date }
export interface PublishedArticle { readonly locale: 'pt-BR' | 'en-US'; readonly slug: string; readonly title: string; readonly excerpt: string | null; readonly seo: Readonly<Record<string, unknown>>; readonly tags: readonly string[]; readonly publishedAt: Date; readonly revisionId: string; readonly artifactId: string; readonly html: string }
export type PublishedArticleSummary = Omit<PublishedArticle, 'html'>;
export type GetPublicationInput = z.input<typeof GetPublicationInputSchema>;
export type PublishInput = z.input<typeof PublishInputSchema>;
export type UnpublishInput = z.input<typeof UnpublishInputSchema>;
export type RollbackPublicationInput = z.input<typeof RollbackPublicationInputSchema>;
export type PublicationHistoryInput = z.input<typeof PublicationHistoryInputSchema>;
export type GetPublishedArticleInput = z.input<typeof GetPublishedArticleInputSchema>;
export type ListPublishedArticlesInput = z.input<typeof ListPublishedArticlesInputSchema>;
export type ListPublishedByTagInput = z.input<typeof ListPublishedByTagInputSchema>;
