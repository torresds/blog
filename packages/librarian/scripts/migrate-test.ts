import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseSafeTestDatabaseUrls } from '../src/test-database.js';

parseSafeTestDatabaseUrls();

const migrationCli = resolve(
  process.cwd(),
  '../../node_modules/node-pg-migrate/bin/node-pg-migrate.js',
);
const result = spawnSync(
  process.execPath,
  [migrationCli, 'up', '--migrations-dir', 'migrations', '--database-url-var', 'TEST_DATABASE_URL', '--verbose=false'],
  { stdio: 'inherit', env: process.env },
);

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
