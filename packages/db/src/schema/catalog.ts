import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { contentStatusEnum, quoteStatusEnum, serviceModeEnum } from './enums';
import { createdAt, id, tstz, updatedAt } from './helpers';

export const categories = pgTable('categories', {
  id: id(),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 140 }).notNull().unique(),
  description: text('description'),
  imageUrl: text('image_url'),
  imagePublicId: text('image_public_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const products = pgTable(
  'products',
  {
    id: id(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 220 }).notNull().unique(),
    description: text('description').notNull().default(''),
    price: integer('price').notNull(),
    compareAtPrice: integer('compare_at_price'),
    stock: integer('stock').notNull().default(0),
    sku: varchar('sku', { length: 60 }).unique(),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    weightGrams: integer('weight_grams'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    depthMm: integer('depth_mm'),
    materials: text('materials'),
    status: contentStatusEnum('status').notNull().default('borrador'),
    isUnique: boolean('is_unique').notNull().default(false),
    isFeatured: boolean('is_featured').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('products_price_chk', sql`${t.price} >= 0`),
    check('products_stock_chk', sql`${t.stock} >= 0`),
    check('products_compare_chk', sql`${t.compareAtPrice} IS NULL OR ${t.compareAtPrice} >= 0`),
    index('products_category_idx').on(t.categoryId),
    index('products_status_idx').on(t.status),
    index('products_featured_idx').on(t.isFeatured),
    index('products_search_idx').using(
      'gin',
      sql`to_tsvector('spanish', ${t.name} || ' ' || ${t.description})`,
    ),
  ],
);

export const productImages = pgTable(
  'product_images',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    publicId: text('public_id').notNull(),
    alt: varchar('alt', { length: 200 }),
    sortOrder: integer('sort_order').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('product_images_product_idx').on(t.productId, t.sortOrder),
    uniqueIndex('product_images_primary_uq')
      .on(t.productId)
      .where(sql`${t.isPrimary}`),
  ],
);

export const services = pgTable(
  'services',
  {
    id: id(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 220 }).notNull().unique(),
    description: text('description').notNull().default(''),
    price: integer('price'),
    mode: serviceModeEnum('mode').notNull().default('cotizacion'),
    status: contentStatusEnum('status').notNull().default('borrador'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('services_price_chk', sql`${t.price} IS NULL OR ${t.price} >= 0`),
    // Un servicio de pago online necesita precio.
    check('services_online_price_chk', sql`${t.mode} <> 'pago_online' OR ${t.price} IS NOT NULL`),
  ],
);

export const serviceImages = pgTable(
  'service_images',
  {
    id: id(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    publicId: text('public_id').notNull(),
    alt: varchar('alt', { length: 200 }),
    sortOrder: integer('sort_order').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('service_images_service_idx').on(t.serviceId, t.sortOrder),
    uniqueIndex('service_images_primary_uq')
      .on(t.serviceId)
      .where(sql`${t.isPrimary}`),
  ],
);

export const quoteRequests = pgTable(
  'quote_requests',
  {
    id: id(),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 120 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    phone: varchar('phone', { length: 20 }),
    desiredDate: tstz('desired_date'),
    details: text('details').notNull(),
    status: quoteStatusEnum('status').notNull().default('nueva'),
    createdAt: createdAt(),
  },
  (t) => [index('quote_requests_status_idx').on(t.status, t.createdAt)],
);
