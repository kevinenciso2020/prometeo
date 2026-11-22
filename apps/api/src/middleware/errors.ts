import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../env';
import { AuthError } from '../services/auth.service';

/** Errores sin detalles internos: solo código y mensaje en español. */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AuthError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'HTTP_ERROR', message: err.message } }, err.status);
  }
  console.error('[error]', err instanceof Error ? err.message : 'desconocido');
  return c.json({ error: { code: 'INTERNAL', message: 'Ocurrió un error inesperado' } }, 500);
};

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado' } }, 404);
