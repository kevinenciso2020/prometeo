import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppEnv } from '../env';

export const health = new Hono<AppEnv>();

health.get('/', async (c) => {
  let dbOk = false;
  try {
    await c.get('db').execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return c.json(
    { status: dbOk ? 'ok' : 'degraded', db: dbOk, time: new Date().toISOString() },
    dbOk ? 200 : 503,
  );
});
