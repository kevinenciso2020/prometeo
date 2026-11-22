import { sign, verify } from 'hono/jwt';
import { ACCESS_TOKEN_TTL_SECONDS, ROLES, type Role } from '@prometeo/shared';
import type { AuthUser } from '../env';

const ALG = 'HS256' as const;

export async function signAccessToken(secret: string, user: AuthUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: user.id, role: user.role, iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS },
    secret,
    ALG,
  );
}

/** Devuelve el usuario del token o null si es inválido/expirado. */
export async function verifyAccessToken(secret: string, token: string): Promise<AuthUser | null> {
  try {
    const payload = await verify(token, secret, ALG);
    const role = payload.role;
    if (typeof payload.sub !== 'string' || typeof role !== 'string') return null;
    if (!(ROLES as readonly string[]).includes(role)) return null;
    return { id: payload.sub, role: role as Role };
  } catch {
    return null;
  }
}
