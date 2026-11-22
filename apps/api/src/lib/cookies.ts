import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
} from '@prometeo/shared';
import type { AppEnv } from '../env';

function base(c: Context<AppEnv>) {
  const prod = c.env.ENVIRONMENT === 'production';
  return {
    httpOnly: true,
    secure: prod,
    sameSite: 'Lax' as const,
    ...(c.env.COOKIE_DOMAIN ? { domain: c.env.COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(c: Context<AppEnv>, access: string, refresh: string): void {
  setCookie(c, ACCESS_COOKIE, access, { ...base(c), path: '/', maxAge: ACCESS_TOKEN_TTL_SECONDS });
  // El refresh solo viaja hacia /auth (refresh y logout).
  setCookie(c, REFRESH_COOKIE, refresh, {
    ...base(c),
    path: '/auth',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
}

export function clearAuthCookies(c: Context<AppEnv>): void {
  const opts = base(c);
  deleteCookie(c, ACCESS_COOKIE, {
    path: '/',
    ...(opts.domain ? { domain: opts.domain } : {}),
    secure: opts.secure,
  });
  deleteCookie(c, REFRESH_COOKIE, {
    path: '/auth',
    ...(opts.domain ? { domain: opts.domain } : {}),
    secure: opts.secure,
  });
}
