import { describe, expect, it } from 'vitest';
import { ArticleMetadataSchema } from '../../src/contracts/articles.js';
import { PageInputSchema } from '../../src/domain/pagination.js';
import { decodeBigInt, decodeTimestamp, decodeTextArray, decodeJsonObject } from '../../src/infrastructure/postgres/codecs.js';
import { translatePostgresError } from '../../src/infrastructure/postgres/errors.js';
import { LibrarianError } from '../../src/domain/errors.js';
import { PublicationStateSchema, serializePublicationState } from '../../src/domain/publication-state.js';

describe('domain boundary validation and persisted value codecs', () => {
  it('preserves authored Unicode and deduplicates tags within Bard source limits', () => {
    const data = ArticleMetadataSchema.parse({ title: 'ação', slug: 'acao', markdown: '# Olá', tags: ['rust', 'rust'] });
    expect(data.title).toBe('ação');
    expect(data.tags).toEqual(['rust']);
    expect(ArticleMetadataSchema.safeParse({ title: 'x'.repeat(501), slug: 'valid', markdown: '' }).success).toBe(false);
  });
  it('bounds pagination and decodes bigint without precision loss', () => {
    expect(PageInputSchema.parse({}).limit).toBe(20);
    expect(PageInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(decodeBigInt('9007199254740993')).toBe(9007199254740993n);
    expect(() => decodeBigInt(9007199254740992)).toThrow(LibrarianError);
  });
  it('validates persisted JSON, timestamps, and text arrays', () => {
    expect(decodeJsonObject('{"valid":[1,true]}')).toEqual({ valid: [1, true] });
    expect(() => decodeJsonObject('[]')).toThrow('Stored JSON');
    expect(decodeTimestamp('2026-10-14T00:00:00.000Z').toISOString()).toBe('2026-10-14T00:00:00.000Z');
    expect(decodeTextArray('{"one","two"}')).toEqual(['one', 'two']);
  });
  it('translates known database conflicts without exposing driver details', () => {
    const translated = translatePostgresError({ code: '23505', constraint: 'published_articles_locale_slug_key', detail: 'private db detail' });
    expect(translated).toMatchObject({ code: 'PUBLISHED_SLUG_CONFLICT', message: 'A published article already uses this locale and slug' });
    expect(translated.message).not.toContain('private db detail');
    expect(translatePostgresError(new Error('network failure')).message).toBe('network failure');
  });
  it('serializes publication versions as decimal strings without bigint precision loss', () => {
    const state = PublicationStateSchema.parse({ status: 'unpublished', localeId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', version: 9007199254740993n });
    expect(serializePublicationState(state)).toMatchObject({ version: '9007199254740993' });
    const published = PublicationStateSchema.parse({ status: 'published', localeId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', revisionId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', artifactId: '7b3989e0-a206-4d45-b3f1-1b669dadd4fb', version: 2n, publishedAt: new Date('2026-01-01T00:00:00Z') });
    expect(serializePublicationState(published)).toMatchObject({ status: 'published', version: '2', publishedAt: '2026-01-01T00:00:00.000Z' });
  });
});
