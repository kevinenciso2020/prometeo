import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { coupons } from './coupons';
import { enrollments } from './courses';
import { campaignEventTypeEnum, campaignPlacementEnum, campaignTargetEnum } from './enums';
import { createdAt, id, tstz, updatedAt } from './helpers';
import { orders } from './orders';

export const campaigns = pgTable(
  'campaigns',
  {
    id: id(),
    name: varchar('name', { length: 160 }).notNull(),
    placement: campaignPlacementEnum('placement').notNull(),
    imageDesktopUrl: text('image_desktop_url'),
    imageDesktopPublicId: text('image_desktop_public_id'),
    imageMobileUrl: text('image_mobile_url'),
    imageMobilePublicId: text('image_mobile_public_id'),
    title: varchar('title', { length: 200 }),
    text: text('text'),
    ctaText: varchar('cta_text', { length: 60 }),
    ctaUrl: text('cta_url'),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    priority: integer('priority').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    /** Rutas donde se muestra; vacío = todas. */
    pages: text('pages')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    popupFrequencyHours: integer('popup_frequency_hours').notNull().default(24),
    targetType: campaignTargetEnum('target_type'),
    targetId: uuid('target_id'),
    couponId: uuid('coupon_id').references(() => coupons.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('campaigns_range_chk', sql`${t.endsAt} > ${t.startsAt}`),
    check('campaigns_target_chk', sql`(${t.targetType} IS NULL) = (${t.targetId} IS NULL)`),
    index('campaigns_active_idx').on(t.placement, t.isActive, t.startsAt, t.endsAt),
  ],
);

/** Contadores diarios agregados (sin datos personales ni cookies). */
export const campaignEvents = pgTable(
  'campaign_events',
  {
    id: id(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    type: campaignEventTypeEnum('type').notNull(),
    day: date('day').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [unique('campaign_events_uq').on(t.campaignId, t.type, t.day)],
);

/** Solo se inserta cuando el pago se aprueba. */
export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: id(),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => coupons.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    enrollmentId: uuid('enrollment_id').references(() => enrollments.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 254 }).notNull(),
    discountAmount: integer('discount_amount').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('coupon_redemptions_ref_chk', sql`(${t.orderId} IS NULL) <> (${t.enrollmentId} IS NULL)`),
    unique('coupon_redemptions_order_uq').on(t.couponId, t.orderId),
    unique('coupon_redemptions_enrollment_uq').on(t.couponId, t.enrollmentId),
    index('coupon_redemptions_email_idx').on(t.couponId, sql`lower(${t.email})`),
  ],
);
