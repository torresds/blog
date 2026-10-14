import { z } from 'zod';

export const UUIDSchema = z.uuid();
export type UUID = z.infer<typeof UUIDSchema>;

export const LocaleSchema = z.enum(['pt-BR', 'en-US']);
export type Locale = z.infer<typeof LocaleSchema>;

export const CitationKeySchema = z.string().min(1).max(200).regex(/^[^\s{}%,]+$/);
export const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const VersionSchema = z.bigint().nonnegative();
export const SerializedVersionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
