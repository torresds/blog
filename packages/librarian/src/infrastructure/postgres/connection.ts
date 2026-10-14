import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './schema.js';
export interface PostgresConnectionOptions { readonly connectionString: string; readonly maxConnections?: number; readonly idleTimeoutMillis?: number }
export function createPostgresDatabase(options: PostgresConnectionOptions): { readonly db: Kysely<Database>; readonly close: () => Promise<void> } {
  const pool = new Pool({ connectionString: options.connectionString, max: options.maxConnections ?? 10, idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000 });
  return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), close: async () => { await pool.end(); } };
}
