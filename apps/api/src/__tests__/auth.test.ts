import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLogs, orders, refreshTokens, users } from '@prometeo/db';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@prometeo/shared';
import {
  cookieHeader,
  cookieValue,
  createTestContext,
  insertUser,
  setCookies,
  tokenFromEmail,
} from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
let t: Ctx;

const valid = {
  email: 'Ana@Correo.com',
  password: 'clave-segura-123',
  name: 'Ana Pérez',
  acceptDataPolicy: true,
};

beforeEach(async () => {
  t = await createTestContext();
});

describe('registro y verificación de email', () => {
  it('registra, envía correo y verifica con token de un solo uso', async () => {
    const res = await t.post('/auth/register', valid);
    expect(res.status).toBe(202);
    expect(t.outbox).toHaveLength(1);
    expect(t.outbox[0]?.to).toBe('ana@correo.com');

    const token = tokenFromEmail(t.outbox[0]);
    expect((await t.post('/auth/verify-email', { token })).status).toBe(200);
    // segundo uso del mismo token: rechazado
    expect((await t.post('/auth/verify-email', { token })).status).toBe(400);

    const [u] = await t.db.select().from(users);
    expect(u?.emailVerifiedAt).not.toBeNull();
    expect(u?.role).toBe('CLIENTE');
  });

  it('responde igual si el correo ya existe y no crea duplicados', async () => {
    await t.post('/auth/register', valid);
    const again = await t.post('/auth/register', { ...valid, email: 'ana@correo.com' });
    expect(again.status).toBe(202);
    expect(await t.db.select().from(users)).toHaveLength(1);
    expect(t.outbox).toHaveLength(1);
  });

  it('exige aceptar la política de datos y contraseña de 10+ caracteres', async () => {
    expect((await t.post('/auth/register', { ...valid, acceptDataPolicy: false })).status).toBe(
      400,
    );
    expect((await t.post('/auth/register', { ...valid, password: 'corta' })).status).toBe(400);
  });

  it('al verificar vincula pedidos de invitado con el mismo correo', async () => {
    await t.db.insert(orders).values({
      contactName: 'Ana',
      contactEmail: 'ANA@correo.com',
      contactPhone: '3000000000',
      subtotal: 1000,
      total: 1000,
    });
    await t.post('/auth/register', valid);
    await t.post('/auth/verify-email', { token: tokenFromEmail(t.outbox[0]) });
    const [o] = await t.db.select().from(orders);
    const [u] = await t.db.select().from(users);
    expect(o?.userId).toBe(u?.id);
  });
});

describe('login', () => {
  it('inicia sesión con cookies httpOnly y no expone el hash', async () => {
    await insertUser(t.db, 'ana@correo.com', 'clave-segura-123');
    const res = await t.post('/auth/login', {
      email: 'ANA@correo.com',
      password: 'clave-segura-123',
    });
    expect(res.status).toBe(200);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(2);
    for (const c of cookies) {
      expect(c).toContain('HttpOnly');
      expect(c).toContain('SameSite=Lax');
    }
    expect(cookies.find((c) => c.startsWith(REFRESH_COOKIE))).toContain('Path=/auth');
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('password');

    const me = await t.request('/auth/me', { cookies: cookieHeader(res) });
    expect(me.status).toBe(200);
  });

  it('rechaza credenciales incorrectas con el mismo error para correo inexistente', async () => {
    await insertUser(t.db, 'ana@correo.com', 'clave-segura-123');
    const bad = await t.post('/auth/login', {
      email: 'ana@correo.com',
      password: 'incorrecta-123',
    });
    const missing = await t.post('/auth/login', {
      email: 'nadie@correo.com',
      password: 'incorrecta-123',
    });
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await bad.json()).toEqual(await missing.json());
  });

  it('rechaza usuarios desactivados', async () => {
    const u = await insertUser(t.db, 'ana@correo.com', 'clave-segura-123');
    await t.db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
    expect(
      (await t.post('/auth/login', { email: 'ana@correo.com', password: 'clave-segura-123' }))
        .status,
    ).toBe(401);
  });
});

describe('refresh rotativo', () => {
  async function loggedIn() {
    await insertUser(t.db, 'ana@correo.com', 'clave-segura-123');
    return t.post('/auth/login', { email: 'ana@correo.com', password: 'clave-segura-123' });
  }

  it('rota el refresh token y guarda solo su hash', async () => {
    const login = await loggedIn();
    const rt1 = cookieValue(login, REFRESH_COOKIE) as string;
    const res = await t.post('/auth/refresh', {}, `${REFRESH_COOKIE}=${rt1}`);
    expect(res.status).toBe(200);
    const rt2 = cookieValue(res, REFRESH_COOKIE) as string;
    expect(rt2).toBeTruthy();
    expect(rt2).not.toBe(rt1);
    const rows = await t.db.select().from(refreshTokens);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.tokenHash === rt1 || r.tokenHash === rt2)).toBe(false);
  });

  it('detecta reutilización y revoca toda la familia', async () => {
    const login = await loggedIn();
    const rt1 = cookieValue(login, REFRESH_COOKIE) as string;
    const second = await t.post('/auth/refresh', {}, `${REFRESH_COOKIE}=${rt1}`);
    const rt2 = cookieValue(second, REFRESH_COOKIE) as string;

    // Un atacante reutiliza el token viejo
    expect((await t.post('/auth/refresh', {}, `${REFRESH_COOKIE}=${rt1}`)).status).toBe(401);
    // El token nuevo (legítimo) también queda revocado
    expect((await t.post('/auth/refresh', {}, `${REFRESH_COOKIE}=${rt2}`)).status).toBe(401);
    const active = await t.db
      .select()
      .from(refreshTokens)
      .where(sql`${refreshTokens.revokedAt} is null`);
    expect(active).toHaveLength(0);
  });

  it('rechaza refresh sin cookie o con token inventado', async () => {
    expect((await t.post('/auth/refresh', {})).status).toBe(401);
    expect((await t.post('/auth/refresh', {}, `${REFRESH_COOKIE}=inventado`)).status).toBe(401);
  });

  it('logout revoca el refresh token y limpia cookies', async () => {
    const login = await loggedIn();
    const rt = cookieValue(login, REFRESH_COOKIE) as string;
    const out = await t.post('/auth/logout', {}, `${REFRESH_COOKIE}=${rt}`);
    expect(out.status).toBe(200);
    expect(setCookies(out).join(' ')).toMatch(/Max-Age=0/);
    expect((await t.post('/auth/refresh', {}, `${REFRESH_COOKIE}=${rt}`)).status).toBe(401);
  });
});

