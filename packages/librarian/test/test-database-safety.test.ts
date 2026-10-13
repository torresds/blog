import assert from 'node:assert/strict';
import test from 'node:test';
import { assertResetServerIdentity, parseSafeTestDatabaseUrls } from '../src/test-database.js';

const safeEnvironment = {
  DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/blog_dev',
  TEST_DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/blog_test',
};

test('test database configuration is isolated and local before destructive use', () => {
  assert.equal(parseSafeTestDatabaseUrls(safeEnvironment).testName, 'blog_test');
  assert.equal(parseSafeTestDatabaseUrls({
    ...safeEnvironment,
    DATABASE_URL: 'postgresql://local:secret@localhost/blog_dev',
    TEST_DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/blog%5Ftest',
  }).testName, 'blog_test');
  assert.equal(parseSafeTestDatabaseUrls({
    ...safeEnvironment,
    DATABASE_URL: 'postgres://local:secret@127.0.0.1:5433/blog_dev',
  }).testName, 'blog_test');
  assert.throws(() => parseSafeTestDatabaseUrls({ DATABASE_URL: safeEnvironment.DATABASE_URL }), /both be set/);
  assert.throws(() => parseSafeTestDatabaseUrls({
    ...safeEnvironment,
    TEST_DATABASE_URL: 'mysql://local:secret@127.0.0.1:5432/blog_test',
  }), /postgres or postgresql URL scheme/);
  assert.throws(() => parseSafeTestDatabaseUrls({
    ...safeEnvironment,
    TEST_DATABASE_URL: 'not a url',
  }), /valid PostgreSQL URL/);
  assert.throws(() => parseSafeTestDatabaseUrls({
    ...safeEnvironment,
    TEST_DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432',
  }), /valid PostgreSQL database name/);
  assert.throws(() => parseSafeTestDatabaseUrls({
    ...safeEnvironment,
    TEST_DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/blog%2Ftest',
  }), /valid PostgreSQL database name/);
  assert.throws(() => parseSafeTestDatabaseUrls({
    ...safeEnvironment,
    TEST_DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/blog_test?host=remote.example',
  }), /query parameters/);
  assert.throws(() => parseSafeTestDatabaseUrls({
    ...safeEnvironment,
    TEST_DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/postgres',
  }), /end in _test/);
  assert.throws(
    () => parseSafeTestDatabaseUrls({
      ...safeEnvironment,
      TEST_DATABASE_URL: 'postgres://local:secret@db.example:5432/blog_test',
    }),
    /loopback host/,
  );
  assert.throws(
    () => parseSafeTestDatabaseUrls({
      ...safeEnvironment,
      DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/blog_test',
      TEST_DATABASE_URL: 'postgres://local:secret@localhost:5432/blog_dev',
    }),
    /end in _test/,
  );
  assert.throws(
    () => parseSafeTestDatabaseUrls({
      ...safeEnvironment,
      DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/blog_test',
      TEST_DATABASE_URL: 'postgres://local:secret@localhost:5432/blog_test',
    }),
    /distinct from DATABASE_URL/,
  );
  assert.throws(
    () => parseSafeTestDatabaseUrls({
      ...safeEnvironment,
      DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/blog_test',
      TEST_DATABASE_URL: 'postgres://local:secret@localhost:5432/blog_test',
    }),
    /distinct from DATABASE_URL/,
  );
  assert.throws(
    () => parseSafeTestDatabaseUrls({
      ...safeEnvironment,
      TEST_DATABASE_URL: 'postgres://local:secret@localhost:5432/blog-testing',
    }),
    /end in _test/,
  );
});

test('reset server identity must match the safe local administrative connection', () => {
  const target = { host: '127.0.0.1', port: 5432, database: 'blog_test' };
  assert.doesNotThrow(() => assertResetServerIdentity(
    { database: 'postgres', address: '127.0.0.1', port: 5432 }, target,
  ));
  assert.throws(() => assertResetServerIdentity(
    { database: 'blog_dev', address: '127.0.0.1', port: 5432 }, target,
  ), /server identity/);
  // Docker PostgreSQL reports its container bridge address for a loopback-published URL.
  assert.doesNotThrow(() => assertResetServerIdentity(
    { database: 'postgres', address: '172.18.0.2/32', port: 5432 }, target,
  ));
  assert.throws(() => assertResetServerIdentity(
    { database: 'postgres', address: '127.0.0.1', port: 5433 }, target,
  ), /server identity/);
  assert.throws(() => assertResetServerIdentity(
    { database: 'postgres', address: null, port: 5432 }, target,
  ), /server identity/);
});
