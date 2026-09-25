import type { z } from 'zod';
import { AppError } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(
      400,
      'VALIDATION',
      'Données invalides',
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
