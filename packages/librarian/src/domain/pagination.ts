import { z } from 'zod';

export const PageInputSchema = z.strictObject({ limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(4096).optional() });
export type PageInput = z.input<typeof PageInputSchema>;
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
