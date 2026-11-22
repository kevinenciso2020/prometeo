import { Hono } from 'hono';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { quoteRequests, services } from '@prometeo/db';
import { idParamSchema, quoteStatusSchema } from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';

/** Solicitudes de cotización y mensajes de contacto (nueva / contactada / cerrada). */
export const quotesRoutes = new Hono<AppEnv>();

quotesRoutes.get(
  '/',
  validate('query', z.object({ status: z.enum(['nueva', 'contactada', 'cerrada']).optional() })),
  async (c) => {
    const { status } = c.req.valid('query');
    const rows = await c
      .get('db')
      .select({
        id: quoteRequests.id,
        name: quoteRequests.name,
        email: quoteRequests.email,
        phone: quoteRequests.phone,
        desiredDate: quoteRequests.desiredDate,
        details: quoteRequests.details,
        status: quoteRequests.status,
        createdAt: quoteRequests.createdAt,
        serviceName: services.name,
      })
      .from(quoteRequests)
      .leftJoin(services, eq(services.id, quoteRequests.serviceId))
      .where(status ? eq(quoteRequests.status, status) : undefined)
      .orderBy(desc(quoteRequests.createdAt))
      .limit(200);
    return c.json({ items: rows });
  },
);

quotesRoutes.patch(
  '/:id',
  validate('param', idParamSchema),
  validate('json', quoteStatusSchema),
  async (c) => {
    const [row] = await c
      .get('db')
      .update(quoteRequests)
      .set({ status: c.req.valid('json').status })
      .where(eq(quoteRequests.id, c.req.valid('param').id))
      .returning();
    if (!row) throw new AuthError(404, 'NOT_FOUND', 'Solicitud no encontrada');
    return c.json({ item: row });
  },
);
