import { Pool } from 'pg';
import { assertResetServerIdentity, parseSafeTestDatabaseUrls } from '../src/test-database.js';

const { test, testName, target } = parseSafeTestDatabaseUrls();
const admin = new URL(test);
admin.pathname = '/postgres';
const pool = new Pool({ connectionString: admin.toString(), max: 1 });
const quotedDatabaseName = `"${testName.replaceAll('"', '""')}"`;

async function resetTestDatabase() {
  try {
    const identity = await pool.query<{
      database: string;
      address: string | null;
      port: number;
    }>(`SELECT current_database() AS database,
               inet_server_addr()::text AS address,
               inet_server_port() AS port`);
    assertResetServerIdentity(identity.rows[0]!, target);
    await pool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testName],
    );
    await pool.query(`DROP DATABASE IF EXISTS ${quotedDatabaseName}`);
    await pool.query(`CREATE DATABASE ${quotedDatabaseName}`);
    console.log(`Recreated isolated test database ${testName}`);
  } finally {
    await pool.end();
  }
}

resetTestDatabase().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Test database reset failed');
  process.exitCode = 1;
});
