import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, describe, it, expect } from 'vitest';
import { createTestPool } from '../../scripts/test-database.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
const pool = createTestPool();
const packageDirectory = resolve(import.meta.dirname, '../..');
const migrationCli = resolve(packageDirectory, '../../node_modules/node-pg-migrate/bin/node-pg-migrate.js');
function migrate(direction: 'up' | 'down', target?: string): void {
  const args = [migrationCli, direction, ...(target ? [target] : []), '--migrations-dir', 'migrations', '--database-url-var', 'TEST_DATABASE_URL', '--verbose=false'];
  execFileSync(process.execPath, args, { cwd: packageDirectory, env: { ...process.env, TEST_DATABASE_URL: connectionString }, stdio: 'pipe' });
}
async function seedExistingPublication(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    const post = await client.query<{ id: string }>('INSERT INTO posts DEFAULT VALUES RETURNING id');
    const locale = await client.query<{ id: string }>("INSERT INTO post_locales(post_id, locale) VALUES ($1, 'en-US') RETURNING id", [post.rows[0]!.id]);
    const revision = await client.query<{ id: string }>(`INSERT INTO post_revisions(post_locale_id, revision_number, title, slug, markdown, excerpt, seo)
      VALUES ($1, 1, 'Upgrade article', 'upgrade-article', '# Upgrade', 'Excerpt', '{"description":"legacy"}') RETURNING id`, [locale.rows[0]!.id]);
    await client.query('UPDATE post_revisions SET finalized = true WHERE id = $1', [revision.rows[0]!.id]);
    await client.query('UPDATE post_locales SET head_revision_id = $1, head_revision_number = 1 WHERE id = $2', [revision.rows[0]!.id, locale.rows[0]!.id]);
    const reference = await client.query<{ id: string }>(`INSERT INTO "references"(citation_key) VALUES ('upgrade-reference') RETURNING id`);
    await client.query(`INSERT INTO reference_revisions(reference_id, revision_number, csl_json)
      VALUES ($1, 1, '{"id":"upgrade-reference","type":"book","title":"Legacy"}')`, [reference.rows[0]!.id]);
    const artifact = await client.query<{ id: string }>(`INSERT INTO article_artifacts(post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html)
      VALUES ($1, $2, 'compiler-v1', 'dependencies-v1', '<article>legacy</article>') RETURNING id`, [locale.rows[0]!.id, revision.rows[0]!.id]);
    await client.query('UPDATE article_artifacts SET finalized = true WHERE id = $1', [artifact.rows[0]!.id]);
    await client.query(`INSERT INTO post_publications(post_locale_id, post_revision_id, artifact_id, version, published_at)
      VALUES ($1, $2, $3, 1, now())`, [locale.rows[0]!.id, revision.rows[0]!.id, artifact.rows[0]!.id]);
    await client.query(`INSERT INTO publication_events(post_locale_id, event_type, post_revision_id, artifact_id)
      VALUES ($1, 'publish', $2, $3)`, [locale.rows[0]!.id, revision.rows[0]!.id, artifact.rows[0]!.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

describe('forward migration upgrade from the 004 schema', () => {
  afterAll(async () => { await pool.end(); });

  it('backfills exact reference heads and existing active publication projections', async () => {
    migrate('down', '3');
    const client = await pool.connect();
    try { await seedExistingPublication(client); } finally { client.release(); }
    migrate('up');
    const clientAfter = await pool.connect();
    try {
      const ref = await clientAfter.query<{ head_revision_number: number; head_revision_id: string }>(`SELECT head_revision_number, head_revision_id FROM "references" WHERE citation_key = 'upgrade-reference'`);
      expect(ref.rows).toHaveLength(1);
      expect(ref.rows[0]?.head_revision_number).toBe(1);
      expect(ref.rows[0]?.head_revision_id).toBeTruthy();
      const projection = await clientAfter.query<{ slug: string; excerpt: string; title: string }>(`SELECT slug, excerpt, title FROM published_articles`);
      expect(projection.rows).toEqual([{ slug: 'upgrade-article', excerpt: 'Excerpt', title: 'Upgrade article' }]);
      const legacy = await clientAfter.query<{ previous_version: string | null; new_version: string | null }>('SELECT previous_version, new_version FROM publication_events');
      expect(legacy.rows).toEqual([{ previous_version: null, new_version: null }]);
    } finally { clientAfter.release(); }
    migrate('up');
  });
});
