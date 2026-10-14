import { describe, expect, it } from 'vitest';
import { createPostgresTransactionManager } from '../../src/infrastructure/postgres/transaction.js';

describe('PostgreSQL transaction adapter', () => {
  it('sets the requested isolation level and returns the operation result', async () => {
    const levels: string[] = [];
    const trx = {};
    const db = { transaction: () => ({ setIsolationLevel(level: string) { levels.push(level); return this; }, execute: async (operation: (value: unknown) => Promise<unknown>) => operation(trx) }) };
    const transactions = createPostgresTransactionManager(db as never);
    await expect(transactions.run(async () => 'complete', { isolationLevel: 'repeatable read' })).resolves.toBe('complete');
    expect(levels).toEqual(['repeatable read']);
  });
});
