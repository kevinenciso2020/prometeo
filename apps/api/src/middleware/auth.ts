import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { ACCESS_COOKIE, type Role } from '@prometeo/shared';
import type { AppEnv } from '../env';
import { verifyAccessToken } from '../lib/jwt';

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, ACCESS_COOKIE);
  const user = token ? await verifyAccessToken(c.env.JWT_SECRET, token) : null;
  if (!user)
    return c.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Inicia sesión para continuar' } },
      401,
    );
  c.set('user', user);
  return next();
};

/** Autoriza por rol en el servidor (incluye requireAuth). */
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const denied = await requireAuth(c, async () => {});
    if (denied) return denied;
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'No tienes permisos para esta acción' } },
        403,
      );
    }
    return next();
  };
};
