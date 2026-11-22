import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { couponScopeEnum, couponTypeEnum } from './enums';
import { createdAt, id, tstz, updatedAt } from './helpers';

export const coupons = pgTable(
  'coupons',
  {
    id: id(),
    code: varchar('code', { length: 40 }),
    type: couponTypeEnum('type').notNull(),
    value: integer('value').notNull().default(0),
    appliesTo: couponScopeEnum('applies_to').notNull().default('todo'),
    targetIds: uuid('target_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    minPurchase: integer('min_purchase').notNull().default(0),
    startsAt: tstz('starts_at'),
    endsAt: tstz('ends_at'),
    maxUses: integer('max_uses'),
    maxUsesPerEmail: integer('max_uses_per_email'),
    /** Descuento automático (sin código). */
    isAutomatic: boolean('is_automatic').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('coupons_code_lower_uq').on(sql`lower(${t.code})`),
    check('coupons_value_chk', sql`${t.value} >= 0`),
    check('coupons_pct_chk', sql`${t.type} <> 'porcentaje' OR ${t.value} BETWEEN 1 AND 100`),
    // Un cupón con código no es automático y viceversa.
    check(
      'coupons_code_auto_chk',
      sql`(${t.isAutomatic} AND ${t.code} IS NULL) OR (NOT ${t.isAutomatic} AND ${t.code} IS NOT NULL)`,
    ),
  ],
);
