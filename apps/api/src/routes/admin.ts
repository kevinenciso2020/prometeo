import { Hono } from 'hono';
import { z } from 'zod';
import { setRoleSchema } from '@prometeo/shared';
import type { AppEnv } from '../env';
import { validate } from '../lib/validate';
import { requireRole } from '../middleware/auth';
import { setUserRole } from '../services/users.service';

/** Todas las rutas /admin/* exigen rol ADMIN o SUPER_ADMIN en el servidor. */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireRole('ADMIN', 'SUPER_ADMIN'));

adminRoutes.get('/ping', (c) => c.json({ ok: true, role: c.get('user')?.role }));

adminRoutes.patch(
  '/users/:id/role',
  requireRole('SUPER_ADMIN'),
  validate('param', z.object({ id: z.uuid() })),
  validate('json', setRoleSchema),
  async (c) => {
    const actor = c.get('user');
    if (!actor)
      return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Inicia sesión' } }, 401);
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
