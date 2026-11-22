import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';

type Target = 'json' | 'query' | 'param';

/** Validador Zod con respuesta de error uniforme y sin detalles internos. */
export const validate = <T extends ZodType>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const fields = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return c.json({ error: { code: 'VALIDATION', message: 'Datos inválidos', fields } }, 400);
    }
  });