describe('recuperar contraseña', () => {
  it('cambia la clave con token de un solo uso y cierra sesiones', async () => {
    await insertUser(t.db, 'ana@correo.com', 'clave-segura-123');
    const login = await t.post('/auth/login', {
      email: 'ana@correo.com',
      password: 'clave-segura-123',
    });
    const rt = cookieValue(login, REFRESH_COOKIE) as string;

    expect((await t.post('/auth/forgot-password', { email: 'ana@correo.com' })).status).toBe(202);
    expect((await t.post('/auth/forgot-password', { email: 'nadie@correo.com' })).status).toBe(202);
    expect(t.outbox).toHaveLength(1);

    const token = tokenFromEmail(t.outbox[0]);
    expect(
      (await t.post('/auth/reset-password', { token, password: 'nueva-clave-456' })).status,
    ).toBe(200);
    expect(
      (await t.post('/auth/reset-password', { token, password: 'otra-clave-789' })).status,
    ).toBe(400);

    expect((await t.post('/auth/refresh', {}, `${REFRESH_COOKIE}=${rt}`)).status).toBe(401);
    expect(
      (await t.post('/auth/login', { email: 'ana@correo.com', password: 'clave-segura-123' }))
        .status,
    ).toBe(401);
    expect(
      (await t.post('/auth/login', { email: 'ana@correo.com', password: 'nueva-clave-456' }))
        .status,
    ).toBe(200);
  });
});

describe('seguridad de la API', () => {
  it('bloquea peticiones que modifican datos con Origin ajeno (CSRF)', async () => {
    const res = await t.app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ email: 'a@b.co', password: 'x' }),
      },
      (await import('./helpers')).env,
    );
    expect(res.status).toBe(403);
  });

  it('CORS solo permite el origen del frontend', async () => {
    const ok = await t.request('/health', { headers: { Origin: 'http://localhost:4321' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:4321');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const bad = await t.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('envía cabeceras de seguridad y healthcheck responde', async () => {
    const res = await t.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
    expect(res.headers.get('referrer-policy')).toBeTruthy();
    expect(res.headers.get('permissions-policy')).toBeTruthy();
  });

  it('un token de acceso manipulado no autentica', async () => {
    expect((await t.request('/auth/me', { cookies: `${ACCESS_COOKIE}=abc.def.ghi` })).status).toBe(
      401,
    );
  });
});

describe('roles y escalamiento de privilegios', () => {
  async function login(email: string, password = 'clave-segura-123') {
    return cookieHeader(await t.post('/auth/login', { email, password }));
  }

  it('/admin exige rol ADMIN o SUPER_ADMIN en el servidor', async () => {
    await insertUser(t.db, 'cliente@correo.com', 'clave-segura-123', 'CLIENTE');
    await insertUser(t.db, 'admin@correo.com', 'clave-segura-123', 'ADMIN');
    expect((await t.request('/admin/ping')).status).toBe(401);
    expect(
      (await t.request('/admin/ping', { cookies: await login('cliente@correo.com') })).status,
    ).toBe(403);
    expect(
      (await t.request('/admin/ping', { cookies: await login('admin@correo.com') })).status,
    ).toBe(200);
  });

  it('un ADMIN no puede asignar roles; un SUPER_ADMIN sí, pero nunca a sí mismo', async () => {
    const admin = await insertUser(t.db, 'admin@correo.com', 'clave-segura-123', 'ADMIN');
    const boss = await insertUser(t.db, 'boss@correo.com', 'clave-segura-123', 'SUPER_ADMIN');
    const client = await insertUser(t.db, 'cliente@correo.com', 'clave-segura-123', 'CLIENTE');
    const patch = (id: string, role: string, cookies: string) =>
      t.request(`/admin/users/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
        cookies,
      });

    // ADMIN intentando escalarse a sí mismo o a otro
    const adminCookies = await login('admin@correo.com');
    expect((await patch(admin.id, 'SUPER_ADMIN', adminCookies)).status).toBe(403);
    expect((await patch(client.id, 'ADMIN', adminCookies)).status).toBe(403);

    const bossCookies = await login('boss@correo.com');
    expect((await patch(boss.id, 'CLIENTE', bossCookies)).status).toBe(403); // a sí mismo
    expect((await patch(client.id, 'ADMIN', bossCookies)).status).toBe(200);

    const [updated] = await t.db.select().from(users).where(eq(users.id, client.id));
    expect(updated?.role).toBe('ADMIN');
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'user.role_change')));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.actorId).toBe(boss.id);
  });
});
