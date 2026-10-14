import { z } from 'zod';
import { JsonObjectSchema } from '../domain/json.js';
import { CitationKeySchema } from '../domain/identifiers.js';
import { PageInputSchema } from '../domain/pagination.js';
import { UUIDSchema } from './common.js';

export const CSLRecordSchema = JsonObjectSchema.superRefine((record, ctx) => {
  if (typeof record.id !== 'string' || record.id.length === 0) ctx.addIssue({ code: 'custom', path: ['id'], message: 'CSL identifier is required' });
  if (typeof record.type !== 'string' || record.type.length === 0) ctx.addIssue({ code: 'custom', path: ['type'], message: 'CSL type is required' });
  if (typeof record.title !== 'string' || record.title.length === 0) ctx.addIssue({ code: 'custom', path: ['title'], message: 'CSL title is required' });
  for (const field of ['author', 'editor', 'translator'] as const) {
    const value = record[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((person) => typeof person !== 'object' || person === null || Array.isArray(person)))) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${field} must be an array of CSL name objects` });
    }
  }
  const issued = record.issued;
  if (issued !== undefined && (typeof issued !== 'object' || issued === null || Array.isArray(issued)
      || !('date-parts' in issued) || !Array.isArray(issued['date-parts']))) {
    ctx.addIssue({ code: 'custom', path: ['issued'], message: 'issued must contain CSL date-parts' });
  }
});
export type CSLRecord = z.infer<typeof CSLRecordSchema>;
export const CreateReferenceInputSchema = z.strictObject({ citationKey: CitationKeySchema, csl: CSLRecordSchema });
export const GetReferenceInputSchema = z.strictObject({ referenceId: UUIDSchema });
export const GetReferenceHeadInputSchema = z.strictObject({ referenceId: UUIDSchema });
export const GetReferenceRevisionInputSchema = z.strictObject({ revisionId: UUIDSchema });
export const ListReferenceRevisionsInputSchema = z.strictObject({ referenceId: UUIDSchema, ...PageInputSchema.shape });
export const CommitReferenceRevisionInputSchema = z.strictObject({ referenceId: UUIDSchema, expectedHeadId: UUIDSchema, expectedHeadNumber: z.number().int().positive(), csl: CSLRecordSchema });
export const ParseBibTeXInputSchema = z.strictObject({ source: z.string().min(1).max(2_000_000) });
export const ImportBibTeXInputSchema = z.strictObject({ source: z.string().min(1).max(2_000_000) });

export interface Reference { readonly id: string; readonly citationKey: string; readonly createdAt: Date }
export interface ReferenceHead { readonly referenceId: string; readonly revisionId: string | null; readonly revisionNumber: number }
export interface ReferenceRevision { readonly id: string; readonly referenceId: string; readonly revisionNumber: number; readonly csl: CSLRecord; readonly createdAt: Date }
export type ReferenceRevisionSummary = Omit<ReferenceRevision, 'csl'>;
export type BibTeXParseResult = { readonly entries: readonly { readonly citationKey: string; readonly csl: CSLRecord }[]; readonly issues: readonly string[] };
export type BibTeXImportResult = { readonly references: readonly Reference[]; readonly revisions: readonly ReferenceRevision[] };
export type CreateReferenceInput = z.input<typeof CreateReferenceInputSchema>;
export type GetReferenceInput = z.input<typeof GetReferenceInputSchema>;
export type GetReferenceHeadInput = z.input<typeof GetReferenceHeadInputSchema>;
export type GetReferenceRevisionInput = z.input<typeof GetReferenceRevisionInputSchema>;
export type ListReferenceRevisionsInput = z.input<typeof ListReferenceRevisionsInputSchema>;
export type CommitReferenceRevisionInput = z.input<typeof CommitReferenceRevisionInputSchema>;
export type ParseBibTeXInput = z.input<typeof ParseBibTeXInputSchema>;
export type ImportBibTeXInput = z.input<typeof ImportBibTeXInputSchema>;
