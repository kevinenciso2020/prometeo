import { Hono, type Context } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { enrollments, orderItems, orders, payments, users } from '@prometeo/db';
import {
  ORDER_STATUS_LABELS,
  checkoutOrderSchema,
  payEnrollmentSchema,
  referenceParamSchema,
  tokenParamSchema,
} from '@prometeo/shared';
import type { AppEnv } from '../env';
import { orderCode, orderReceived } from '../lib/order-emails';
import { optionalUser } from '../lib/optional-user';
import { validate } from '../lib/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AuthError } from '../services/auth.service';
import { safeSend } from '../services/enrollments.service';
import { resolveGuestLink } from '../services/guest-links';
import {
  checkoutFor,
  createOrder,
  createRetryPayment,
  orderEmailCtx,
} from '../services/orders.service';
import { createEnrollmentPayment, paymentStatus } from '../services/payments.service';
import { loadSettings } from '../services/settings';

export const publicOrderRoutes = new Hono<AppEnv>();

const noStore = (c: Context<AppEnv>) => c.header('Cache-Control', 'private, no-store');

/** Checkout de productos y servicios: crea el pedido (pendiente) y la URL firmada de Wompi. */
publicOrderRoutes.post(
  '/checkout/order',
  rateLimit('RL_PUBLIC', 'checkout'),
  validate('json', checkoutOrderSchema),
  async (c) => {
    const input = c.req.valid('json');
    if (input.website) return c.json({ ok: true }, 201); // honeypot
    const db = c.get('db');

    let userId: string | null = null;
    const session = await optionalUser(c);
    if (session) {
      const [u] = await db
        .select({ id: users.id, email: users.email, verified: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, session.id))
        .limit(1);
      if (u && u.verified && u.email.toLowerCase() === input.email) userId = u.id;
    }

    const settings = await loadSettings(db);
    const { order, payment, token } = await createOrder(c.get('openPool'), input, userId, settings);
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    await safeSend(
      c.get('mailer'),
      orderReceived(orderEmailCtx(order, items, c.env.WEB_URL, token)),
    );
    const checkout = await checkoutFor(c.env, payment, token, {
      name: order.contactName,
      email: order.contactEmail,
      phone: order.contactPhone,
    });
    return c.json(
      {
        order: {
          number: order.number,
          code: orderCode(order.number),
          status: order.status,
          total: order.total,
          shipping: order.shippingTotal,
        },
        reference: payment.reference,
        token,
        checkoutUrl: checkout.url,
        statusUrl: `${c.env.WEB_URL}/pedido/${token}`,
      },
      201,
    );
  },
);

async function orderByToken(c: Context<AppEnv>, token: string) {
  const db = c.get('db');
  const id = await resolveGuestLink(db, 'order', token);
  if (!id) throw new AuthError(404, 'NOT_FOUND', 'El enlace no es válido o venció');
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw new AuthError(404, 'NOT_FOUND', 'Pedido no encontrado');
  return order;
}

publicOrderRoutes.get(
  '/orders/:token',
  rateLimit('RL_PUBLIC', 'order-status'),
  validate('param', tokenParamSchema),
  async (c) => {
    const db = c.get('db');
    const order = await orderByToken(c, c.req.valid('param').token);
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const [last] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    noStore(c);
    return c.json({
      order: {
        number: order.number,
        code: orderCode(order.number),
        status: order.status,
        statusLabel: ORDER_STATUS_LABELS[order.status],
        subtotal: order.subtotal,
        shippingTotal: order.shippingTotal,
        total: order.total,
        trackingNumber: order.trackingNumber,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        name: order.contactName,
        shippingAddress: order.shippingAddress,
        payable: order.status === 'pendiente_pago',
        lastPaymentStatus: last?.status ?? null,
      },
      items: items.map((i) => ({
        name: i.nameSnapshot,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
      })),
    });
  },
);

/** Reintentar el pago de un pedido pendiente (p. ej. tras un rechazo). */
publicOrderRoutes.post(
  '/orders/:token/pay',
  rateLimit('RL_PUBLIC', 'order-pay'),
  validate('param', tokenParamSchema),
  async (c) => {
    const { token } = c.req.valid('param');
    const order = await orderByToken(c, token);
    const payment = await createRetryPayment(c.get('db'), order);
    const checkout = await checkoutFor(c.env, payment, token, {
      name: order.contactName,
      email: order.contactEmail,
      phone: order.contactPhone,
    });
    return c.json({ checkoutUrl: checkout.url, reference: payment.reference });
  },
);

/** Pago en línea de una inscripción: total, abono o saldo. */
publicOrderRoutes.post(
  '/enrollments/:token/pay',
  rateLimit('RL_PUBLIC', 'enroll-pay'),
  validate('param', tokenParamSchema),
  validate('json', payEnrollmentSchema),
  async (c) => {
    const { token } = c.req.valid('param');
    const db = c.get('db');
    const id = await resolveGuestLink(db, 'enrollment', token);
    if (!id) throw new AuthError(404, 'NOT_FOUND', 'El enlace no es válido o venció');
    const [e] = await db.select().from(enrollments).where(eq(enrollments.id, id)).limit(1);
    if (!e) throw new AuthError(404, 'NOT_FOUND', 'Inscripción no encontrada');
    const { payment, checkout } = await createEnrollmentPayment(
      db,
      c.env,
      e,
      token,
      c.req.valid('json').type,
    );
    return c.json({
      checkoutUrl: checkout.url,
      reference: payment.reference,
      amount: payment.amount,
      purpose: payment.purpose,
    });
  },
);

/** Estado de un pago por referencia (la página de resultado consulta esto; la verdad la fija el webhook). */
publicOrderRoutes.get(
  '/payments/:reference',
  rateLimit('RL_PUBLIC', 'payment-status'),
  validate('param', referenceParamSchema),
  async (c) => {
    const p = await paymentStatus(c.get('db'), c.req.valid('param').reference);
    if (!p) throw new AuthError(404, 'NOT_FOUND', 'Pago no encontrado');
    noStore(c);
    return c.json({ payment: p });
  },
);
