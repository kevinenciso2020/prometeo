import { neon, Pool } from '@neondatabase/serverless';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzleWs } from 'drizzle-orm/neon-serverless';
import * as schema from './schema';

export * from './schema';
export { schema };

/** Tipo común a neon-http, neon-serverless y pglite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Lecturas y escrituras simples (sin transacciones). */
export function createHttpDb(databaseUrl: string): Db {
  return drizzleHttp(neon(databaseUrl), { schema });
}

/**
 * Conexión WebSocket con soporte de transacciones (cupos, stock, pagos).
 * Crear UNA por request y llamar a `close()` al terminar (p. ej. en ctx.waitUntil).
 */
export function createPoolDb(databaseUrl: string): { db: Db; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: databaseUrl });
  return { db: drizzleWs(pool, { schema }), close: () => pool.end() };
}
