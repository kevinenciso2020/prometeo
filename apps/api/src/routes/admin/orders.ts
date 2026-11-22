import { Hono } from 'hono';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { orderItems, orders, payments, products } from '@prometeo/db';
import {
  ORDER_STATUS_LABELS,
  adminOrderTransitions,
  canAdminChangeOrder,
  idParamSchema,
  orderListQuerySchema,
  resolveReviewSchema,
  updateOrderStatusSchema,
} from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { orderCode, orderShipped } from '../../lib/order-emails';
import { pageInfo } from '../../lib/pagination';
import { withTransaction } from '../../lib/tx';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';
import { safeSend } from '../../services/enrollments.service';
import { issueGuestLink } from '../../services/guest-links';
import { orderEmailCtx } from '../../services/orders.service';

export const ordersRoutes = new Hono<AppEnv>();
const notFound = () => new AuthError(404, 'NOT_FOUND', 'Pedido no encontrado');

ordersRoutes.get('/', validate('query', orderListQuerySchema), async (c) => {
  const db = c.get('db');
  const { q, status, review, page, pageSize } = c.req.valid('query');
  const filters: SQL[] = [];
  if (status) filters.push(eq(orders.status, status));
  if (review) filters.push(eq(orders.needsReview, true));
  if (q) {
    const num = Number(q.replace(/\D/g, ''));
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const cond =
      Number.isInteger(num) && num > 0 && /^(pr-?)?\d+$/i.test(q)
        ? eq(orders.number, num)
        : or(ilike(orders.contactName, like), ilike(orders.contactEmail, like));
    if (cond) filters.push(cond);
  }
  const where = filters.length ? and(...filters) : undefined;
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(where);
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      total: orders.total,
      contactName: orders.contactName,
      contactEmail: orders.contactEmail,
      needsReview: orders.needsReview,
      trackingNumber: orders.trackingNumber,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return c.json({
    items: rows.map((o) => ({
      ...o,
      code: orderCode(o.number),
      statusLabel: ORDER_STATUS_LABELS[o.status],
    })),
    ...pageInfo(page, pageSize, count?.n ?? 0),
  });
});

ordersRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw notFound();
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
  const pays = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, id))
    .orderBy(desc(payments.createdAt));
  return c.json({
    item: {
      ...order,
      code: orderCode(order.number),
      statusLabel: ORDER_STATUS_LABELS[order.status],
      nextStatuses: adminOrderTransitions(order.status),
      items,
      payments: pays,
    },
  });
});

ordersRoutes.patch(
  '/:id/status',
  validate('param', idParamSchema),
  validate('json', updateOrderStatusSchema),
  async (c) => {
    const actor = c.get('user');
    const { id } = c.req.valid('param');
    const { status: to, trackingNumber } = c.req.valid('json');
    const result = await withTransaction(c.get('openPool'), async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
      if (!order) throw notFound();
      if (!canAdminChangeOrder(order.status, to)) {
        throw new AuthError(
          400,
          'INVALID_TRANSITION',
          `No se puede pasar de «${ORDER_STATUS_LABELS[order.status]}» a «${ORDER_STATUS_LABELS[to]}»`,
        );
      }
      let restocked = false;
      if (to === 'cancelado' && order.stockDeducted) {
        const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
        for (const it of items) {
          if (it.productId)
            await tx
              .update(products)
              .set({ stock: sql`${products.stock} + ${it.quantity}` })
              .where(eq(products.id, it.productId));
        }
        restocked = true;
      }
      const [updated] = await tx
        .update(orders)
        .set({
          status: to,
          trackingNumber: to === 'enviado' ? trackingNumber : order.trackingNumber,
          ...(restocked ? { stockDeducted: false } : {}),
        })
        .where(eq(orders.id, id))
        .returning();
      await writeAudit(tx, {
        actorId: actor?.id ?? null,
        action: 'order.status_change',
        entityType: 'order',
        entityId: id,
        before: { status: order.status },
        after: { status: to, trackingNumber, restocked },
      });
      if (!updated) throw new Error('No se pudo actualizar el pedido');
      return { updated, restocked };
    });
    if (to === 'enviado') {
      const db = c.get('db');
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
      const token = await issueGuestLink(db, 'order', id, result.updated.contactEmail);
      await safeSend(
        c.get('mailer'),
        orderShipped(orderEmailCtx(result.updated, items, c.env.WEB_URL, token)),
      );
    }
    return c.json({ item: result.updated, restocked: result.restocked });
  },
);

/** El admin resuelve un pedido pagado sin stock: descuenta (si hay) o lo deja sin descontar. */
ordersRoutes.post(
  '/:id/resolve-review',
  validate('param', idParamSchema),
  validate('json', resolveReviewSchema),
  async (c) => {
    const actor = c.get('user');
    const { id } = c.req.valid('param');
    const { deductStock } = c.req.valid('json');
    const updated = await withTransaction(c.get('openPool'), async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
      if (!order) throw notFound();
      if (!order.needsReview)
        throw new AuthError(400, 'NOT_IN_REVIEW', 'Este pedido no está marcado para revisión');
      if (deductStock && !order.stockDeducted) {
        const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
        const needs = new Map<string, number>();
        for (const it of items)
          if (it.productId) needs.set(it.productId, (needs.get(it.productId) ?? 0) + it.quantity);
        const ids = [...needs.keys()].sort();
        if (ids.length) {
          const rows = await tx
            .select({ id: products.id, stock: products.stock })
            .from(products)
            .where(inArray(products.id, ids))
            .orderBy(products.id)
            .for('update');
          if (
            !ids.every(
              (pid) => (rows.find((r) => r.id === pid)?.stock ?? 0) >= (needs.get(pid) ?? 0),
            )
          ) {
            throw new AuthError(
              409,
              'OUT_OF_STOCK',
              'Aún no hay stock suficiente para descontar. Repón inventario o resuelve sin descontar.',
            );
          }
          for (const pid of ids)
            await tx
              .update(products)
              .set({ stock: sql`${products.stock} - ${needs.get(pid) ?? 0}` })
              .where(eq(products.id, pid));
        }
      }
      const [row] = await tx
        .update(orders)
        .set({ needsReview: false, stockDeducted: deductStock ? true : order.stockDeducted })
        .where(eq(orders.id, id))
        .returning();
      await writeAudit(tx, {
        actorId: actor?.id ?? null,
        action: 'order.resolve_review',
        entityType: 'order',
        entityId: id,
        after: { deductStock },
      });
      return row;
    });
    return c.json({ item: updated });
  },
);
