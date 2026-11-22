import { defineMiddleware } from 'astro:middleware';

/** Fase 2: protegerá /admin verificando la sesión en el servidor. */
export const onRequest = defineMiddleware((_context, next) => next());
