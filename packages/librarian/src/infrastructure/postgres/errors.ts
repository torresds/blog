import { LibrarianError } from '../../domain/errors.js';
interface PgErrorLike { readonly code?: string; readonly constraint?: string }
export function translatePostgresError(error: unknown): Error {
  if (error instanceof LibrarianError) return error;
  if (typeof error !== 'object' || error === null) return error instanceof Error ? error : new Error('Database operation failed', { cause: error });
  const pg = error as PgErrorLike;
  const constraint = pg.constraint ?? '';
  if (pg.code === '23505') {
    const code = constraint.includes('published_articles') ? 'PUBLISHED_SLUG_CONFLICT' : constraint.includes('locale') ? 'DUPLICATE_LOCALE' : constraint.includes('tag') ? 'DUPLICATE_TAG' : constraint.includes('citation') || constraint.includes('references_citation') ? 'DUPLICATE_CITATION_KEY' : 'CONFLICT';
    return new LibrarianError(code, code === 'PUBLISHED_SLUG_CONFLICT' ? 'A published article already uses this locale and slug' : 'A record with the same identity already exists', { cause: error });
  }
  if (pg.code === '40001' || pg.code === '40P01') return new LibrarianError('CONFLICT', 'Concurrent database update conflicted; retry the operation', { cause: error });
  if (pg.code === '23503' || pg.code === '23514') return new LibrarianError('INVALID_REVISION', 'The requested record violates a domain relationship', { cause: error });
  return error instanceof Error ? error : new Error('Database operation failed', { cause: error });
}
