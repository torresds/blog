import { Pool } from 'pg';
import { isIP } from 'node:net';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const reservedDatabases = new Set(['postgres', 'template0', 'template1']);

type ParsedTarget = {
  url: URL;
  host: string;
  port: number;
  database: string;
};

function parsePostgresTarget(value: string | undefined, label: string): ParsedTarget {
  if (!value) throw new Error(`${label} must be configured`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${label} must use the postgres or postgresql URL scheme`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain query parameters or a fragment`);
  }
  if (!url.hostname || url.hostname.endsWith('.')) {
    throw new Error(`${label} must contain an unambiguous host`);
  }

  let database: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(`${label} must contain a valid database name`);
  }
  if (!database || database.includes('/') || database.includes('\\') || database.includes('\0')
      || !/^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/.test(database)) {
    throw new Error(`${label} must contain a valid PostgreSQL database name`);
  }

  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must contain a valid PostgreSQL port`);
  }

  return { url, host: normalizeHost(url.hostname), port, database };
}

function normalizeHost(host: string) {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '[::1]' || normalized === '::1'
    ? '127.0.0.1'
    : normalized;
}

export function parseSafeTestDatabaseUrls(env: NodeJS.ProcessEnv = process.env) {
  if (!env.DATABASE_URL || !env.TEST_DATABASE_URL) {
    throw new Error('DATABASE_URL and TEST_DATABASE_URL must both be set');
  }
  const development = parsePostgresTarget(env.DATABASE_URL, 'DATABASE_URL');
  const test = parsePostgresTarget(env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');

  if (!localHosts.has(test.url.hostname.toLowerCase())) {
    throw new Error('Destructive test database operations require a loopback host');
  }
  if (!test.database.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL database name must end in _test');
  }
  if (reservedDatabases.has(test.database.toLowerCase())) {
    throw new Error('TEST_DATABASE_URL must not target a reserved PostgreSQL database');
  }
  if (development.host === test.host && development.port === test.port
      && development.database === test.database) {
    throw new Error('TEST_DATABASE_URL must identify a database distinct from DATABASE_URL');
  }

  return {
    development: development.url,
    test: test.url,
    testName: test.database,
    target: { host: test.host, port: test.port, database: test.database },
  };
}

export function assertResetServerIdentity(
  identity: { database: string; address: string | null; port: number },
  target: { host: string; port: number; database: string },
) {
  const address = identity.address?.split('/')[0] ?? '';
  if (identity.database !== 'postgres' || identity.port !== target.port || isIP(address) === 0
      || target.host !== '127.0.0.1') {
    throw new Error('Connected PostgreSQL server identity does not match the safe reset target');
  }
}

export function createTestPool() {
  const { test } = parseSafeTestDatabaseUrls();
  return new Pool({ connectionString: test.toString() });
}
