import type { ArticleArtifact, ArticleArtifactSummary, RecordArtifactInput } from '../contracts/artifacts.js';
import type { Page } from '../domain/pagination.js';
export interface ArtifactRepository {
  record(input: RecordArtifactInput): Promise<ArticleArtifact>;
  get(id: string): Promise<ArticleArtifact | undefined>;
  listForRevision(revisionId: string, limit: number, cursor?: string): Promise<Page<ArticleArtifactSummary>>;
}
