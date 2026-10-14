import { describe, expect, it } from 'vitest';
import { createLibrarian } from '../../src/index.js';
import type { LibrarianTransaction, TransactionManager } from '../../src/ports/transaction.js';
import type { DiscoveryRepository } from '../../src/ports/discovery.js';

describe('pure Librarian composition', () => {
  it('validates inputs before entering the transaction boundary', async () => {
    let calls = 0;
    const transaction = { articles: {} } as unknown as LibrarianTransaction;
    const transactions: TransactionManager = { run: async (operation) => { calls += 1; return operation(transaction); } };
    const discovery = {} as DiscoveryRepository;
    const librarian = createLibrarian({ transactions, discovery, bibtex: { parse: () => ({ entries: [], issues: [] }) } });

    await expect(librarian.articles.createLocale({ postId: 'invalid', locale: 'fr-FR' } as unknown as Parameters<typeof librarian.articles.createLocale>[0]))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(calls).toBe(0);
  });

  it('performs a domain read using in-memory repository ports', async () => {
    const post = { id: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', createdAt: new Date('2026-01-01T00:00:00Z') };
    const transaction: LibrarianTransaction = {
      articles: { getPost: async () => post } as unknown as LibrarianTransaction['articles'],
      bibliography: {} as LibrarianTransaction['bibliography'],
      artifacts: {} as LibrarianTransaction['artifacts'],
      publications: {} as LibrarianTransaction['publications'],
    };
    const transactions: TransactionManager = { run: async (operation) => operation(transaction) };
    const discovery = {} as DiscoveryRepository;
    const librarian = createLibrarian({ transactions, discovery, bibtex: { parse: () => ({ entries: [], issues: [] }) } });

    await expect(librarian.articles.getPost({ postId: post.id })).resolves.toEqual(post);
  });
});
