import { z } from 'zod';

export const PublicationStatusSchema = z.enum(['published', 'unpublished']);
export const PublicationStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unpublished'), localeId: z.uuid(), version: z.bigint().nonnegative() }),
  z.strictObject({ status: z.literal('published'), localeId: z.uuid(), version: z.bigint().nonnegative(), revisionId: z.uuid(), artifactId: z.uuid(), publishedAt: z.date() }),
]);
export type PublicationState = z.infer<typeof PublicationStateSchema>;
export const SerializedPublicationStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unpublished'), localeId: z.uuid(), version: z.string().regex(/^(0|[1-9][0-9]*)$/) }),
  z.strictObject({ status: z.literal('published'), localeId: z.uuid(), version: z.string().regex(/^(0|[1-9][0-9]*)$/), revisionId: z.uuid(), artifactId: z.uuid(), publishedAt: z.iso.datetime({ offset: true }) }),
]);
export type SerializedPublicationState = z.infer<typeof SerializedPublicationStateSchema>;
export function serializePublicationState(state: PublicationState): SerializedPublicationState {
  return state.status === 'published'
    ? { status: state.status, localeId: state.localeId, version: state.version.toString(), revisionId: state.revisionId, artifactId: state.artifactId, publishedAt: state.publishedAt.toISOString() }
    : { status: state.status, localeId: state.localeId, version: state.version.toString() };
}

export type PublicationAction = 'publish' | 'unpublish' | 'rollback';
