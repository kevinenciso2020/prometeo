import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings } from '../env';

type LimiterName = 'RL_AUTH' | 'RL_PUBLIC';

// Respaldo en memoria solo para desarrollo/tests (por isolate; en producción se usa el binding).
const hits = new Map<string, { count: number; resetAt: number }>();
const FALLBACK_LIMIT = 60;
const FALLBACK_WINDOW_MS = 60_000;

function memoryAllow(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + FALLBACK_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= FALLBACK_LIMIT;
}

export function rateLimit(limiter: LimiterName, scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') ?? 'local';
    const key = `${scope}:${ip}`;
    const binding = (c.env as Bindings)[limiter];
    const allowed = binding ? (await binding.limit({ key })).success : memoryAllow(key);
    if (!allowed) {
      c.header('Retry-After', '60');
      return c.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Demasiados intentos. Intenta de nuevo en un minuto',
          },
        },
        429,
      );
    }
    return next();
  };
}
