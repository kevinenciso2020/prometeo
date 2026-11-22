import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { ACCESS_COOKIE } from '@prometeo/shared';
import type { AppEnv } from '../env';
import { verifyAccessToken } from './jwt';

/** Usuario de la sesión si existe (rutas públicas que aceptan invitados y cuentas). */
export async function optionalUser(c: Context<AppEnv>) {
  const token = getCookie(c, ACCESS_COOKIE);
  return token ? verifyAccessToken(c.env.JWT_SECRET, token) : null;
}
