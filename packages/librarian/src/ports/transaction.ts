import type { ArticleRepository } from './articles.js';
import type { BibliographyRepository } from './bibliography.js';
import type { ArtifactRepository } from './artifacts.js';
import type { PublicationRepository } from './publications.js';
export interface LibrarianTransaction {
  readonly articles: ArticleRepository;
  readonly bibliography: BibliographyRepository;
  readonly artifacts: ArtifactRepository;
  readonly publications: PublicationRepository;
}
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';
export interface TransactionOptions { readonly isolationLevel?: IsolationLevel }
export interface TransactionManager { run<T>(operation: (context: LibrarianTransaction) => Promise<T>, options?: TransactionOptions): Promise<T> }
