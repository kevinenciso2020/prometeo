import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  REFRESH_COOKIE,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
} from '@prometeo/shared';
import type { AppEnv } from '../env';
import { clearAuthCookies, setAuthCookies } from '../lib/cookies';
import { validate } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import * as auth from '../services/auth.service';

export const authRoutes = new Hono<AppEnv>();

function authDeps(c: Context<AppEnv>): auth.AuthDeps {
  return {
    db: c.get('db'),
    mailer: c.get('mailer'),
    jwtSecret: c.env.JWT_SECRET,
    webUrl: c.env.WEB_URL,
  };
}

function meta(c: Context<AppEnv>): auth.SessionMeta {
  return { userAgent: c.req.header('user-agent'), ip: c.req.header('cf-connecting-ip') };
}

const limited = rateLimit('RL_AUTH', 'auth');

authRoutes.post('/register', limited, validate('json', registerSchema), async (c) => {
  await auth.register(authDeps(c), c.req.valid('json'));
  // Respuesta idéntica exista o no el correo.
  return c.json(
    { ok: true, message: 'Si el correo es válido, te enviamos un enlace para verificarlo' },
    202,
  );
});

authRoutes.post('/login', limited, validate('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const session = await auth.login(authDeps(c), email, password, meta(c));
  setAuthCookies(c, session.accessToken, session.refreshToken);
  return c.json({ user: session.user });
});

authRoutes.post('/refresh', limited, async (c) => {
  const token = getCookie(c, REFRESH_COOKIE);
  if (!token) {
    clearAuthCookies(c);
    return c.json({ error: { code: 'INVALID_SESSION', message: 'Inicia sesión de nuevo' } }, 401);
  }
  try {
    const session = await auth.refresh(authDeps(c), token, meta(c));
    setAuthCookies(c, session.accessToken, session.refreshToken);
    return c.json({ user: session.user });
  } catch (err) {
    clearAuthCookies(c);
    throw err;
  }
});

authRoutes.post('/logout', async (c) => {
  await auth.logout(c.get('db'), getCookie(c, REFRESH_COOKIE));
  clearAuthCookies(c);
  return c.json({ ok: true });
});

authRoutes.post('/verify-email', limited, validate('json', tokenSchema), async (c) => {
  await auth.verifyEmail(c.get('db'), c.req.valid('json').token);
  return c.json({ ok: true });
});

authRoutes.post('/forgot-password', limited, validate('json', forgotPasswordSchema), async (c) => {
  await auth.forgotPassword(authDeps(c), c.req.valid('json').email);
  return c.json({ ok: true, message: 'Si el correo existe, te enviamos instrucciones' }, 202);
});

authRoutes.post('/reset-password', limited, validate('json', resetPasswordSchema), async (c) => {
  const { token, password } = c.req.valid('json');
  await auth.resetPassword(c.get('db'), token, password);
  clearAuthCookies(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const user = await auth.getUserById(c.get('db'), c.get('user')?.id ?? '');
  if (!user || !user.isActive) {
    clearAuthCookies(c);
    return c.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Inicia sesión para continuar' } },
      401,
    );
  }
  return c.json({ user: auth.toPublicUser(user) });
});
