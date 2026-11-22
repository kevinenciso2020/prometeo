import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { schema, users, type Db } from '@prometeo/db';
import { hashPassword, type Role } from '@prometeo/shared';
import { createApp } from '../index';
import type { Bindings } from '../env';
import type { Email, Mailer } from '../lib/mailer';

export const ORIGIN = 'http://localhost:4321';

export const env: Bindings = {
  DATABASE_URL: 'unused',
  JWT_SECRET: 'secreto-de-pruebas-suficientemente-largo-123456',
  ENVIRONMENT: 'test',
  WEB_ORIGIN: ORIGIN,
  WEB_URL: ORIGIN,
  EMAIL_FROM: 'Prometeo <test@prometeo.local>',
};

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

export async function createTestContext() {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client, { schema }), { migrationsFolder });
  const outbox: Email[] = [];
  const mailer: Mailer = { send: async (e) => void outbox.push(e) };
  const app = createApp({ getDb: () => db, getMailer: () => mailer });

  let ipCounter = 0;
  const request = (path: string, init: RequestInit & { cookies?: string } = {}) => {
    const { cookies, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (rest.method && rest.method !== 'GET') headers.set('Origin', ORIGIN);
    if (rest.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    headers.set('cf-connecting-ip', `10.0.0.${++ipCounter % 250}`);
    if (cookies) headers.set('Cookie', cookies);
    return app.request(path, { ...rest, headers }, env);
  };
  const post = (path: string, body: unknown, cookies?: string) =>
    request(path, { method: 'POST', body: JSON.stringify(body), cookies });

  return { db, app, outbox, request, post };
}

export function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

/** Convierte los Set-Cookie de una respuesta en un header Cookie. */
export function cookieHeader(res: Response): string {
  return setCookies(res)
    .map((c) => c.split(';')[0] ?? '')
    .filter((c) => !c.endsWith('='))
    .join('; ');
}

export function cookieValue(res: Response, name: string): string | undefined {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
  return line?.split(';')[0]?.slice(name.length + 1);
}

export async function insertUser(
  db: Db,
  email: string,
  password: string,
  role: Role = 'CLIENTE',
  verified = true,
) {
  const [u] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(password),
      name: 'Usuario Prueba',
      role,
      emailVerifiedAt: verified ? new Date() : null,
    })
    .returning();
  if (!u) throw new Error('no se creó el usuario');
  return u;
}

export function tokenFromEmail(e: Email | undefined): string {
  const m = e?.text.match(/token=([\w-]+)/);
  if (!m?.[1]) throw new Error('el correo no trae token');
  return m[1];
}
