import { z } from 'zod';
import { CitationKeySchema } from '../domain/identifiers.js';
import { UUIDSchema } from './common.js';
export const ResolveCompilationSnapshotInputSchema = z.strictObject({ revisionId: UUIDSchema, citationKeys: z.array(CitationKeySchema).max(500) });
export type ResolveCompilationSnapshotInput = z.input<typeof ResolveCompilationSnapshotInputSchema>;
export interface CompilationSnapshot {
  readonly articleId: string; readonly localeId: string; readonly locale: 'pt-BR' | 'en-US';
  readonly revisionId: string; readonly revisionNumber: number; readonly title: string; readonly slug: string;
  readonly markdown: string; readonly subtitle: string | null; readonly excerpt: string | null;
  readonly seo: Readonly<Record<string, unknown>>; readonly presentation: Readonly<Record<string, unknown>>;
  readonly references: readonly { readonly referenceId: string; readonly citationKey: string; readonly revisionId: string; readonly revisionNumber: number; readonly csl: Readonly<Record<string, unknown>> }[];
}
