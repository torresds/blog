import { z } from 'zod';
import { LibrarianError } from '../../domain/errors.js';
import { JsonObjectSchema } from '../../domain/json.js';
import type { JsonValue } from '../../domain/json.js';
export function decodeJsonObject(value: unknown): Record<string, JsonValue> {
  let parsed = value;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) as unknown; } catch (cause) { throw new LibrarianError('INVALID_REVISION', 'Stored JSON is invalid', { cause }); } }
  const result = JsonObjectSchema.safeParse(parsed);
  if (!result.success) throw new LibrarianError('INVALID_REVISION', 'Stored JSON does not match the domain contract', { cause: result.error });
  return result.data;
}
export function decodeTimestamp(value: unknown): Date {
  const date = value instanceof Date ? new Date(value) : typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new LibrarianError('INVALID_REVISION', 'Stored timestamp is invalid');
  return date;
}
export function decodeBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new LibrarianError('INVALID_REVISION', 'Stored version is invalid');
}
export function decodeTextArray(value: unknown): readonly string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  if (typeof value === 'string') {
    if (value === '{}') return [];
    if (value.startsWith('{') && value.endsWith('}')) {
      const body = value.slice(1, -1); const items: string[] = []; let item = ''; let quoted = false; let escaped = false;
      for (const char of body) {
        if (escaped) { item += char; escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { quoted = !quoted; continue; }
        if (char === ',' && !quoted) { items.push(item); item = ''; continue; }
        item += char;
      }
      if (escaped || quoted) throw new LibrarianError('INVALID_REVISION', 'Stored text array is invalid');
      if (body.length) items.push(item);
      return items;
    }
  }
  throw new LibrarianError('INVALID_REVISION', 'Stored text array is invalid');
}
export function decodePersisted<T>(schema: z.ZodType<T>, value: unknown, category: 'INVALID_REVISION' | 'INVALID_ARTIFACT' = 'INVALID_REVISION'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new LibrarianError(category, 'Stored record does not match its domain contract', { cause: result.error });
  return result.data;
}
