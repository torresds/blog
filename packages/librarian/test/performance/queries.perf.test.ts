import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresLibrarian } from '../../src/postgres.js';
import type { Database } from '../../src/infrastructure/postgres/schema.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL must be loaded for the seeded performance suite');
const pool = new Pool({ connectionString, max: 5 });
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
const librarian = createPostgresLibrarian({ connectionString, maxConnections: 5 });
function id(seed: string): string {
  const digest = createHash('md5').update(seed).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}
async function measure(label: string, operation: () => Promise<unknown>, repetitions = 40): Promise<{ label: string; p50Ms: number; p95Ms: number; samples: number }> {
  for (let index = 0; index < 8; index += 1) await operation();
  const timings: number[] = [];
  for (let index = 0; index < repetitions; index += 1) { const start = performance.now(); await operation(); timings.push(performance.now() - start); }
  timings.sort((a, b) => a - b);
  return { label, p50Ms: Number(timings[Math.floor(timings.length * 0.5)]?.toFixed(3)), p95Ms: Number(timings[Math.ceil(timings.length * 0.95) - 1]?.toFixed(3)), samples: repetitions };
}
interface PlanNode { readonly 'Node Type'?: unknown; readonly 'Index Name'?: unknown; readonly 'Relation Name'?: unknown; readonly 'Actual Rows'?: unknown; readonly 'Shared Hit Blocks'?: unknown; readonly 'Shared Read Blocks'?: unknown; readonly Plans?: readonly PlanNode[] }
interface PlanSummary { readonly Plan?: unknown; readonly 'Planning Time'?: unknown; readonly 'Execution Time'?: unknown }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function summarizePlan(rows: readonly Record<string, unknown>[]): Readonly<Record<string, unknown>> {
  const wrapper = rows[0]?.['QUERY PLAN']; const first = Array.isArray(wrapper) ? wrapper[0] : undefined;
  if (!isRecord(first)) return { invalidPlan: true };
  const summary = first as unknown as PlanSummary; const nodes: PlanNode[] = [];
  const visit = (node: PlanNode): void => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
  if (isRecord(summary.Plan)) visit(summary.Plan as PlanNode);
  return {
    planningMs: summary['Planning Time'], executionMs: summary['Execution Time'],
    rows: nodes.reduce((sum, node) => sum + (typeof node['Actual Rows'] === 'number' ? node['Actual Rows'] : 0), 0),
    indexes: nodes.map((node) => node['Index Name']).filter((name): name is string => typeof name === 'string'),
    scans: nodes.map((node) => ({ type: node['Node Type'], relation: node['Relation Name'] })),
    sharedBufferHits: nodes.reduce((sum, node) => sum + (typeof node['Shared Hit Blocks'] === 'number' ? node['Shared Hit Blocks'] : 0), 0),
    sharedBufferReads: nodes.reduce((sum, node) => sum + (typeof node['Shared Read Blocks'] === 'number' ? node['Shared Read Blocks'] : 0), 0),
  };
}

