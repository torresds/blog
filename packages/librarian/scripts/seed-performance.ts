import { Pool } from 'pg';
import { createTestPool, parseSafeTestDatabaseUrls, assertResetServerIdentity } from './test-database.js';

const target = parseSafeTestDatabaseUrls();
const pool = createTestPool();
try {
  const adminUrl = new URL(target.test);
  adminUrl.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: adminUrl.toString() });
  try {
    const admin = await adminPool.query<{ database: string; address: string | null; port: number }>(`SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port`);
    if (admin.rows[0]) assertResetServerIdentity(admin.rows[0], target.target);
  } finally { await adminPool.end(); }
  const identity = await pool.query<{ database: string; address: string | null; port: number }>(`SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port`);
  const server = identity.rows[0];
  if (!server || server.database !== target.target.database) throw new Error('Performance seed database identity does not match the isolated test URL');
  await pool.query(`TRUNCATE published_articles, publication_events, post_publications, artifact_reference_revisions,
    article_artifacts, reference_revisions, "references", post_revision_tags, tags, post_revisions, post_locales, posts CASCADE`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE FUNCTION pg_temp.librarian_perf_uuid(value text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
        SELECT overlay(overlay(md5(value) placing '4' from 13) placing '8' from 17)::uuid
      $$;
      INSERT INTO posts(id)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-post:' || i)::uuid FROM generate_series(1, 1000) AS i;
      INSERT INTO post_locales(id, post_id, locale)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-locale:' || i || ':' || language)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-post:' || i)::uuid, language
      FROM generate_series(1, 1000) AS i CROSS JOIN (VALUES ('pt-BR'), ('en-US')) AS locales(language);
      INSERT INTO tags(id, slug)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-tag:' || i)::uuid, 'tag-' || i FROM generate_series(1, 200) AS i;
      INSERT INTO post_revisions(id, post_locale_id, revision_number, parent_revision_id, title, slug, markdown, excerpt, seo, presentation)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-revision:' || i || ':' || language || ':' || revision)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-locale:' || i || ':' || language)::uuid, revision,
             CASE WHEN revision = 1 THEN NULL ELSE pg_temp.librarian_perf_uuid('librarian-perf-revision:' || i || ':' || language || ':' || (revision - 1))::uuid END,
             'Performance article ' || i || ' ' || language || ' r' || revision,
             'article-' || i || '-' || lower(replace(language, '-', '')),
             repeat('# Representative article content. A citation [@reference-' || ((i % 1000) + 1) || ']. ', 40),
             'Representative metadata excerpt ' || i,
             jsonb_build_object('description', 'SEO summary ' || i), '{}'::jsonb
      FROM generate_series(1, 1000) AS i CROSS JOIN (VALUES ('pt-BR'), ('en-US')) AS locales(language) CROSS JOIN generate_series(1, 10) AS revisions(revision);
      INSERT INTO post_revision_tags(post_revision_id, tag_id)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-revision:' || i || ':' || language || ':' || revision)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-tag:' || (((i + tag_offset - 2) % 200) + 1))::uuid
      FROM generate_series(1, 1000) AS i CROSS JOIN (VALUES ('pt-BR'), ('en-US')) AS locales(language)
      CROSS JOIN generate_series(1, 10) AS revisions(revision) CROSS JOIN generate_series(1, 20) AS tags(tag_offset);
      UPDATE post_revisions SET finalized = true;
      UPDATE post_locales locale SET head_revision_number = 10,
        head_revision_id = pg_temp.librarian_perf_uuid('librarian-perf-revision:' || post_index.i || ':' || locale.locale || ':10')::uuid
      FROM generate_series(1, 1000) AS post_index(i)
      WHERE locale.post_id = pg_temp.librarian_perf_uuid('librarian-perf-post:' || post_index.i)::uuid;

      INSERT INTO "references"(id, citation_key)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-reference:' || i)::uuid, 'reference-' || i FROM generate_series(1, 1000) AS i;
      INSERT INTO reference_revisions(id, reference_id, revision_number, csl_json)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-reference-revision:' || i || ':' || revision)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-reference:' || i)::uuid, revision,
             jsonb_build_object('id', 'reference-' || i, 'type', 'article-journal', 'title', 'Reference ' || i || ' version ' || revision)
      FROM generate_series(1, 1000) AS i CROSS JOIN generate_series(1, 3) AS revisions(revision);
      UPDATE "references" reference SET head_revision_number = 3,
        head_revision_id = pg_temp.librarian_perf_uuid('librarian-perf-reference-revision:' || reference_index.i || ':3')::uuid
      FROM generate_series(1, 1000) AS reference_index(i)
      WHERE reference.id = pg_temp.librarian_perf_uuid('librarian-perf-reference:' || reference_index.i)::uuid;

      INSERT INTO article_artifacts(id, post_locale_id, post_revision_id, compiler_fingerprint, dependency_fingerprint, html, toc, asset_manifest)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-artifact:' || i || ':' || language || ':' || artifact_no)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-locale:' || i || ':' || language)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-revision:' || i || ':' || language || ':10')::uuid,
             repeat('a', 64), repeat('b', 64), '<article>' || repeat('Representative compiled HTML content. ', 180) || '</article>',
             '[]'::jsonb, '[{"path":"article.html","media_type":"text/html","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]'::jsonb
      FROM generate_series(1, 1000) AS i CROSS JOIN (VALUES ('pt-BR'), ('en-US')) AS locales(language)
      CROSS JOIN LATERAL (SELECT 0 AS artifact_no WHERE i <= 700 UNION ALL SELECT n FROM generate_series(1, 2) AS extras(n) WHERE i BETWEEN 701 AND 800) artifacts;
      INSERT INTO artifact_reference_revisions(artifact_id, reference_id, reference_revision_id)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-artifact:' || i || ':' || language || ':' || artifact_no)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-reference:' || reference_no)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-reference-revision:' || reference_no || ':3')::uuid
      FROM generate_series(1, 1000) AS i CROSS JOIN (VALUES ('pt-BR'), ('en-US')) AS locales(language)
      CROSS JOIN LATERAL (SELECT 0 AS artifact_no WHERE i <= 700 UNION ALL SELECT n FROM generate_series(1, 2) AS extras(n) WHERE i BETWEEN 701 AND 800) artifacts
      CROSS JOIN LATERAL (VALUES ((i % 1000) + 1), (((i + 99) % 1000) + 1)) AS dependencies(reference_no);
      UPDATE article_artifacts SET finalized = true;

      INSERT INTO post_publications(post_locale_id, post_revision_id, artifact_id, version, published_at, updated_at)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-locale:' || i || ':' || language)::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-revision:' || i || ':' || language || ':10')::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-artifact:' || i || ':' || language || ':0')::uuid,
             1, now() - i * interval '1 minute', now()
      FROM generate_series(1, 700) AS i CROSS JOIN (VALUES ('pt-BR'), ('en-US')) AS locales(language);
      INSERT INTO published_articles(post_locale_id, locale, slug, revision_id, artifact_id, title, excerpt, seo, tags, published_at, route_metadata)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-locale:' || i || ':' || language)::uuid, language,
             'article-' || i || '-' || lower(replace(language, '-', '')),
             pg_temp.librarian_perf_uuid('librarian-perf-revision:' || i || ':' || language || ':10')::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-artifact:' || i || ':' || language || ':0')::uuid,
             'Performance article ' || i || ' ' || language || ' r10', 'Representative metadata excerpt ' || i,
             jsonb_build_object('description', 'SEO summary ' || i),
             ARRAY(SELECT 'tag-' || (((i + tag_offset - 2) % 200) + 1) FROM generate_series(1, 20) AS offsets(tag_offset)),
             now() - i * interval '1 minute', jsonb_build_object('postId', pg_temp.librarian_perf_uuid('librarian-perf-post:' || i)::uuid)
      FROM generate_series(1, 700) AS i CROSS JOIN (VALUES ('pt-BR'), ('en-US')) AS locales(language);
      INSERT INTO publication_events(post_locale_id, event_type, post_revision_id, artifact_id, previous_version, new_version)
      SELECT pg_temp.librarian_perf_uuid('librarian-perf-locale:' || i || ':' || language)::uuid, 'publish',
             pg_temp.librarian_perf_uuid('librarian-perf-revision:' || i || ':' || language || ':10')::uuid,
             pg_temp.librarian_perf_uuid('librarian-perf-artifact:' || i || ':' || language || ':0')::uuid, 0, 1
      FROM generate_series(1, 700) AS i CROSS JOIN (VALUES ('pt-BR'), ('en-US')) AS locales(language);
    `);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  await pool.query('ANALYZE published_articles; ANALYZE post_revisions; ANALYZE "references"; ANALYZE reference_revisions');
  const counts = await pool.query<{ posts: string; revisions: string; associations: string; references: string; artifacts: string; published: string }>(`
    SELECT (SELECT count(*) FROM posts) AS posts,
      (SELECT count(*) FROM post_revisions) AS revisions,
      (SELECT count(*) FROM post_revision_tags) AS associations,
      (SELECT count(*) FROM "references") AS references,
      (SELECT count(*) FROM article_artifacts) AS artifacts,
      (SELECT count(*) FROM published_articles) AS published
  `);
  process.stdout.write(`Seeded isolated PostgreSQL benchmark database ${target.target.database}: ${JSON.stringify(counts.rows[0])}\n`);
} finally { await pool.end(); }
