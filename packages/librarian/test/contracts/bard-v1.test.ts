import { readFileSync } from 'node:fs';
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import type { AnySchema } from 'ajv';
import { expect, it } from 'vitest';
import { CSLRecordSchema } from '../../src/contracts/bibliography.js';

const contractPath = new URL('../../../../contracts/bard/v1/', import.meta.url);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(name, contractPath), 'utf8')) as unknown;

it('accepts the Bard v1 request fixture and rejects incompatible source bounds', () => {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(load('request.schema.json') as AnySchema);
  expect(validate(load('example.request.json'))).toBe(true);
  expect(validate({ schema_version: 1, source: 'x'.repeat(2_000_001), locale: 'en-US', document: { title: 'Valid' } })).toBe(false);
});

it('validates CSL fields without discarding additional bibliographic metadata', () => {
  const value = { id: 'study', type: 'article-journal', title: 'Study', author: [{ family: 'Example', given: 'A.' }], DOI: '10.1000/test', custom: { value: 1 } };
  expect(CSLRecordSchema.parse(value)).toEqual(value);
  expect(CSLRecordSchema.safeParse({ title: 'Missing type' }).success).toBe(false);
});

it('accepts Bard v1 manifest entry shapes with its exact path and hash rules', () => {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(load('manifest.schema.json') as AnySchema);
  expect(validate({ schema_version: 1, files: [{ path: 'article.html', media_type: 'text/html', sha256: 'a'.repeat(64) }], toc: [], diagnostics: [], fingerprint: 'b'.repeat(64) })).toBe(true);
  expect(validate({ schema_version: 2, files: [], toc: [], diagnostics: [], fingerprint: 'invalid' })).toBe(false);
});
