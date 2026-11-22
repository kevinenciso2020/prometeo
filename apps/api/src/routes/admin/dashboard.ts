import { Hono } from 'hono';
import { desc, eq, gte, sql } from 'drizzle-orm';
import { auditLogs, courseEditions, enrollments, orders, payments, users } from '@prometeo/db';
import type { AppEnv } from '../../env';

export const dashboardRoutes = new Hono<AppEnv>();

const DAYS = 30;

/** Resumen operativo: ventas aprobadas, pedidos por estado, inscripciones, alertas y auditoría reciente. */
dashboardRoutes.get('/', async (c) => {
  const db = c.get('db');
  const since = new Date(Date.now() - DAYS * 86_400_000);

  const [sales] = await db
    .select({
      total: sql<number>`coalesce(sum(${payments.amount}), 0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(sql`${payments.status} = 'aprobado' AND ${payments.paidAt} >= ${since}`);

  const salesByKind = await db
    .select({ kind: payments.kind, total: sql<number>`coalesce(sum(${payments.amount}), 0)::int` })
    .from(payments)
    .where(sql`${payments.status} = 'aprobado' AND ${payments.paidAt} >= ${since}`)
    .groupBy(payments.kind);

  const ordersByStatus = await db
    .select({ status: orders.status, n: sql<number>`count(*)::int` })
    .from(orders)
    .groupBy(orders.status);

  const [needsReview] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.needsReview, true));

  const enrollmentsByStatus = await db
    .select({ status: enrollments.status, n: sql<number>`count(*)::int` })
    .from(enrollments)
    .groupBy(enrollments.status);

  const [openEditions] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(courseEditions)
    .where(eq(courseEditions.status, 'abierta'));

  const [newCustomers] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(gte(users.createdAt, since));

  const recentAudit = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(10);

  return c.json({
    days: DAYS,
    sales: {
      total: sales?.total ?? 0,
      payments: sales?.count ?? 0,
      byKind: Object.fromEntries(salesByKind.map((r) => [r.kind, r.total])),
    },
    orders: {
      byStatus: Object.fromEntries(ordersByStatus.map((r) => [r.status, r.n])),
      needsReview: needsReview?.n ?? 0,
    },
    enrollments: {
      byStatus: Object.fromEntries(enrollmentsByStatus.map((r) => [r.status, r.n])),
      openEditions: openEditions?.n ?? 0,
    },
    newCustomers: newCustomers?.n ?? 0,
    recentAudit,
  });
});