describe('seeded PostgreSQL performance paths', () => {
  afterAll(async () => { await librarian.close(); await db.destroy(); });
  it('measures indexed public paths and prints query plans and machine context', async () => {
    const counts = await db.selectFrom('posts').select((eb) => eb.fn.countAll<number>().as('posts')).executeTakeFirstOrThrow();
    expect(Number(counts.posts)).toBe(1000);
    const versionResult = await pool.query<{ version: string }>('SELECT version()');
    const version = versionResult.rows[0];
    const localeId = id('librarian-perf-locale:350:pt-BR');
    const revisionId = id('librarian-perf-revision:350:pt-BR:10');
    const referenceId = id('librarian-perf-reference:350');
    const referenceRevisionId = id('librarian-perf-reference-revision:350:3');
    const artifactId = id('librarian-perf-artifact:350:pt-BR:0');
    let headId = revisionId; let headNumber = 10;
    let publicationVersion = 1n;
    const dependencySet = Array.from({ length: 20 }, (_, offset) => ({ referenceId: id(`librarian-perf-reference:${offset + 1}`), revisionId: id(`librarian-perf-reference-revision:${offset + 1}:3`) }));
    const metrics = [
      await measure('published lookup', () => librarian.librarian.discovery.getPublishedArticle({ locale: 'pt-BR', slug: 'article-350-ptbr' })),
      await measure('published list 20', () => librarian.librarian.discovery.listPublishedArticles({ locale: 'pt-BR', limit: 20 })),
      await measure('tag list 20', () => librarian.librarian.discovery.listPublishedByTag({ locale: 'pt-BR', tag: 'tag-1', limit: 20 })),
      await measure('revision history 20', () => librarian.librarian.articles.listRevisions({ localeId, limit: 20 })),
      await measure('reference head', () => librarian.librarian.bibliography.getHead({ referenceId })),
      await measure('compilation snapshot 2 citations', () => librarian.librarian.compilation.resolveSnapshot({ revisionId, citationKeys: ['reference-351', 'reference-350'] })),
      await measure('article revision commit 20 tags', async () => {
        const revision = await librarian.librarian.articles.commitRevision({ localeId, expectedHeadId: headId, expectedHeadNumber: headNumber, title: `Performance revision ${headNumber + 1}`, slug: 'article-350-ptbr', markdown: '# Performance revision', tags: Array.from({ length: 20 }, (_, index) => `tag-${index + 1}`), seo: {}, presentation: {} });
        headId = revision.id; headNumber = revision.revisionNumber;
      }),
      await measure('artifact record 20 dependencies', () => librarian.librarian.artifacts.record({ localeId, revisionId, compilerFingerprint: 'd'.repeat(64), dependencyFingerprint: 'e'.repeat(64), html: '<article>performance</article>', toc: [], assetManifest: [], dependencies: dependencySet })),
      await measure('publication CAS update', async () => {
        await librarian.librarian.publications.publish({ localeId, revisionId, artifactId, expectedVersion: publicationVersion });
        publicationVersion += 1n;
      }),
    ];
    const plans = await Promise.all([
      db.selectFrom('published_articles as p').innerJoin('article_artifacts as a', 'a.id', 'p.artifact_id').select(['p.post_locale_id', 'a.html']).where('p.locale', '=', 'pt-BR').where('p.slug', '=', 'article-350-ptbr').explain('json', sql`analyze, buffers`),
      db.selectFrom('published_articles').select(['post_locale_id', 'slug', 'title', 'excerpt', 'seo', 'tags', 'published_at']).where('locale', '=', 'pt-BR').orderBy('published_at', 'desc').orderBy('post_locale_id', 'desc').limit(20).explain('json', sql`analyze, buffers`),
      db.selectFrom('published_articles').select(['post_locale_id', 'slug', 'title', 'published_at']).where('locale', '=', 'pt-BR').where('tags', '@>', sql<readonly string[]>`ARRAY['tag-1']::text[]`).orderBy('published_at', 'desc').orderBy('post_locale_id', 'desc').limit(20).explain('json', sql`analyze, buffers`),
      db.selectFrom('post_revisions').select(['id', 'revision_number', 'title', 'slug', 'created_at']).where('post_locale_id', '=', localeId).orderBy('revision_number', 'desc').limit(20).explain('json', sql`analyze, buffers`),
      db.selectFrom('references as r').innerJoin('reference_revisions as rr', 'rr.id', 'r.head_revision_id').select(['r.id', 'rr.id as revision_id', 'rr.csl_json']).where('r.citation_key', '=', 'reference-350').explain('json', sql`analyze, buffers`),
    ]);
    const info = { node: process.version, postgres: version?.version, cpus: cpus().length, platform: process.platform, posts: Number(counts.posts), warmup: 8, repetitions: 40, metrics, plans: plans.map((plan) => summarizePlan(plan)) };
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    expect(metrics[0]?.p95Ms).toBeLessThan(10);
    expect(metrics[1]?.p95Ms).toBeLessThan(15);
    expect(metrics[2]?.p95Ms).toBeLessThan(20);
  });
});
