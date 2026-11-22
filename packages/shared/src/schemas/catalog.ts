import { z } from 'zod';
import { UPLOAD_FOLDERS } from '../cloudinary';

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(140)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Solo minúsculas, números y guiones');

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export const CONTENT_STATUSES = ['borrador', 'publicado', 'archivado'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

const cop = z
  .number()
  .int('Debe ser un entero en pesos')
  .min(0, 'No puede ser negativo')
  .max(2_000_000_000);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const optionalInt = z
  .number()
  .int()
  .min(0)
  .max(1_000_000)
  .nullish()
  .transform((v) => v ?? null);

export const imageInputSchema = z.object({
  url: z.url().max(600),
  publicId: z.string().min(1).max(300),
  alt: optionalText(200),
  isPrimary: z.boolean().default(false),
});
export type ImageInput = z.infer<typeof imageInputSchema>;

/** El orden del arreglo es el orden de la galería; la principal es la marcada (o la primera). */
export const imagesSchema = z.array(imageInputSchema).max(12, 'Máximo 12 imágenes').default([]);

export const idParamSchema = z.object({ id: z.uuid() });

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  categoryId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const categorySchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  description: optionalText(1000),
  imageUrl: z
    .url()
    .max(600)
    .nullish()
    .transform((v) => v ?? null),
  imagePublicId: optionalText(300),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});
export type CategoryInput = z.infer<typeof categorySchema>;

export const productSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    slug: slugSchema,
    description: z.string().trim().max(10_000).default(''),
    price: cop,
    compareAtPrice: cop.nullish().transform((v) => v ?? null),
    stock: z.number().int().min(0).max(100_000).default(0),
    sku: optionalText(60),
    categoryId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    weightGrams: optionalInt,
    widthMm: optionalInt,
    heightMm: optionalInt,
    depthMm: optionalInt,
    materials: optionalText(500),
    status: z.enum(CONTENT_STATUSES).default('borrador'),
    isUnique: z.boolean().default(false),
    isFeatured: z.boolean().default(false),
    images: imagesSchema,
  })
  .refine((p) => p.compareAtPrice === null || p.compareAtPrice >= p.price, {
    path: ['compareAtPrice'],
    message: 'El precio comparativo debe ser mayor o igual al precio',
  })
  .refine((p) => !p.isUnique || p.stock <= 1, {
    path: ['stock'],
    message: 'Una pieza única tiene como máximo 1 unidad',
  });
export type ProductInput = z.infer<typeof productSchema>;

export const SERVICE_MODES = ['pago_online', 'cotizacion'] as const;

export const serviceSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    slug: slugSchema,
    description: z.string().trim().max(10_000).default(''),
    price: cop.nullish().transform((v) => v ?? null),
    mode: z.enum(SERVICE_MODES),
    status: z.enum(CONTENT_STATUSES).default('borrador'),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
    images: imagesSchema,
  })
  .refine((s) => s.mode !== 'pago_online' || s.price !== null, {
    path: ['price'],
    message: 'Un servicio de pago online necesita precio',
  });
export type ServiceInput = z.infer<typeof serviceSchema>;

export const uploadSignatureSchema = z.object({ folder: z.enum(UPLOAD_FOLDERS) });
export const destroyUploadSchema = z.object({ publicId: z.string().min(1).max(300) });

const phoneish = z.string().trim().max(30).default('');
const short = z.string().trim().max(200).default('');

export const settingsSchema = z
  .object({
    shipping_flat_rate: cop,
    free_shipping_threshold: cop.nullable(),
    contact: z.object({
      email: z.union([z.literal(''), z.email()]).default(''),
      phone: phoneish,
      whatsapp: phoneish,
      address: short,
      hours: short,
    }),
    social: z.object({
      instagram: z.union([z.literal(''), z.url()]).default(''),
      facebook: z.union([z.literal(''), z.url()]).default(''),
      tiktok: z.union([z.literal(''), z.url()]).default(''),
    }),
    legal: z.object({
      terms: z.string().max(60_000).default(''),
      privacy: z.string().max(60_000).default(''),
      shipping_returns: z.string().max(60_000).default(''),
    }),
  })
  .partial();
export type SiteSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS = {
  shipping_flat_rate: 12000,
  free_shipping_threshold: null,
  contact: { email: '', phone: '', whatsapp: '', address: '', hours: '' },
  social: { instagram: '', facebook: '', tiktok: '' },
  legal: { terms: '', privacy: '', shipping_returns: '' },
} as const;

export const createAdminSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(10).max(128),
});

export const setActiveSchema = z.object({ isActive: z.boolean() });
