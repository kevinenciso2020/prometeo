import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { authTokenTypeEnum, guestSubjectEnum, roleEnum } from './enums';
import { createdAt, id, tstz, updatedAt } from './helpers';

/** El email se guarda normalizado (minúsculas); el índice único usa lower() por seguridad extra. */
export const users = pgTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    phone: varchar('phone', { length: 20 }),
    document: varchar('document', { length: 30 }),
    role: roleEnum('role').notNull().default('CLIENTE'),
    emailVerifiedAt: tstz('email_verified_at'),
    isActive: boolean('is_active').notNull().default(true),
    dataPolicyAcceptedAt: tstz('data_policy_accepted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: uuid('family_id').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    replacedById: uuid('replaced_by_id'),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('refresh_tokens_user_idx').on(t.userId),
    index('refresh_tokens_family_idx').on(t.familyId),
  ],
);

/** Tokens de un solo uso: verificación de email y recuperación de contraseña. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: authTokenTypeEnum('type').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('auth_tokens_user_type_idx').on(t.userId, t.type)],
);

/** Links seguros para que un invitado vea el estado de su pedido/inscripción. */
export const guestLinks = pgTable(
  'guest_links',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    subjectType: guestSubjectEnum('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('guest_links_subject_idx').on(t.subjectType, t.subjectId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 80 }).notNull(),
    entityType: varchar('entity_type', { length: 60 }).notNull(),
    entityId: varchar('entity_id', { length: 60 }),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);
