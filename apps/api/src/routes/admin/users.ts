import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { users } from '@prometeo/db';
import {
  ADMIN_ROLES,
  createAdminSchema,
  hashPassword,
  idParamSchema,
  setActiveSchema,
  setRoleSchema,
} from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { validate } from '../../lib/validate';
import { requireRole } from '../../middleware/auth';
import { AuthError } from '../../services/auth.service';
import { setUserRole } from '../../services/users.service';

/** Gestión de administradores: solo SUPER_ADMIN. */
export const usersRoutes = new Hono<AppEnv>();

usersRoutes.use('*', requireRole('SUPER_ADMIN'));

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  onlyAdmins: z.enum(['true', 'false']).default('true'),
});

const publicCols = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
  emailVerifiedAt: users.emailVerifiedAt,
  createdAt: users.createdAt,
};

usersRoutes.get('/', validate('query', listSchema), async (c) => {
  const { q, onlyAdmins } = c.req.valid('query');
  const filters: SQL[] = [];
  if (onlyAdmins === 'true') filters.push(inArray(users.role, [...ADMIN_ROLES]));
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const cond = or(ilike(users.email, like), ilike(users.name, like));
    if (cond) filters.push(cond);
  }
  const rows = await c
    .get('db')
    .select(publicCols)
    .from(users)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(users.createdAt))
    .limit(200);
  return c.json({ items: rows });
});

/** Crea un administrador (rol ADMIN) con correo ya verificado. */
usersRoutes.post('/', validate('json', createAdminSchema), async (c) => {
  const db = c.get('db');
  const input = c.req.valid('json');
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email}`)
    .limit(1);
  if (existing) throw new AuthError(400, 'DUPLICATE', 'Ya existe un usuario con ese correo');
  const [row] = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
    })
    .returning(publicCols);
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'user.create_admin',
    entityType: 'user',
    entityId: row?.id,
    after: { email: input.email, role: 'ADMIN' },
    ip: c.req.header('cf-connecting-ip'),
  });
  return c.json({ item: row }, 201);
});

usersRoutes.patch(
  '/:id/role',
  validate('param', idParamSchema),
  validate('json', setRoleSchema),
  async (c) => {
    const actor = c.get('user');
    if (!actor) throw new AuthError(401, 'UNAUTHENTICATED', 'Inicia sesión');
    await setUserRole(
      c.get('db'),
      actor,
      c.req.valid('param').id,
      c.req.valid('json').role,
      c.req.header('cf-connecting-ip'),
    );
    return c.json({ ok: true });
  },
);

usersRoutes.patch(
  '/:id/active',
  validate('param', idParamSchema),
  validate('json', setActiveSchema),
  async (c) => {
    const db = c.get('db');
    const actor = c.get('user');
    const { id } = c.req.valid('param');
    const { isActive } = c.req.valid('json');
    if (!actor || actor.id === id)
      throw new AuthError(403, 'SELF_CHANGE', 'No puedes desactivar tu propia cuenta');
    const [row] = await db
      .update(users)
      .set({ isActive })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!row) throw new AuthError(404, 'NOT_FOUND', 'Usuario no encontrado');
    await writeAudit(db, {
      actorId: actor.id,
      action: isActive ? 'user.activate' : 'user.deactivate',
      entityType: 'user',
      entityId: id,
    });
    return c.json({ ok: true });
  },
);
