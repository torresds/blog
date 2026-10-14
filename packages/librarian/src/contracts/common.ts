import { z } from 'zod';
import { LocaleSchema, UUIDSchema } from '../domain/identifiers.js';
import { PageInputSchema } from '../domain/pagination.js';

export { LocaleSchema, UUIDSchema, PageInputSchema };
export const TimestampSchema = z.union([z.date(), z.iso.datetime({ offset: true }).transform((value) => new Date(value))]);
export const SlugSchema = z.string().min(1).max(200).regex(/^[^\s/]+$/);
export const ArticleTitleSchema = z.string().min(1).max(500);
export const MarkdownSchema = z.string().max(2_000_000);
export const DateInputSchema = z.union([z.date(), z.iso.datetime({ offset: true }).transform((value) => new Date(value))]);
export const LocaleInputSchema = z.strictObject({ postId: UUIDSchema, locale: LocaleSchema });
