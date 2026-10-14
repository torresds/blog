import type { Kysely } from 'kysely';
import type { LibrarianTransaction, TransactionManager, TransactionOptions } from '../../ports/transaction.js';
import { PostgresArticleRepository } from './articles.repository.js';
import { PostgresBibliographyRepository } from './bibliography.repository.js';
import { PostgresArtifactRepository } from './artifacts.repository.js';
import { PostgresPublicationRepository } from './publications.repository.js';
import type { Database } from './schema.js';
import { translatePostgresError } from './errors.js';

export function createPostgresTransactionManager(db: Kysely<Database>): TransactionManager {
  return {
    async run<T>(operation: (context: LibrarianTransaction) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
      try {
        let transaction = db.transaction();
        if (options.isolationLevel) transaction = transaction.setIsolationLevel(options.isolationLevel);
        return await transaction.execute(async (trx) => operation({
          articles: new PostgresArticleRepository(trx),
          bibliography: new PostgresBibliographyRepository(trx),
          artifacts: new PostgresArtifactRepository(trx),
          publications: new PostgresPublicationRepository(trx),
        }));
      } catch (error) { throw translatePostgresError(error); }
    },
  };
}
