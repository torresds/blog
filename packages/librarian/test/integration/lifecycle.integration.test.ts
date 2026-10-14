import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { createPostgresLibrarian } from '../../src/postgres.js';
import { createTestPool } from '../../scripts/test-database.js';
import { createPostgresDatabase } from '../../src/infrastructure/postgres/connection.js';
import { createPostgresTransactionManager } from '../../src/infrastructure/postgres/transaction.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
const context = createPostgresLibrarian({ connectionString });
const pool = createTestPool();
const compilerFingerprint = 'a'.repeat(64);
const dependencyFingerprint = 'b'.repeat(64);
const csl = { id: 'unicode-book', type: 'book', title: 'A Unicode book: ação', author: [{ family: 'Silva', given: 'Ana' }], issued: { 'date-parts': [[2024]] } };

async function clearDatabase(): Promise<void> {
  await pool.query('TRUNCATE published_articles, publication_events, post_publications, artifact_reference_revisions, article_artifacts, reference_revisions, "references", post_revision_tags, tags, post_revisions, post_locales, posts CASCADE');
}
async function articleFixture() {
  const post = await context.librarian.articles.createPost();
  const locale = await context.librarian.articles.createLocale({ postId: post.id, locale: 'pt-BR' });
  const revision = await context.librarian.articles.commitRevision({ localeId: locale.id, expectedHeadId: null, expectedHeadNumber: 0, title: 'Uma história', slug: 'uma-historia', markdown: '# Ação', tags: [], seo: {}, presentation: {} });
  return { post, locale, revision };
}
async function artifact(localeId: string, revisionId: string, referenceId?: string, referenceRevisionId?: string) {
  return context.librarian.artifacts.record({
    localeId, revisionId, compilerFingerprint, dependencyFingerprint, html: '<article><h1>Uma história</h1></article>', toc: [],
    assetManifest: [{ path: 'article.html', media_type: 'text/html', sha256: 'c'.repeat(64) }],
    dependencies: referenceId && referenceRevisionId ? [{ referenceId, revisionId: referenceRevisionId }] : [],
  });
}

