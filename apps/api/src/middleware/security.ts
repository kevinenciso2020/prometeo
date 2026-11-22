import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from '../env';

/** Cabeceras de seguridad para una API JSON (CSP restrictiva: no sirve HTML). */
export const securityHeaders = secureHeaders({
  strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  xFrameOptions: 'DENY',
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
});

/** CORS: únicamente el origen del frontend, con credenciales. */
export const corsPolicy: MiddlewareHandler<AppEnv> = (c, next) =>
  cors({
    origin: (origin) => (origin === c.env.WEB_ORIGIN ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 600,
  })(c, next);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defensa CSRF adicional a SameSite=Lax: toda petición que modifica datos debe traer
 * un Origin igual al del frontend. Los webhooks (/webhooks/*) se autentican por firma.
 */
export const originCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || c.req.path.startsWith('/webhooks/')) return next();
  if (c.req.header('Origin') !== c.env.WEB_ORIGIN) {
    return c.json({ error: { code: 'BAD_ORIGIN', message: 'Origen no permitido' } }, 403);
  }
  return next();
};
