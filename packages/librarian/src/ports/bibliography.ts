import type { CommitReferenceRevisionInput, Reference, ReferenceHead, ReferenceRevision } from '../contracts/bibliography.js';
import type { Page } from '../domain/pagination.js';
export interface BibliographyRepository {
  createReference(citationKey: string, csl: Readonly<Record<string, unknown>>): Promise<{ reference: Reference; revision: ReferenceRevision }>;
  getReference(id: string): Promise<Reference | undefined>;
  getHead(id: string): Promise<ReferenceHead | undefined>;
  getRevision(id: string): Promise<ReferenceRevision | undefined>;
  listRevisions(id: string, limit: number, cursor?: string): Promise<Page<Omit<ReferenceRevision, 'csl'>>>;
  commitRevision(input: CommitReferenceRevisionInput): Promise<ReferenceRevision>;
  findByCitationKeys(keys: readonly string[]): Promise<readonly (ReferenceRevision & { readonly citationKey: string })[]>;
  importEntries(entries: readonly { readonly citationKey: string; readonly csl: Readonly<Record<string, unknown>> }[]): Promise<readonly { readonly reference: Reference; readonly revision: ReferenceRevision }[]>;
}
