import { jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';
import { updatedAt } from './helpers';

/** Ajustes del sitio: tarifa de envío, umbral de envío gratis, contacto, redes, textos legales. */
export const siteSettings = pgTable('site_settings', {
  key: varchar('key', { length: 80 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});
