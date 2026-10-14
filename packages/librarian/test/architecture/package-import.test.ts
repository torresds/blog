import { expect, it } from 'vitest';

it('package imports without connecting to PostgreSQL or reading environment variables', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  try {
    const library = await import('@torresds/librarian');
    expect(library.SUPPORTED_LOCALES).toEqual(['pt-BR', 'en-US']);
    const postgres = await import('@torresds/librarian/postgres');
    const context = postgres.createPostgresLibrarian({ connectionString: 'postgres://librarian:secret@127.0.0.1:5432/blog_test' });
    expect(context.librarian).toBeDefined();
    await context.close();
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previousTestDatabaseUrl;
  }
});
