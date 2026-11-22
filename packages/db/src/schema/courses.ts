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
import { users } from './users';
import {
  contentStatusEnum,
  depositTypeEnum,
  editionStatusEnum,
  enrollmentStatusEnum,
  paymentModeEnum,
} from './enums';
import { createdAt, id, tstz, updatedAt } from './helpers';

export const courses = pgTable('courses', {
  id: id(),
  name: varchar('name', { length: 200 }).notNull(),
  slug: varchar('slug', { length: 220 }).notNull().unique(),
  description: text('description').notNull().default(''),
  level: varchar('level', { length: 40 }),
  durationText: varchar('duration_text', { length: 120 }),
  includes: text('includes'),
  status: contentStatusEnum('status').notNull().default('borrador'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const courseImages = pgTable(
  'course_images',
  {
    id: id(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    publicId: text('public_id').notNull(),
    alt: varchar('alt', { length: 200 }),
    sortOrder: integer('sort_order').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('course_images_course_idx').on(t.courseId, t.sortOrder),
    uniqueIndex('course_images_primary_uq')
      .on(t.courseId)
      .where(sql`${t.isPrimary}`),
  ],
);

export const courseEditions = pgTable(
  'course_editions',
  {
    id: id(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    location: varchar('location', { length: 200 }).notNull(),
    instructor: varchar('instructor', { length: 120 }),
    maxSeats: integer('max_seats').notNull(),
    price: integer('price').notNull(),
    enrollmentDeadline: tstz('enrollment_deadline').notNull(),
    status: editionStatusEnum('status').notNull().default('abierta'),
    allowedPaymentModes: paymentModeEnum('allowed_payment_modes')
      .array()
      .notNull()
      .default(sql`ARRAY['total']::payment_mode[]`),
    reservationHours: integer('reservation_hours').notNull().default(48),
    depositType: depositTypeEnum('deposit_type').notNull().default('porcentaje'),
    depositValue: integer('deposit_value').notNull().default(30),
    balanceDueAt: tstz('balance_due_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('course_editions_seats_chk', sql`${t.maxSeats} > 0`),
    check('course_editions_price_chk', sql`${t.price} >= 0`),
    check('course_editions_reservation_chk', sql`${t.reservationHours} > 0`),
    check('course_editions_deposit_chk', sql`${t.depositValue} > 0`),
    index('course_editions_course_status_idx').on(t.courseId, t.status),
    index('course_editions_deadline_idx').on(t.enrollmentDeadline),
  ],
);

export const editionSessions = pgTable(
  'edition_sessions',
  {
    id: id(),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => courseEditions.id, { onDelete: 'cascade' }),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
  },
  (t) => [
    check('edition_sessions_range_chk', sql`${t.endsAt} > ${t.startsAt}`),
    index('edition_sessions_edition_idx').on(t.editionId, t.startsAt),
  ],
);

export const enrollments = pgTable(
  'enrollments',
  {
    id: id(),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => courseEditions.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Datos de contacto (snapshot): siempre presentes, sea invitado o con cuenta.
    contactName: varchar('contact_name', { length: 120 }).notNull(),
    contactEmail: varchar('contact_email', { length: 254 }).notNull(),
    contactPhone: varchar('contact_phone', { length: 20 }).notNull(),
    contactDocument: varchar('contact_document', { length: 30 }),
    status: enrollmentStatusEnum('status').notNull().default('lista'),
    paymentMode: paymentModeEnum('payment_mode').notNull(),
    totalAmount: integer('total_amount').notNull(),
    paidAmount: integer('paid_amount').notNull().default(0),
    reservedUntil: tstz('reserved_until'),
    balanceDueAt: tstz('balance_due_at'),
    waitlistNotifiedAt: tstz('waitlist_notified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('enrollments_amounts_chk', sql`${t.totalAmount} >= 0 AND ${t.paidAmount} >= 0`),
    index('enrollments_edition_status_idx').on(t.editionId, t.status),
    index('enrollments_user_idx').on(t.userId),
    index('enrollments_email_idx').on(sql`lower(${t.contactEmail})`),
    index('enrollments_reserved_until_idx')
      .on(t.reservedUntil)
      .where(sql`${t.status} = 'reservada'`),
    // Una persona no puede tener dos inscripciones activas en la misma edición.
    uniqueIndex('enrollments_active_uq')
      .on(t.editionId, sql`lower(${t.contactEmail})`)
      .where(sql`${t.status} IN ('lista','reservada','abonada','pagada')`),
  ],
);
