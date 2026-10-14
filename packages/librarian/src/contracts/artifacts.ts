import { z } from 'zod';
import { FingerprintSchema } from '../domain/identifiers.js';
import { JsonValueSchema } from '../domain/json.js';
import { PageInputSchema } from '../domain/pagination.js';
import { UUIDSchema } from './common.js';
export const TocNodeSchema = z.strictObject({ level: z.number().int().min(1).max(6), id: z.string(), title: z.string() });
export const AssetManifestEntrySchema = z.strictObject({ path: z.union([z.literal('article.html'), z.literal('article.css'), z.string().regex(/^assets\/diagram-[0-9a-f]{64}\.svg$/)]), media_type: z.string(), sha256: FingerprintSchema });
export const RecordArtifactInputSchema = z.strictObject({
  localeId: UUIDSchema, revisionId: UUIDSchema, compilerFingerprint: FingerprintSchema, dependencyFingerprint: FingerprintSchema,
  html: z.string().max(20_000_000), toc: z.array(TocNodeSchema), assetManifest: z.array(AssetManifestEntrySchema),
  dependencies: z.array(z.strictObject({ referenceId: UUIDSchema, revisionId: UUIDSchema })).max(500),
});
export const GetArtifactInputSchema = z.strictObject({ artifactId: UUIDSchema });
export const ListRevisionArtifactsInputSchema = z.strictObject({ revisionId: UUIDSchema, ...PageInputSchema.shape });
export interface ArticleArtifact { readonly id: string; readonly localeId: string; readonly revisionId: string; readonly compilerFingerprint: string; readonly dependencyFingerprint: string; readonly html: string; readonly toc: readonly z.infer<typeof TocNodeSchema>[]; readonly assetManifest: readonly z.infer<typeof AssetManifestEntrySchema>[]; readonly dependencies: readonly { readonly referenceId: string; readonly revisionId: string }[]; readonly createdAt: Date }
export type ArticleArtifactSummary = Omit<ArticleArtifact, 'html' | 'assetManifest'>;
export type RecordArtifactInput = z.input<typeof RecordArtifactInputSchema>;
export type GetArtifactInput = z.input<typeof GetArtifactInputSchema>;
export type ListRevisionArtifactsInput = z.input<typeof ListRevisionArtifactsInputSchema>;
