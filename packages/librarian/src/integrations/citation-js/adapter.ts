import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import { CSLRecordSchema, type BibTeXParseResult, type CSLRecord } from '../../contracts/bibliography.js';
import type { BibTeXParser } from '../../application/create-librarian.js';

interface CitationJsEntry { readonly id?: unknown; readonly 'citation-key'?: unknown; readonly [field: string]: unknown }
function isEntry(value: unknown): value is CitationJsEntry { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export const citationJsBibTeXParser: BibTeXParser = {
  parse(source: string): BibTeXParseResult {
    try {
      const cite = new Cite(source);
      const entries: { citationKey: string; csl: CSLRecord }[] = [];
      const issues: string[] = [];
      const seen = new Set<string>();
      for (const raw of cite.data as unknown[]) {
        if (!isEntry(raw)) { issues.push('Citation.js returned an invalid bibliography entry'); continue; }
        const key = typeof raw['citation-key'] === 'string' ? raw['citation-key'] : typeof raw.id === 'string' ? raw.id : '';
        if (!key) { issues.push('Bibliography entry has no citation key'); continue; }
        if (seen.has(key)) { issues.push(`Duplicate BibTeX citation key: ${key}`); continue; }
        seen.add(key);
        const csl = Object.fromEntries(Object.entries(raw).filter(([name]) => name !== '_graph' && name !== 'citation-key'));
        csl.id = key;
        const validated = CSLRecordSchema.safeParse(csl);
        if (!validated.success) { issues.push(`BibTeX entry ${key}: ${validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`); continue; }
        entries.push({ citationKey: key, csl: validated.data });
      }
      return { entries, issues };
    } catch (error) {
      return { entries: [], issues: [error instanceof Error ? `BibTeX parse failed: ${error.message}` : 'BibTeX parse failed'] };
    }
  },
};
