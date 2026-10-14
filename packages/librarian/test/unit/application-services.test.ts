import { describe, expect, it, vi } from 'vitest';
import { createLibrarian } from '../../src/application/create-librarian.js';
import { LibrarianError } from '../../src/domain/errors.js';
import type { LibrarianTransaction, TransactionManager, TransactionOptions } from '../../src/ports/transaction.js';
import type { DiscoveryRepository } from '../../src/ports/discovery.js';
import { notFound } from '../../src/domain/errors.js';

function makeLibrarian(transaction: Partial<LibrarianTransaction>, optionsSeen: TransactionOptions[] = []) {
  const transactions: TransactionManager = { run: async (operation, options = {}) => { optionsSeen.push(options); return operation(transaction as LibrarianTransaction); } };
  return createLibrarian({ transactions, discovery: {} as DiscoveryRepository, bibtex: { parse: () => ({ entries: [], issues: [] }) } });
}

describe('Librarian application use cases', () => {
  it('rejects unknown tags without committing a partial revision', async () => {
    const commitRevision = vi.fn();
    const librarian = makeLibrarian({ articles: { resolveTags: async () => [], commitRevision } as never });
    await expect(librarian.articles.commitRevision({
      localeId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', expectedHeadId: null, expectedHeadNumber: 0,
      title: 'Title', slug: 'title', markdown: '# Title', tags: ['missing'], seo: {}, presentation: {},
    })).rejects.toMatchObject({ code: 'UNKNOWN_TAGS' });
    expect(commitRevision).not.toHaveBeenCalled();
  });

  it('resolves citation keys once under repeatable read and reports unknown citations', async () => {
    const options: TransactionOptions[] = [];
    const librarian = makeLibrarian({
      articles: {
        getRevision: async () => ({ id: 'rev', localeId: 'locale', revisionNumber: 1, parentRevisionId: null, title: 'Title', subtitle: null, slug: 'title', markdown: '# Title', excerpt: null, seo: {}, presentation: {}, tags: [], createdAt: new Date() }),
        getLocale: async () => ({ id: 'locale', postId: 'post', locale: 'en-US', headRevisionId: 'rev', headRevisionNumber: 1, createdAt: new Date() }),
      } as never,
      bibliography: { findByCitationKeys: async (keys: readonly string[]) => { expect(keys).toEqual(['known']); return []; } } as never,
    }, options);
    await expect(librarian.compilation.resolveSnapshot({ revisionId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', citationKeys: ['known', 'known'] }))
      .rejects.toMatchObject({ code: 'UNKNOWN_CITATIONS' });
    expect(options).toContainEqual({ isolationLevel: 'repeatable read' });
  });

  it('preserves a repository transition error and propagates transaction failures', async () => {
    const expected = new LibrarianError('INVALID_PUBLICATION_TRANSITION', 'Rollback target is not historical');
    const librarian = makeLibrarian({ publications: { rollback: async () => { throw expected; } } as never });
    await expect(librarian.publications.rollback({ localeId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', revisionId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', artifactId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', expectedVersion: 0n })).rejects.toBe(expected);
  });

  it('routes successful calls through pure article, bibliography, artifact, publication, and discovery ports', async () => {
    const id = '7b3989e0-a206-4d45-b3f1-1b669dadd4fb'; const now = new Date('2026-01-01T00:00:00Z');
    const post = { id, createdAt: now }; const locale = { id, postId: id, locale: 'en-US' as const, headRevisionId: id, headRevisionNumber: 1, createdAt: now };
    const revision = { id, localeId: id, revisionNumber: 1, parentRevisionId: null, title: 'Title', subtitle: null, slug: 'title', markdown: '# Title', excerpt: null, seo: {}, presentation: {}, tags: [], createdAt: now };
    const reference = { id, citationKey: 'key', createdAt: now }; const refRevision = { id, referenceId: id, revisionNumber: 1, csl: { id, type: 'book', title: 'Book' }, createdAt: now };
    const artifact = { id, localeId: id, revisionId: id, compilerFingerprint: 'a'.repeat(64), dependencyFingerprint: 'b'.repeat(64), html: '<article/>', toc: [], assetManifest: [], dependencies: [], createdAt: now };
    const unpublished = { status: 'unpublished' as const, localeId: id, version: 0n }; const published = { status: 'published' as const, localeId: id, version: 1n, revisionId: id, artifactId: id, publishedAt: now };
    const event = { id, localeId: id, action: 'publish' as const, previousVersion: 0n, newVersion: 1n, previousRevisionId: null, previousArtifactId: null, revisionId: id, artifactId: id, createdAt: now };
    const page = { items: [], nextCursor: null };
    const transaction = {
      articles: { createPost: async () => post, createLocale: async () => locale, getPost: async () => post, getLocale: async () => locale, listPostLocales: async () => [locale], createTag: async () => ({ id, slug: 'rust', createdAt: now }), resolveTags: async () => [{ id, slug: 'rust', createdAt: now }], commitRevision: async () => revision, getHead: async () => ({ localeId: id, revisionId: id, revisionNumber: 1 }), getRevision: async () => revision, listRevisions: async () => page },
      bibliography: { createReference: async () => ({ reference, revision: refRevision }), getReference: async () => reference, getHead: async () => ({ referenceId: id, revisionId: id, revisionNumber: 1 }), getRevision: async () => refRevision, listRevisions: async () => page, commitRevision: async () => refRevision, findByCitationKeys: async () => [{ ...refRevision, citationKey: 'key' }], importEntries: async (entries: readonly unknown[]) => entries.map(() => ({ reference, revision: refRevision })) },
      artifacts: { record: async () => artifact, get: async () => artifact, listForRevision: async () => page },
      publications: { get: async () => unpublished, publish: async () => published, unpublish: async () => unpublished, rollback: async () => published, history: async () => ({ items: [event], nextCursor: null }) },
    } as unknown as LibrarianTransaction;
    const discovery: DiscoveryRepository = { getPublishedArticle: async () => ({ locale: 'en-US', slug: 'title', title: 'Title', excerpt: null, seo: {}, tags: [], publishedAt: now, revisionId: id, artifactId: id, html: '<article/>' }), listPublishedArticles: async () => page, listPublishedByTag: async () => page } as never;
    const librarian = createLibrarian({ transactions: { run: async (operation) => operation(transaction) }, discovery, bibtex: { parse: () => ({ entries: [{ citationKey: 'key', csl: refRevision.csl }], issues: [] }) } });
    const metadata = { title: 'Title', slug: 'title', markdown: '# Title', tags: ['rust'], seo: {}, presentation: {} };
    expect(await librarian.articles.createPost()).toEqual(post);
    expect(await librarian.articles.createLocale({ postId: id, locale: 'en-US' })).toEqual(locale);
    expect(await librarian.articles.getLocale({ localeId: id })).toEqual(locale);
    expect(await librarian.articles.listPostLocales({ postId: id })).toEqual([locale]);
    expect(await librarian.articles.createTag({ slug: 'rust' })).toMatchObject({ slug: 'rust' });
    expect(await librarian.articles.commitRevision({ ...metadata, localeId: id, expectedHeadId: null, expectedHeadNumber: 0 })).toEqual(revision);
    expect(await librarian.articles.getHead({ localeId: id })).toMatchObject({ revisionNumber: 1 });
    expect(await librarian.articles.getRevision({ revisionId: id })).toEqual(revision);
    await librarian.articles.listRevisions({ localeId: id });
    expect(await librarian.bibliography.createReference({ citationKey: 'key', csl: refRevision.csl })).toEqual(reference);
    expect(await librarian.bibliography.getReference({ referenceId: id })).toEqual(reference);
    expect(await librarian.bibliography.getHead({ referenceId: id })).toMatchObject({ revisionNumber: 1 });
    expect(await librarian.bibliography.getRevision({ revisionId: id })).toEqual(refRevision);
    await librarian.bibliography.listRevisions({ referenceId: id });
    expect(await librarian.bibliography.commitRevision({ referenceId: id, expectedHeadId: id, expectedHeadNumber: 1, csl: refRevision.csl })).toEqual(refRevision);
    expect(librarian.bibliography.parseBibTeX({ source: '@book{key,title={Book}}' }).entries).toHaveLength(1);
    expect(await librarian.bibliography.importBibTeX({ source: '@book{key,title={Book}}' })).toMatchObject({ references: [reference] });
    expect((await librarian.compilation.resolveSnapshot({ revisionId: id, citationKeys: ['key', 'key'] })).references).toHaveLength(1);
    expect(await librarian.artifacts.record({ localeId: id, revisionId: id, compilerFingerprint: 'a'.repeat(64), dependencyFingerprint: 'b'.repeat(64), html: '<article/>', toc: [], assetManifest: [], dependencies: [] })).toEqual(artifact);
    expect(await librarian.artifacts.get({ artifactId: id })).toEqual(artifact);
    await librarian.artifacts.listForRevision({ revisionId: id });
    expect(await librarian.publications.get({ localeId: id })).toEqual(unpublished);
    expect(await librarian.publications.publish({ localeId: id, revisionId: id, artifactId: id, expectedVersion: 0n })).toEqual(published);
    expect(await librarian.publications.unpublish({ localeId: id, expectedVersion: 1n })).toEqual(unpublished);
    expect(await librarian.publications.rollback({ localeId: id, revisionId: id, artifactId: id, expectedVersion: 0n })).toEqual(published);
    expect((await librarian.publications.history({ localeId: id })).items).toEqual([event]);
    expect((await librarian.discovery.getPublishedArticle({ locale: 'en-US', slug: 'title' })).html).toBe('<article/>');
    expect(await librarian.discovery.listPublishedArticles({ locale: 'en-US' })).toEqual(page);
    expect(await librarian.discovery.listPublishedByTag({ locale: 'en-US', tag: 'rust' })).toEqual(page);
  });

  it('uses consistent not-found errors and reports BibTeX diagnostics before starting a transaction', async () => {
    const librarian = createLibrarian({
      transactions: { run: async (operation) => operation({ articles: { getPost: async () => undefined } } as never) },
      discovery: {} as DiscoveryRepository,
      bibtex: { parse: () => ({ entries: [], issues: ['invalid title'] }) },
    });
    await expect(librarian.articles.getPost({ postId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.bibliography.importBibTeX({ source: '@book{x}' })).rejects.toMatchObject({ code: 'VALIDATION', issues: [{ path: [] }] });
    expect(notFound('Post').code).toBe('NOT_FOUND');
  });

  it('reports not-found results consistently across lookup, history, snapshot, artifact, publication, and discovery calls', async () => {
    const id = '7b3989e0-a206-4d45-b3f1-1b669dadd4fb';
    const missing = async (): Promise<undefined> => undefined;
    const librarian = createLibrarian({
      transactions: { run: async (operation) => operation({
        articles: { getPost: missing, getLocale: missing, getHead: missing, getRevision: missing },
        bibliography: { getReference: missing, getHead: missing, getRevision: missing },
        artifacts: { get: missing },
        publications: { get: missing },
      } as never) },
      discovery: { getPublishedArticle: missing } as never,
      bibtex: { parse: () => ({ entries: [{ citationKey: 'same', csl: { id: 'same', type: 'book', title: 'A' } }, { citationKey: 'same', csl: { id: 'same', type: 'book', title: 'A' } }], issues: [] }) },
    });
    await expect(librarian.articles.getLocale({ localeId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.articles.listPostLocales({ postId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.articles.getHead({ localeId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.articles.getRevision({ revisionId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.articles.listRevisions({ localeId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.bibliography.getReference({ referenceId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.bibliography.getHead({ referenceId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.bibliography.getRevision({ revisionId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.bibliography.listRevisions({ referenceId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.bibliography.importBibTeX({ source: '@book{same,title={A}}' })).rejects.toMatchObject({ code: 'DUPLICATE_CITATION_KEY' });
    await expect(librarian.compilation.resolveSnapshot({ revisionId: id, citationKeys: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.artifacts.get({ artifactId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.artifacts.listForRevision({ revisionId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.publications.get({ localeId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.publications.history({ localeId: id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(librarian.discovery.getPublishedArticle({ locale: 'en-US', slug: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const missingLocale = createLibrarian({
      transactions: { run: async (operation) => operation({ articles: { getRevision: async () => ({ id, localeId: id }) , getLocale: missing } } as never) },
      discovery: {} as DiscoveryRepository,
      bibtex: { parse: () => ({ entries: [], issues: [] }) },
    });
    await expect(missingLocale.compilation.resolveSnapshot({ revisionId: id, citationKeys: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
