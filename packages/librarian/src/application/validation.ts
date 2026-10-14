import { z } from 'zod';
import { validationError } from '../domain/errors.js';
export function safeParse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}
