import type { Kysely, Transaction } from 'kysely';
import { LibrarianError } from '../../domain/errors.js';
import type { Reference, ReferenceHead, ReferenceRevision } from '../../contracts/bibliography.js';
import type { Page } from '../../domain/pagination.js';
import type { BibliographyRepository } from '../../ports/bibliography.js';
import { decodeJsonObject, decodeTimestamp } from './codecs.js';
import type { Database, ReferenceRevisionRow } from './schema.js';
import { translatePostgresError } from './errors.js';

type Executor = Kysely<Database> | Transaction<Database>;
function cursorEncode(value: number): string { return Buffer.from(String(value)).toString('base64url'); }
function cursorDecode(value?: string): number | undefined {
  if (!value) return undefined;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) throw new LibrarianError('VALIDATION', 'Pagination cursor is invalid');
  return Number(decoded);
}
function revisionDto(row: ReferenceRevisionRow): ReferenceRevision { return { id: row.id, referenceId: row.reference_id, revisionNumber: row.revision_number, csl: decodeJsonObject(row.csl_json), createdAt: decodeTimestamp(row.created_at) }; }

export class PostgresBibliographyRepository implements BibliographyRepository {
  constructor(private readonly db: Executor) {}
  async createReference(citationKey: string, csl: Readonly<Record<string, unknown>>): Promise<{ reference: Reference; revision: ReferenceRevision }> {
    try {
      const ref = await this.db.insertInto('references').values({ citation_key: citationKey, head_revision_id: null, head_revision_number: 0 }).returningAll().executeTakeFirstOrThrow();
      const revision = await this.db.insertInto('reference_revisions').values({ reference_id: ref.id, revision_number: 1, csl_json: JSON.stringify(csl) }).returningAll().executeTakeFirstOrThrow();
      const finalizedReference = await this.db.updateTable('references').set({ head_revision_id: revision.id, head_revision_number: 1 }).where('id', '=', ref.id).returningAll().executeTakeFirstOrThrow();
      return { reference: { id: finalizedReference.id, citationKey: finalizedReference.citation_key, createdAt: decodeTimestamp(finalizedReference.created_at) }, revision: revisionDto(revision) };
    } catch (error) { throw translatePostgresError(error); }
  }
  async getReference(id: string): Promise<Reference | undefined> {
    const row = await this.db.selectFrom('references').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? { id: row.id, citationKey: row.citation_key, createdAt: decodeTimestamp(row.created_at) } : undefined;
  }
  async getHead(id: string): Promise<ReferenceHead | undefined> {
    const row = await this.db.selectFrom('references').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? { referenceId: row.id, revisionId: row.head_revision_id, revisionNumber: row.head_revision_number } : undefined;
  }
  async getRevision(id: string): Promise<ReferenceRevision | undefined> {
    const row = await this.db.selectFrom('reference_revisions').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? revisionDto(row) : undefined;
  }
  async listRevisions(id: string, limit: number, cursor?: string): Promise<Page<Omit<ReferenceRevision, 'csl'>>> {
    const before = cursorDecode(cursor); let query = this.db.selectFrom('reference_revisions').select(['id', 'reference_id', 'revision_number', 'created_at']).where('reference_id', '=', id);
    if (before !== undefined) query = query.where('revision_number', '<', before);
    const rows = await query.orderBy('revision_number', 'desc').limit(limit + 1).execute(); const visible = rows.slice(0, limit); const last = visible.at(-1);
    return { items: visible.map((row) => ({ id: row.id, referenceId: row.reference_id, revisionNumber: row.revision_number, createdAt: decodeTimestamp(row.created_at) })), nextCursor: rows.length > limit && last ? cursorEncode(last.revision_number) : null };
  }
  async commitRevision(input: { referenceId: string; expectedHeadId: string; expectedHeadNumber: number; csl: Readonly<Record<string, unknown>> }): Promise<ReferenceRevision> {
    try {
      const head = await this.db.selectFrom('references').selectAll().where('id', '=', input.referenceId).forUpdate().executeTakeFirst();
      if (!head) throw new LibrarianError('NOT_FOUND', 'Reference was not found');
      if (head.head_revision_id !== input.expectedHeadId || head.head_revision_number !== input.expectedHeadNumber) throw new LibrarianError('REFERENCE_CONFLICT', 'Reference editing head changed; reload before committing');
      const revision = await this.db.insertInto('reference_revisions').values({ reference_id: input.referenceId, revision_number: head.head_revision_number + 1, csl_json: JSON.stringify(input.csl) }).returningAll().executeTakeFirstOrThrow();
      const updated = await this.db.updateTable('references').set({ head_revision_id: revision.id, head_revision_number: revision.revision_number }).where('id', '=', input.referenceId).where('head_revision_id', '=', input.expectedHeadId).where('head_revision_number', '=', input.expectedHeadNumber).returning('id').executeTakeFirst();
      if (!updated) throw new LibrarianError('REFERENCE_CONFLICT', 'Reference editing head changed; reload before committing');
      return revisionDto(revision);
    } catch (error) { throw translatePostgresError(error); }
  }
  async findByCitationKeys(keys: readonly string[]): Promise<readonly (ReferenceRevision & { readonly citationKey: string })[]> {
    if (!keys.length) return [];
    const rows = await this.db.selectFrom('references as r').innerJoin('reference_revisions as rr', 'rr.id', 'r.head_revision_id').select(['r.citation_key', 'rr.id', 'rr.reference_id', 'rr.revision_number', 'rr.csl_json', 'rr.created_at']).where('r.citation_key', 'in', [...keys]).execute();
    const rank = new Map(keys.map((key, index) => [key, index]));
    return rows.sort((a, b) => (rank.get(a.citation_key) ?? 0) - (rank.get(b.citation_key) ?? 0)).map((row) => ({ ...revisionDto(row), citationKey: row.citation_key }));
  }
  async importEntries(entries: readonly { readonly citationKey: string; readonly csl: Readonly<Record<string, unknown>> }[]): Promise<readonly { readonly reference: Reference; readonly revision: ReferenceRevision }[]> {
    if (!entries.length) return [];
    try {
      const refs = await this.db.insertInto('references').values(entries.map((entry) => ({ citation_key: entry.citationKey, head_revision_id: null, head_revision_number: 0 }))).returningAll().execute();
      const refByKey = new Map(refs.map((row) => [row.citation_key, row]));
      const revisions = await this.db.insertInto('reference_revisions').values(entries.map((entry) => ({ reference_id: refByKey.get(entry.citationKey)?.id ?? '', revision_number: 1, csl_json: JSON.stringify(entry.csl) }))).returningAll().execute();
      const revisionByReference = new Map(revisions.map((row) => [row.reference_id, row]));
      const result: { reference: Reference; revision: ReferenceRevision }[] = [];
      for (const entry of entries) {
        const reference = refByKey.get(entry.citationKey); if (!reference) throw new Error('Inserted reference mapping was incomplete');
        const revision = revisionByReference.get(reference.id); if (!revision) throw new Error('Inserted revision mapping was incomplete');
        await this.db.updateTable('references').set({ head_revision_id: revision.id, head_revision_number: revision.revision_number }).where('id', '=', reference.id).execute();
        result.push({ reference: { id: reference.id, citationKey: reference.citation_key, createdAt: decodeTimestamp(reference.created_at) }, revision: revisionDto(revision) });
      }
      return result;
    } catch (error) { throw translatePostgresError(error); }
  }
}
