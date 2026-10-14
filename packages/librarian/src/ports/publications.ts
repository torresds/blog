import type { PublicationEvent } from '../contracts/publications.js';
import type { PublicationState } from '../domain/publication-state.js';
import type { Page } from '../domain/pagination.js';
export interface PublicationRepository {
  get(localeId: string): Promise<PublicationState | undefined>;
  publish(input: { localeId: string; revisionId: string; artifactId: string; expectedVersion: bigint }): Promise<PublicationState>;
  unpublish(input: { localeId: string; expectedVersion: bigint }): Promise<PublicationState>;
  rollback(input: { localeId: string; revisionId: string; artifactId: string; expectedVersion: bigint }): Promise<PublicationState>;
  history(localeId: string, limit: number, cursor?: string): Promise<Page<PublicationEvent>>;
}
