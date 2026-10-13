import assert from 'node:assert/strict';
import test from 'node:test';

test('built package imports by workspace package name without database configuration', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  try {
    const library = await import('@torresds/librarian');
    assert.deepEqual(library.SUPPORTED_LOCALES, ['pt-BR', 'en-US']);
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previousTestDatabaseUrl;
  }
});
