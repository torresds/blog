import { createLibrarian } from './application/create-librarian.js';
import { citationJsBibTeXParser } from './integrations/citation-js/adapter.js';
import { createPostgresDatabase, type PostgresConnectionOptions } from './infrastructure/postgres/connection.js';
import { PostgresDiscoveryRepository } from './infrastructure/postgres/discovery.repository.js';
import { createPostgresTransactionManager } from './infrastructure/postgres/transaction.js';

export interface PostgresLibrarianOptions extends PostgresConnectionOptions {}
export interface PostgresLibrarianContext { readonly librarian: ReturnType<typeof createLibrarian>; close(): Promise<void> }
export function createPostgresLibrarian(options: PostgresLibrarianOptions): PostgresLibrarianContext {
  const { db, close } = createPostgresDatabase(options);
  return { librarian: createLibrarian({ transactions: createPostgresTransactionManager(db), discovery: new PostgresDiscoveryRepository(db), bibtex: citationJsBibTeXParser }), close };
}
