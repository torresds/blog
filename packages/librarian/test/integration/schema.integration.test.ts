import assert from 'node:assert/strict';
import { afterAll, describe, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createTestPool } from '../../scripts/test-database.js';

const pool: Pool = createTestPool();

async function clearDatabase() {
  await pool.query(`
    TRUNCATE publication_events, post_publications, artifact_reference_revisions,
      article_artifacts, reference_revisions, "references", post_revision_tags,
      tags, post_revisions, post_locales, posts CASCADE
  `);
}

async function expectSqlState(operation: Promise<unknown>, code: string) {
  try {
    await operation;
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return;
  }
  assert.fail(`expected PostgreSQL error ${code}`);
}

async function createPost() {
  const result = await pool.query<{ id: string }>('INSERT INTO posts DEFAULT VALUES RETURNING id');
  return result.rows[0]!.id;
}

async function createLocale(postId: string, locale = 'pt-BR') {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO post_locales(post_id, locale) VALUES ($1, $2) RETURNING id',
    [postId, locale],
  );
  return result.rows[0]!.id;
}

async function createRevision(localeId: string, revisionNumber = 1, parentId: string | null = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string }>(
    `INSERT INTO post_revisions
       (post_locale_id, revision_number, parent_revision_id, title, slug, markdown)
     VALUES ($1, $2, $3, 'Title', 'title', '# Article')
     RETURNING id`,
    [localeId, revisionNumber, parentId],
    );
    await client.query('UPDATE post_revisions SET finalized = true WHERE id = $1', [result.rows[0]!.id]);
    await client.query('COMMIT');
    return result.rows[0]!.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createArtifact(localeId: string, revisionId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string }>(
    `INSERT INTO article_artifacts
       (post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html)
     VALUES ($1, $2, 'compiler-v1', 'dependencies-v1', '<article/>')
     RETURNING id`,
    [localeId, revisionId],
    );
    await client.query('UPDATE article_artifacts SET finalized = true WHERE id = $1', [result.rows[0]!.id]);
    await client.query('COMMIT');
    return result.rows[0]!.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function fixture() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const post = await client.query<{ id: string }>('INSERT INTO posts DEFAULT VALUES RETURNING id');
    const postId = post.rows[0]!.id;
    const locale = await client.query<{ id: string }>(
      "INSERT INTO post_locales(post_id, locale) VALUES ($1, 'pt-BR') RETURNING id", [postId],
    );
    const localeId = locale.rows[0]!.id;
    const revision = await client.query<{ id: string }>(
      `INSERT INTO post_revisions(post_locale_id, revision_number, title, slug, markdown)
       VALUES ($1, 1, 'Title', 'title', '# Article') RETURNING id`, [localeId],
    );
    const revisionId = revision.rows[0]!.id;
    const tag = await client.query<{ id: string }>(
      "INSERT INTO tags(slug) VALUES ('rust') RETURNING id",
    );
    await client.query('INSERT INTO post_revision_tags(post_revision_id, tag_id) VALUES ($1, $2)', [
      revisionId, tag.rows[0]!.id,
    ]);
    await client.query('UPDATE post_revisions SET finalized = true WHERE id = $1', [revisionId]);
    const reference = await client.query<{ id: string }>(
      "INSERT INTO \"references\"(citation_key) VALUES ('example2026') RETURNING id",
    );
    const referenceRevision = await client.query<{ id: string }>(
      `INSERT INTO reference_revisions(reference_id, revision_number, csl_json)
       VALUES ($1, 1, '{"type":"book"}') RETURNING id`, [reference.rows[0]!.id],
    );
    const artifact = await client.query<{ id: string }>(
      `INSERT INTO article_artifacts
       (post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html)
       VALUES ($1, $2, 'compiler-v1', 'dependencies-v1', '<article/>') RETURNING id`,
      [localeId, revisionId],
    );
    const artifactId = artifact.rows[0]!.id;
    await client.query(
    `INSERT INTO artifact_reference_revisions(artifact_id, reference_id, reference_revision_id)
     VALUES ($1, $2, $3)`,
      [artifactId, reference.rows[0]!.id, referenceRevision.rows[0]!.id],
    );
    await client.query('UPDATE article_artifacts SET finalized = true WHERE id = $1', [artifactId]);
    const event = await client.query<{ id: string }>(
    `INSERT INTO publication_events(post_locale_id, event_type, post_revision_id, artifact_id)
     VALUES ($1, 'publish', $2, $3) RETURNING id`,
      [localeId, revisionId, artifactId],
    );
    await client.query('COMMIT');
    return {
      postId, localeId, revisionId, tagId: tag.rows[0]!.id, referenceId: reference.rows[0]!.id,
      referenceRevisionId: referenceRevision.rows[0]!.id, artifactId, eventId: event.rows[0]!.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function expectMutationRejection(
  client: PoolClient,
  table: string,
  idColumn: string,
  id: string,
  updateSql: string,
) {
  await expectSqlState(client.query(updateSql, [id]), '55000');
  await expectSqlState(client.query(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [id]), '55000');
}

describe('PostgreSQL schema and constraints', () => {
  afterAll(async () => { await pool.end(); });
    it('fresh migrations create the complete schema and migration record', async () => {
      const result = await pool.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      `);
      const names = new Set(result.rows.map((row) => row.table_name));
      for (const name of [
        'posts', 'post_locales', 'post_revisions', 'tags', 'post_revision_tags',
        'references', 'reference_revisions', 'article_artifacts',
        'artifact_reference_revisions', 'post_publications', 'publication_events', 'published_articles', 'pgmigrations',
      ]) {
        assert.ok(names.has(name), `expected table ${name}`);
      }
      const migration = await pool.query<{ name: string }>('SELECT name FROM pgmigrations');
      const applied = new Set(migration.rows.map((row) => row.name));
      for (const name of ['001_initial_schema', '002_strict_text_invariants']) {
        assert.ok(applied.has(name), `expected baseline migration ${name}`);
      }
      for (const name of ['003_editing_head_integrity', '004_finalize_snapshots']) {
        assert.ok(applied.has(name), `expected incremental migration ${name}`);
      }
      for (const name of ['005_reference_editing_head', '006_published_projection', '007_publication_transitions']) {
        assert.ok(applied.has(name), `expected new migration ${name}`);
      }
      const constraints = await pool.query<{ conname: string }>(`
        SELECT conname FROM pg_constraint
        WHERE connamespace = current_schema()::regnamespace
      `);
      const constraintNames = new Set(constraints.rows.map((row) => row.conname));
      for (const name of [
        'post_locales_head_pair_check', 'post_locales_head_revision_exact_fk',
        'post_revisions_locale_number_key', 'post_revisions_locale_number_id_key',
        'artifact_reference_revisions_exact_revision_fk',
        'references_head_revision_exact_fk', 'published_articles_locale_slug_key',
        'publication_events_complete_transition_check',
      ]) {
        assert.ok(constraintNames.has(name), `expected constraint ${name}`);
      }
      const indexes = await pool.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
      `);
      const indexNames = new Set(indexes.rows.map((row) => row.indexname));
      for (const name of [
        'post_revision_tags_tag_id_idx', 'post_revisions_locale_number_id_key',
        'article_artifacts_post_locale_created_at_idx',
        'artifact_reference_revisions_reference_revision_idx',
        'publication_events_post_locale_created_at_idx',
        'published_articles_locale_published_at_idx', 'published_articles_tags_gin_idx',
      ]) {
        assert.ok(indexNames.has(name), `expected index ${name}`);
      }
    });

    it('locale identities, locale constraints, and duplicate rejection', async () => {
      await clearDatabase();
      const postId = await createPost();
      const pt = await createLocale(postId, 'pt-BR');
      const en = await createLocale(postId, 'en-US');
      assert.notEqual(pt, en);
      await expectSqlState(createLocale(postId, 'pt-BR'), '23505');
      await expectSqlState(createLocale(postId, 'fr-FR'), '23514');
    });

    it('initial revision can become a locale editing head', async () => {
      await clearDatabase();
      const postId = await createPost();
      const localeId = await createLocale(postId);
      const revisionId = await createRevision(localeId);
      await pool.query(
        'UPDATE post_locales SET head_revision_id = $1, head_revision_number = 1 WHERE id = $2',
        [revisionId, localeId],
      );
      const result = await pool.query(
        'SELECT head_revision_id, head_revision_number FROM post_locales WHERE id = $1',
        [localeId],
      );
      assert.equal(result.rows[0]!.head_revision_id, revisionId);
      assert.equal(result.rows[0]!.head_revision_number, 1);
      const secondRevision = await createRevision(localeId, 2, revisionId);
      await pool.query(
        'UPDATE post_locales SET head_revision_id = $1, head_revision_number = 2 WHERE id = $2',
        [secondRevision, localeId],
      );
      await pool.query(
        'UPDATE post_locales SET head_revision_id = $1, head_revision_number = 1 WHERE id = $2',
        [revisionId, localeId],
      );
      await expectSqlState(
        pool.query('UPDATE post_locales SET head_revision_id = NULL, head_revision_number = 1 WHERE id = $1', [localeId]),
        '23514',
      );
    });

    it('head and parent revisions cannot cross locales or skip sequence', async () => {
      await clearDatabase();
      const postId = await createPost();
      const firstLocale = await createLocale(postId, 'pt-BR');
      const secondLocale = await createLocale(postId, 'en-US');
      const firstRevision = await createRevision(firstLocale);
      const secondRevision = await createRevision(secondLocale);
      const secondLocaleRevisionTwo = await createRevision(secondLocale, 2, secondRevision);
      await expectSqlState(
        pool.query(
          'UPDATE post_locales SET head_revision_id = $1, head_revision_number = 1 WHERE id = $2',
          [secondRevision, firstLocale],
        ),
        '23503',
      );
      await expectSqlState(
        pool.query(
          'UPDATE post_locales SET head_revision_id = $1, head_revision_number = 2 WHERE id = $2',
          [firstRevision, firstLocale],
        ),
        '23503',
      );
      await expectSqlState(createRevision(firstLocale, 1), '23505');
      const parentlessLocale = await createLocale(await createPost());
      await expectSqlState(
        createRevision(parentlessLocale, 1, '00000000-0000-0000-0000-000000000004'),
        '23514',
      );
      await createRevision(firstLocale, 2, firstRevision);
      await expectSqlState(createRevision(firstLocale, 3, firstRevision), '23514');
      await expectSqlState(createRevision(firstLocale, 3, secondLocaleRevisionTwo), '23514');
    });

    it('revision and artifact associations finalize atomically', async () => {
      await clearDatabase();
      const client = await pool.connect();
      let postId = '';
      let revisionId = '';
      let artifactId = '';
      let firstTagId = '';
      let secondTagId = '';
      let referenceId = '';
      let referenceRevisionId = '';
      try {
        await client.query('BEGIN');
        postId = (await client.query<{ id: string }>('INSERT INTO posts DEFAULT VALUES RETURNING id')).rows[0]!.id;
        const localeId = (await client.query<{ id: string }>(
          "INSERT INTO post_locales(post_id, locale) VALUES ($1, 'pt-BR') RETURNING id", [postId],
        )).rows[0]!.id;
        revisionId = (await client.query<{ id: string }>(
          `INSERT INTO post_revisions(post_locale_id, revision_number, title, slug, markdown)
           VALUES ($1, 1, 'Snapshot', 'snapshot', '') RETURNING id`, [localeId],
        )).rows[0]!.id;
        firstTagId = (await client.query<{ id: string }>(
          "INSERT INTO tags(slug) VALUES ('first-tag') RETURNING id",
        )).rows[0]!.id;
        secondTagId = (await client.query<{ id: string }>(
          "INSERT INTO tags(slug) VALUES ('second-tag') RETURNING id",
        )).rows[0]!.id;
        await client.query('INSERT INTO post_revision_tags(post_revision_id, tag_id) VALUES ($1, $2), ($1, $3)', [
          revisionId, firstTagId, secondTagId,
        ]);
        await client.query('UPDATE post_revisions SET finalized = true WHERE id = $1', [revisionId]);
        await client.query(
          'UPDATE post_locales SET head_revision_id = $1, head_revision_number = 1 WHERE id = $2',
          [revisionId, localeId],
        );

        referenceId = (await client.query<{ id: string }>(
          `INSERT INTO "references"(citation_key) VALUES ('snapshotRef') RETURNING id`,
        )).rows[0]!.id;
        referenceRevisionId = (await client.query<{ id: string }>(
          `INSERT INTO reference_revisions(reference_id, revision_number, csl_json)
           VALUES ($1, 1, '{"type":"book"}') RETURNING id`, [referenceId],
        )).rows[0]!.id;
        const secondReferenceId = (await client.query<{ id: string }>(
          `INSERT INTO "references"(citation_key) VALUES ('snapshotRefTwo') RETURNING id`,
        )).rows[0]!.id;
        const secondReferenceRevisionId = (await client.query<{ id: string }>(
          `INSERT INTO reference_revisions(reference_id, revision_number, csl_json)
           VALUES ($1, 1, '{"type":"article-journal"}') RETURNING id`, [secondReferenceId],
        )).rows[0]!.id;
        artifactId = (await client.query<{ id: string }>(
          `INSERT INTO article_artifacts
           (post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html)
           VALUES ($1, $2, 'compiler-v1', 'deps-v1', '<article/>') RETURNING id`, [localeId, revisionId],
        )).rows[0]!.id;
        await client.query(
          `INSERT INTO artifact_reference_revisions(artifact_id, reference_id, reference_revision_id)
           VALUES ($1, $2, $3), ($1, $4, $5)`,
          [artifactId, referenceId, referenceRevisionId, secondReferenceId, secondReferenceRevisionId],
        );
        await client.query('UPDATE article_artifacts SET finalized = true WHERE id = $1', [artifactId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const associations = await pool.query(
        'SELECT count(*)::integer AS count FROM post_revision_tags WHERE post_revision_id = $1', [revisionId],
      );
      assert.equal(associations.rows[0]!.count, 2);
      const dependencyCount = await pool.query(
        'SELECT count(*)::integer AS count FROM artifact_reference_revisions WHERE artifact_id = $1', [artifactId],
      );
      assert.equal(dependencyCount.rows[0]!.count, 2);
      await expectSqlState(
        pool.query('INSERT INTO post_revision_tags(post_revision_id, tag_id) VALUES ($1, $2)', [revisionId, firstTagId]),
        '55000',
      );
      await expectSqlState(
        pool.query(
          `INSERT INTO artifact_reference_revisions(artifact_id, reference_id, reference_revision_id)
           VALUES ($1, $2, $3)`, [artifactId, referenceId, referenceRevisionId],
        ),
        '55000',
      );

      const rollbackClient = await pool.connect();
      try {
        await rollbackClient.query('BEGIN');
        const rolledBackPost = (await rollbackClient.query<{ id: string }>(
          'INSERT INTO posts DEFAULT VALUES RETURNING id',
        )).rows[0]!.id;
        const rolledBackLocale = (await rollbackClient.query<{ id: string }>(
          "INSERT INTO post_locales(post_id, locale) VALUES ($1, 'en-US') RETURNING id", [rolledBackPost],
        )).rows[0]!.id;
        await rollbackClient.query(
          `INSERT INTO post_revisions(post_locale_id, revision_number, title, slug, markdown)
           VALUES ($1, 1, 'Rolled back', 'rolled-back', '')`, [rolledBackLocale],
        );
        await rollbackClient.query('ROLLBACK');
        const count = await rollbackClient.query('SELECT count(*)::integer AS count FROM posts WHERE id = $1', [rolledBackPost]);
        assert.equal(count.rows[0]!.count, 0);
      } finally {
        rollbackClient.release();
      }
      assert.ok(postId);
    });

    it('revision content and JSON constraints are enforced', async () => {
      await clearDatabase();
      const localeId = await createLocale(await createPost());
      await expectSqlState(
        pool.query(`INSERT INTO post_revisions(post_locale_id, revision_number, title, slug, markdown)
          VALUES ($1, 1, '  ', 'slug', '')`, [localeId]),
        '23514',
      );
      await expectSqlState(
        pool.query(`INSERT INTO post_revisions(post_locale_id, revision_number, title, slug, markdown, seo)
          VALUES ($1, 1, 'Title', 'title', '', '[]')`, [localeId]),
        '23514',
      );
      await expectSqlState(
        pool.query(`INSERT INTO post_revisions(post_locale_id, revision_number, title, slug, markdown)
          VALUES ($1, 1, E'\\t  ', 'title', '')`, [localeId]),
        '23514',
      );
    });

    it('immutable records reject updates and deletes while inserts work', async () => {
      await clearDatabase();
      const rows = await fixture();
      const client = await pool.connect();
      try {
        await expectMutationRejection(
          client, 'post_revisions', 'id', rows.revisionId,
          'UPDATE post_revisions SET title = \'Changed\' WHERE id = $1',
        );
        await expectMutationRejection(
          client, 'post_revision_tags', 'post_revision_id', rows.revisionId,
          'UPDATE post_revision_tags SET tag_id = tag_id WHERE post_revision_id = $1',
        );
        await expectMutationRejection(
          client, 'reference_revisions', 'id', rows.referenceRevisionId,
          'UPDATE reference_revisions SET csl_json = csl_json WHERE id = $1',
        );
        await expectMutationRejection(
          client, 'article_artifacts', 'id', rows.artifactId,
          'UPDATE article_artifacts SET html = html WHERE id = $1',
        );
        await expectMutationRejection(
          client, 'artifact_reference_revisions', 'artifact_id', rows.artifactId,
          'UPDATE artifact_reference_revisions SET reference_id = reference_id WHERE artifact_id = $1',
        );
        await expectMutationRejection(
          client, 'publication_events', 'id', rows.eventId,
          'UPDATE publication_events SET event_type = event_type WHERE id = $1',
        );
      } finally {
        client.release();
      }
    });

    it('tag slugs, citation keys, and bibliography relationships are constrained', async () => {
      await clearDatabase();
      const rows = await fixture();
      await expectSqlState(pool.query("INSERT INTO tags(slug) VALUES ('rust')"), '23505');
      await expectSqlState(pool.query("INSERT INTO tags(slug) VALUES ('Rust Lang')"), '23514');
      await expectSqlState(pool.query("INSERT INTO tags(slug) VALUES ('mañana')"), '23514');
      await expectSqlState(
        pool.query('UPDATE tags SET slug = $1 WHERE id = $2', ['rust-lang', rows.tagId]),
        '55000',
      );
      await expectSqlState(
        pool.query('INSERT INTO "references"(citation_key) VALUES ($1)', ['example2026']),
        '23505',
      );
      await expectSqlState(
        pool.query(`INSERT INTO artifact_reference_revisions(artifact_id, reference_id, reference_revision_id)
          VALUES ($1, $2, $3)`, [rows.artifactId, rows.referenceId, rows.referenceRevisionId]),
        '55000',
      );
      const otherReference = await pool.query<{ id: string }>(
        `INSERT INTO "references"(citation_key) VALUES ('otherRef') RETURNING id`,
      );
      const otherReferenceRevision = await pool.query<{ id: string }>(
        `INSERT INTO reference_revisions(reference_id, revision_number, csl_json)
         VALUES ($1, 1, '{"type":"book"}') RETURNING id`, [otherReference.rows[0]!.id],
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const pendingArtifact = await client.query<{ id: string }>(
          `INSERT INTO article_artifacts
           (post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html)
           VALUES ($1, $2, 'compiler-v1', 'dependencies-v1', '<article/>') RETURNING id`,
          [rows.localeId, rows.revisionId],
        );
        await expectSqlState(
          client.query(`INSERT INTO artifact_reference_revisions(artifact_id, reference_id, reference_revision_id)
            VALUES ($1, $2, $3)`, [pendingArtifact.rows[0]!.id, rows.referenceId, otherReferenceRevision.rows[0]!.id]),
          '23503',
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('artifact and publication pointers must match locale and revision', async () => {
      await clearDatabase();
      const postId = await createPost();
      const localeOne = await createLocale(postId, 'pt-BR');
      const localeTwo = await createLocale(postId, 'en-US');
      const revisionOne = await createRevision(localeOne);
      const revisionTwo = await createRevision(localeTwo);
      const artifactOne = await createArtifact(localeOne, revisionOne);
      await expectSqlState(
        pool.query(`INSERT INTO article_artifacts
          (post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html)
          VALUES ($1, $2, 'compiler', 'dependencies', '<article/>')`, [localeOne, revisionTwo]),
        '23503',
      );
      await expectSqlState(
        pool.query(`INSERT INTO article_artifacts
          (post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html, toc)
          VALUES ($1, $2, 'compiler', 'dependencies', '<article/>', '{}')`, [localeOne, revisionOne]),
        '23514',
      );
      await expectSqlState(
        pool.query(`INSERT INTO article_artifacts
          (post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html)
          VALUES ($1, $2, E'\\t ', 'dependencies', '<article/>')`, [localeOne, revisionOne]),
        '23514',
      );
      await expectSqlState(
        pool.query(`INSERT INTO post_publications(post_locale_id, post_revision_id, artifact_id)
          VALUES ($1, $2, $3)`, [localeOne, revisionOne, '00000000-0000-0000-0000-000000000002']),
        '23503',
      );
      await expectSqlState(
        pool.query(`INSERT INTO post_publications(post_locale_id, post_revision_id, artifact_id)
          VALUES ($1, $2, $3)`, [localeOne, revisionOne, null]),
        '23514',
      );
      await expectSqlState(
        pool.query(`INSERT INTO post_publications(post_locale_id, post_revision_id, artifact_id, version)
          VALUES ($1, $2, $3, -1)`, [localeOne, revisionOne, artifactOne]),
        '23514',
      );
      await pool.query(
        `INSERT INTO post_publications(post_locale_id, post_revision_id, artifact_id)
         VALUES ($1, $2, $3)`,
        [localeOne, revisionOne, artifactOne],
      );
      await expectSqlState(
        pool.query(`UPDATE post_publications SET post_revision_id = $1 WHERE post_locale_id = $2`, [
          revisionTwo, localeOne,
        ]),
        '23503',
      );
    });

    it('publication events validate event type and referenced records', async () => {
      await clearDatabase();
      const postId = await createPost();
      const localeId = await createLocale(postId);
      const revisionId = await createRevision(localeId);
      await expectSqlState(
        pool.query('INSERT INTO publication_events(post_locale_id, event_type) VALUES ($1, $2)', [
          localeId, 'publish-ish',
        ]),
        '23514',
      );
      await expectSqlState(
        pool.query(`INSERT INTO publication_events(post_locale_id, event_type, post_revision_id)
          VALUES ($1, 'publish', $2)`, [localeId, revisionId]),
        '23514',
      );
      await expectSqlState(
        pool.query(`INSERT INTO publication_events(post_locale_id, event_type, post_revision_id, artifact_id)
          VALUES ($1, 'publish', $2, $3)`, [localeId, revisionId, '00000000-0000-0000-0000-000000000003']),
        '23503',
      );
    });

    it('concurrent duplicate locale creation has one winner', async () => {
      await clearDatabase();
      const postId = await createPost();
      const outcomes = await Promise.allSettled([
        pool.query('INSERT INTO post_locales(post_id, locale) VALUES ($1, $2)', [postId, 'pt-BR']),
        pool.query('INSERT INTO post_locales(post_id, locale) VALUES ($1, $2)', [postId, 'pt-BR']),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      assert.equal((rejected as PromiseRejectedResult).reason.code, '23505');
      const count = await pool.query(
        'SELECT count(*)::integer AS count FROM post_locales WHERE post_id = $1 AND locale = $2',
        [postId, 'pt-BR'],
      );
      assert.equal(count.rows[0]!.count, 1);
    });
});
