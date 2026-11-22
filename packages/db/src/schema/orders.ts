import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { coupons } from './coupons';
import { enrollments } from './courses';
import { services, products } from './catalog';
import {
  orderItemTypeEnum,
  orderStatusEnum,
  paymentKindEnum,
  paymentMethodEnum,
  paymentPurposeEnum,
  paymentStatusEnum,
} from './enums';
import { createdAt, id, tstz, updatedAt } from './helpers';
import { users } from './users';

export const orders = pgTable(
  'orders',
  {
    id: id(),
    /** Número legible secuencial (se muestra como PR-000123). */
    number: integer('number').notNull().unique().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    contactName: varchar('contact_name', { length: 120 }).notNull(),
    contactEmail: varchar('contact_email', { length: 254 }).notNull(),
    contactPhone: varchar('contact_phone', { length: 20 }).notNull(),
    contactDocument: varchar('contact_document', { length: 30 }),
    status: orderStatusEnum('status').notNull().default('pendiente_pago'),
    subtotal: integer('subtotal').notNull(),
    discountTotal: integer('discount_total').notNull().default(0),
    shippingTotal: integer('shipping_total').notNull().default(0),
    total: integer('total').notNull(),
    couponId: uuid('coupon_id').references(() => coupons.id, { onDelete: 'set null' }),
    /** { departamento, municipio, codigoDane, direccion, barrio?, notas? } — sin envío para servicios. */
    shippingAddress: jsonb('shipping_address'),
    trackingNumber: varchar('tracking_number', { length: 80 }),
    /** Pagado pero sin stock al confirmar: requiere revisión del admin. */
    needsReview: boolean('needs_review').notNull().default(false),
    paidAt: tstz('paid_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'orders_amounts_chk',
      sql`${t.subtotal} >= 0 AND ${t.discountTotal} >= 0 AND ${t.shippingTotal} >= 0 AND ${t.total} >= 0`,
    ),
    index('orders_user_idx').on(t.userId),
    index('orders_email_idx').on(sql`lower(${t.contactEmail})`),
    index('orders_status_idx').on(t.status),
    index('orders_created_idx').on(t.createdAt),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    itemType: orderItemTypeEnum('item_type').notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'restrict' }),
    nameSnapshot: varchar('name_snapshot', { length: 200 }).notNull(),
    unitPrice: integer('unit_price').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotal: integer('line_total').notNull(),
  },
  (t) => [
    check('order_items_qty_chk', sql`${t.quantity} > 0 AND ${t.unitPrice} >= 0`),
    check('order_items_ref_chk', sql`(${t.productId} IS NULL) <> (${t.serviceId} IS NULL)`),
    index('order_items_order_idx').on(t.orderId),
  ],
);

/**
 * Pagos polimórficos: un pago pertenece a UNA orden o a UNA inscripción (CHECK + FKs reales).
 * Una sola tabla => una referencia única y un solo flujo de webhook/idempotencia.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    kind: paymentKindEnum('kind').notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'restrict' }),
    purpose: paymentPurposeEnum('purpose').notNull(),
    amount: integer('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('COP'),
    method: paymentMethodEnum('method').notNull().default('wompi'),
    status: paymentStatusEnum('status').notNull().default('pendiente'),
    reference: varchar('reference', { length: 80 }).notNull().unique(),
    wompiTransactionId: varchar('wompi_transaction_id', { length: 80 }).unique(),
    wompiRaw: jsonb('wompi_raw'),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    paidAt: tstz('paid_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('payments_amount_chk', sql`${t.amount} > 0`),
    check('payments_currency_chk', sql`${t.currency} = 'COP'`),
    check(
      'payments_subject_chk',
      sql`(${t.kind} = 'order' AND ${t.orderId} IS NOT NULL AND ${t.enrollmentId} IS NULL)
        OR (${t.kind} = 'enrollment' AND ${t.enrollmentId} IS NOT NULL AND ${t.orderId} IS NULL)`,
    ),
    index('payments_order_idx').on(t.orderId),
    index('payments_enrollment_idx').on(t.enrollmentId),
    index('payments_status_idx').on(t.status),
  ],
);

/** Idempotencia de webhooks: (provider, event_id) único. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    provider: varchar('provider', { length: 30 }).notNull(),
    eventId: varchar('event_id', { length: 120 }).notNull(),
    payload: jsonb('payload').notNull(),
    processedAt: tstz('processed_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('webhook_events_provider_event_uq').on(t.provider, t.eventId)],
);
