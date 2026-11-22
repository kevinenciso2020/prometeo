import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { courseEditions, courses, enrollments, orders } from '@prometeo/db';
import { ORDER_STATUS_LABELS } from '@prometeo/shared';
import type { AppEnv } from '../env';
import { orderCode } from '../lib/order-emails';
import { validate } from '../lib/validate';
import { requireAuth } from '../middleware/auth';
import { AuthError } from '../services/auth.service';
import { issueGuestLink } from '../services/guest-links';

/** "Mi cuenta": historial de pedidos e inscripciones del cliente autenticado. */
export const accountRoutes = new Hono<AppEnv>();
accountRoutes.use('*', requireAuth);

accountRoutes.get('/summary', async (c) => {
  const db = c.get('db');
  const userId = c.get('user')?.id ?? '';
  const myOrders = await db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      total: orders.total,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(100);
  const myEnrollments = await db
    .select({
      id: enrollments.id,
      status: enrollments.status,
      totalAmount: enrollments.totalAmount,
      paidAmount: enrollments.paidAmount,
      courseName: courses.name,
      createdAt: enrollments.createdAt,
      firstStart: sql<
        string | null
      >`(select min(s.starts_at) from edition_sessions s where s.edition_id = "enrollments"."edition_id")`,
    })
    .from(enrollments)
    .innerJoin(courseEditions, eq(courseEditions.id, enrollments.editionId))
    .innerJoin(courses, eq(courses.id, courseEditions.courseId))
    .where(eq(enrollments.userId, userId))
    .orderBy(desc(enrollments.createdAt))
    .limit(100);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    orders: myOrders.map((o) => ({
      ...o,
      code: orderCode(o.number),
      statusLabel: ORDER_STATUS_LABELS[o.status],
    })),
    enrollments: myEnrollments,
  });
});

const linkSchema = z.object({ type: z.enum(['order', 'enrollment']), id: z.uuid() });

/** Genera un enlace seguro para abrir el detalle de un pedido/inscripción propio. */
accountRoutes.post('/links', validate('json', linkSchema), async (c) => {
  const db = c.get('db');
  const userId = c.get('user')?.id ?? '';
  const { type, id } = c.req.valid('json');
  if (type === 'order') {
    const [o] = await db
      .select({ email: orders.contactEmail })
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.userId, userId)))
      .limit(1);
    if (!o) throw new AuthError(404, 'NOT_FOUND', 'Pedido no encontrado');
    return c.json({ token: await issueGuestLink(db, 'order', id, o.email) });
  }
  const [e] = await db
    .select({ email: enrollments.contactEmail })
    .from(enrollments)
    .where(and(eq(enrollments.id, id), eq(enrollments.userId, userId)))
    .limit(1);
  if (!e) throw new AuthError(404, 'NOT_FOUND', 'Inscripción no encontrada');
  return c.json({ token: await issueGuestLink(db, 'enrollment', id, e.email) });
});
