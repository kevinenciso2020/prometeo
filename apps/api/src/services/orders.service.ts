import { and, eq, inArray } from 'drizzle-orm';
import { orderItems, orders, payments, products, services, type Db } from '@prometeo/db';
import { getDepartment, getMunicipality, type CheckoutOrderInput } from '@prometeo/shared';
import type { Bindings } from '../env';
import { randomHex } from '../lib/random';
import { orderCode, type OrderEmailCtx } from '../lib/order-emails';
import { withTransaction, type PoolOpener } from '../lib/tx';
import { AuthError } from './auth.service';
import { priceCart, summarizeCart } from './cart';
import { issueGuestLink } from './guest-links';
import type { LoadedSettings } from './settings';
import { buildWompiCheckout } from '../lib/wompi';

type Order = typeof orders.$inferSelect;
type Payment = typeof payments.$inferSelect;

export interface ShippingSnapshot {
  departmentCode: string;
  departmentName: string;
  municipalityCode: string;
  municipalityName: string;
  address: string;
  neighborhood: string | null;
  notes: string | null;
}

export const orderReference = (number: number) => `ORD-${number}-${randomHex(5)}`;

/** Crea el pedido en estado pendiente_pago + su pago pendiente. Valida precios y stock desde la BD. */
export async function createOrder(
  open: PoolOpener,
  input: CheckoutOrderInput,
  userId: string | null,
  settings: LoadedSettings,
): Promise<{ order: Order; payment: Payment; token: string }> {
  return withTransaction(open, async (tx) => {
    const lines = await priceCart(tx, input.items);
    const bad = lines.filter((l) => !l.available);
    if (bad.length > 0) {
      const detail = bad
        .map((l) => `${l.name ?? 'Un producto'}: ${l.reason ?? 'no disponible'}`)
        .join(' · ');
      throw new AuthError(
        409,
        'CART_UNAVAILABLE',
        `Hay productos no disponibles en tu carrito (${detail})`,
      );
    }
    const { subtotal, shipping, total, hasShippable } = summarizeCart(lines, settings);
    if (hasShippable && !input.shipping)
      throw new AuthError(400, 'SHIPPING_REQUIRED', 'Ingresa la dirección de envío');
    if (total <= 0) throw new AuthError(400, 'EMPTY_ORDER', 'El pedido no tiene valor a pagar');

    let address: ShippingSnapshot | null = null;
    if (hasShippable && input.shipping) {
      const dep = getDepartment(input.shipping.departmentCode);
      const mun = getMunicipality(input.shipping.departmentCode, input.shipping.municipalityCode);
      if (!dep || !mun)
        throw new AuthError(400, 'INVALID_LOCATION', 'Departamento o municipio inválido');
      address = {
        departmentCode: dep.code,
        departmentName: dep.name,
        municipalityCode: mun.code,
        municipalityName: mun.name,
        address: input.shipping.address,
        neighborhood: input.shipping.neighborhood,
        notes: input.shipping.notes,
      };
    }

    const [order] = await tx
      .insert(orders)
      .values({
        userId,
        contactName: input.name,
        contactEmail: input.email,
        contactPhone: input.phone,
        contactDocument: input.document,
        subtotal,
        discountTotal: 0,
        shippingTotal: shipping,
        total,
        shippingAddress: address,
      })
      .returning();
    if (!order) throw new Error('No se pudo crear el pedido');

    await tx.insert(orderItems).values(
      lines.map((l) => ({
        orderId: order.id,
        itemType: l.type,
        productId: l.type === 'product' ? l.id : null,
        serviceId: l.type === 'service' ? l.id : null,
        nameSnapshot: l.name ?? '',
        unitPrice: l.unitPrice ?? 0,
        quantity: l.quantity ?? 1,
        lineTotal: l.lineTotal ?? 0,
      })),
    );
    const [payment] = await tx
      .insert(payments)
      .values({
        kind: 'order',
        orderId: order.id,
        purpose: 'total',
        amount: total,
        method: 'wompi',
        status: 'pendiente',
        reference: orderReference(order.number),
      })
      .returning();
    if (!payment) throw new Error('No se pudo crear el pago');
    const token = await issueGuestLink(tx, 'order', order.id, order.contactEmail);
    return { order, payment, token };
  });
}

export async function loadOrderWithItems(db: Db, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  return { order, items };
}

export function orderEmailCtx(
  order: Order,
  items: { nameSnapshot: string; quantity: number; lineTotal: number }[],
  webUrl: string,
  token: string,
): OrderEmailCtx {
  return {
    to: order.contactEmail,
    name: order.contactName,
    number: order.number,
    items: items.map((i) => ({
      name: i.nameSnapshot,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
    })),
    subtotal: order.subtotal,
    shipping: order.shippingTotal,
    total: order.total,
    statusUrl: `${webUrl}/pedido/${token}`,
    trackingNumber: order.trackingNumber,
    status: order.status,
  };
}

/** Reintento de pago de un pedido pendiente: revalida stock y crea un pago nuevo. */
export async function createRetryPayment(db: Db, order: Order): Promise<Payment> {
  if (order.status !== 'pendiente_pago')
    throw new AuthError(409, 'NOT_PAYABLE', 'Este pedido ya no está pendiente de pago');
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const productIds = items.filter((i) => i.productId).map((i) => i.productId as string);
  if (productIds.length) {
    const stock = await db
      .select({ id: products.id, stock: products.stock, status: products.status })
      .from(products)
      .where(inArray(products.id, productIds));
    for (const it of items) {
      const p = stock.find((s) => s.id === it.productId);
      if (it.productId && (!p || p.status !== 'publicado' || p.stock < it.quantity)) {
        throw new AuthError(
          409,
          'OUT_OF_STOCK',
          `"${it.nameSnapshot}" ya no tiene stock suficiente`,
        );
      }
    }
  }
  const serviceIds = items.filter((i) => i.serviceId).map((i) => i.serviceId as string);
  if (serviceIds.length) {
    const live = await db
      .select({ id: services.id })
      .from(services)
      .where(and(inArray(services.id, serviceIds), eq(services.status, 'publicado')));
    if (live.length !== new Set(serviceIds).size)
      throw new AuthError(409, 'NOT_AVAILABLE', 'Un servicio de tu pedido ya no está disponible');
  }
  const [payment] = await db
    .insert(payments)
    .values({
      kind: 'order',
      orderId: order.id,
      purpose: 'total',
      amount: order.total,
      method: 'wompi',
      status: 'pendiente',
      reference: orderReference(order.number),
    })
    .returning();
  if (!payment) throw new Error('No se pudo crear el pago');
  return payment;
}

export async function checkoutFor(
  env: Bindings,
  payment: Payment,
  token: string,
  c: { name: string; email: string; phone: string },
) {
  return buildWompiCheckout(env, {
    reference: payment.reference,
    amount: payment.amount,
    // Wompi agrega ?id=<transacción> a esta URL; por eso no lleva query propia.
    redirectUrl: `${env.WEB_URL}/pago/resultado/${payment.reference}/${token}`,
    email: c.email,
    fullName: c.name,
    phone: c.phone,
  });
}

export { orderCode };