describe('PostgreSQL Librarian lifecycle', () => {
  beforeEach(clearDatabase);
  afterAll(async () => { await context.close(); await pool.end(); });

  it('commits immutable article revisions with compare-and-swap under concurrent writers', async () => {
    const { locale, revision } = await articleFixture();
    const outcomes = await Promise.allSettled([
      context.librarian.articles.commitRevision({ localeId: locale.id, expectedHeadId: revision.id, expectedHeadNumber: 1, title: 'First winner', slug: 'first-winner', markdown: 'One', tags: [], seo: {}, presentation: {} }),
      context.librarian.articles.commitRevision({ localeId: locale.id, expectedHeadId: revision.id, expectedHeadNumber: 1, title: 'Second writer', slug: 'second-writer', markdown: 'Two', tags: [], seo: {}, presentation: {} }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    const loser = outcomes.find((item) => item.status === 'rejected');
    assert.ok(loser?.status === 'rejected');
    assert.equal(loser.reason.code, 'REVISION_CONFLICT');
    const history = await context.librarian.articles.listRevisions({ localeId: locale.id });
    assert.equal(history.items.length, 2);
    assert.equal((await context.librarian.articles.getHead({ localeId: locale.id })).revisionNumber, 2);
  });

  it('commits and rolls back repository work inside the Kysely transaction boundary', async () => {
    const database = createPostgresDatabase({ connectionString });
    const transactions = createPostgresTransactionManager(database.db);
    const committed = await transactions.run((tx) => tx.articles.createPost());
    const visible = await pool.query('SELECT id FROM posts WHERE id = $1', [committed.id]);
    assert.equal(visible.rowCount, 1);
    const failure = new Error('transaction sentinel');
    await assert.rejects(transactions.run(async (tx) => { await tx.articles.createPost(); throw failure; }), (error) => error === failure);
    const total = await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM posts');
    assert.equal(total.rows[0]?.count, 1);
    await database.close();
  });

  it('serializes competing publication writers and preserves the winner', async () => {
    const { locale, revision } = await articleFixture();
    const first = await artifact(locale.id, revision.id);
    const second = await context.librarian.artifacts.record({ localeId: locale.id, revisionId: revision.id, compilerFingerprint: 'd'.repeat(64), dependencyFingerprint: 'e'.repeat(64), html: '<article>second</article>', toc: [], assetManifest: [], dependencies: [] });
    const outcomes = await Promise.allSettled([
      context.librarian.publications.publish({ localeId: locale.id, revisionId: revision.id, artifactId: first.id, expectedVersion: 0n }),
      context.librarian.publications.publish({ localeId: locale.id, revisionId: revision.id, artifactId: second.id, expectedVersion: 0n }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((item) => item.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.equal(rejected.reason.code, 'PUBLICATION_CONFLICT');
    const state = await context.librarian.publications.get({ localeId: locale.id });
    assert.equal(state.version, 1n);
    assert.equal(state.status, 'published');
    const events = await context.librarian.publications.history({ localeId: locale.id });
    assert.equal(events.items.length, 1);
  });

  it('pins references in compilation, finalizes artifacts, and atomically publishes and rolls back', async () => {
    const { locale, revision } = await articleFixture();
    const reference = await context.librarian.bibliography.createReference({ citationKey: 'unicode-book', csl });
    const head = await context.librarian.bibliography.getHead({ referenceId: reference.id });
    assert.ok(head.revisionId);
    const snapshot = await context.librarian.compilation.resolveSnapshot({ revisionId: revision.id, citationKeys: ['unicode-book', 'unicode-book'] });
    assert.equal(snapshot.references.length, 1);
    assert.equal(snapshot.references[0]?.revisionId, head.revisionId);
    const firstArtifact = await artifact(locale.id, revision.id, reference.id, head.revisionId);
    const firstState = await context.librarian.publications.publish({ localeId: locale.id, revisionId: revision.id, artifactId: firstArtifact.id, expectedVersion: 0n });
    assert.equal(firstState.status, 'published');
    assert.equal((await context.librarian.discovery.getPublishedArticle({ locale: 'pt-BR', slug: 'uma-historia' })).html, firstArtifact.html);
    const listing = await context.librarian.discovery.listPublishedArticles({ locale: 'pt-BR' });
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0]?.tags.length, 0);
    assert.equal('html' in (listing.items[0] ?? {}), false);

    const nextRevision = await context.librarian.articles.commitRevision({ localeId: locale.id, expectedHeadId: revision.id, expectedHeadNumber: 1, title: 'História corrigida', slug: 'historia-corrigida', markdown: '# Corrigida', tags: [], seo: {}, presentation: {} });
    const nextArtifact = await artifact(locale.id, nextRevision.id);
    await context.librarian.publications.publish({ localeId: locale.id, revisionId: nextRevision.id, artifactId: nextArtifact.id, expectedVersion: 1n });
    const rolledBack = await context.librarian.publications.rollback({ localeId: locale.id, revisionId: revision.id, artifactId: firstArtifact.id, expectedVersion: 2n });
    assert.equal(rolledBack.status, 'published');
    assert.equal(rolledBack.revisionId, revision.id);
    assert.equal((await context.librarian.articles.getHead({ localeId: locale.id })).revisionId, nextRevision.id);
    const history = await context.librarian.publications.history({ localeId: locale.id });
    assert.deepEqual(history.items.map((event) => event.action), ['rollback', 'publish', 'publish']);
    const hidden = await context.librarian.publications.unpublish({ localeId: locale.id, expectedVersion: 3n });
    assert.deepEqual(hidden, { status: 'unpublished', localeId: locale.id, version: 4n });
    await assert.rejects(context.librarian.publications.unpublish({ localeId: locale.id, expectedVersion: 4n }), { code: 'INVALID_PUBLICATION_TRANSITION' });
    await assert.rejects(context.librarian.discovery.getPublishedArticle({ locale: 'pt-BR', slug: 'uma-historia' }), { code: 'NOT_FOUND' });
  });

  it('imports BibTeX atomically and rejects duplicate citation keys', async () => {
    const source = '@book{one, title={Livro}, author={Silva, Ana}, year={2020}}\n@article{two, title={Paper}, author={Doe, Jane}, journal={Journal}, year={2021}}';
    const parsed = context.librarian.bibliography.parseBibTeX({ source });
    assert.equal(parsed.issues.length, 0);
    assert.deepEqual(parsed.entries.map((entry) => entry.citationKey), ['one', 'two']);
    const result = await context.librarian.bibliography.importBibTeX({ source });
    assert.equal(result.references.length, 2);
    assert.equal((await context.librarian.bibliography.getHead({ referenceId: result.references[0]!.id })).revisionNumber, 1);
    await assert.rejects(context.librarian.bibliography.importBibTeX({ source }), { code: 'DUPLICATE_CITATION_KEY' });
    const another = '@book{one, title={Different}, year={2022}}';
    await assert.rejects(context.librarian.bibliography.importBibTeX({ source: another }), { code: 'DUPLICATE_CITATION_KEY' });
    const partialCollision = '@book{new-entry, title={New}, year={2022}}\n@book{one, title={Collision}, year={2022}}';
    const existingReferences = await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM "references"');
    await assert.rejects(context.librarian.bibliography.importBibTeX({ source: partialCollision }), { code: 'DUPLICATE_CITATION_KEY' });
    const stillSame = await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM "references"');
    assert.equal(stillSame.rows[0]?.count, existingReferences.rows[0]?.count);
  });
});
