import { z } from 'zod';
import { couponInputSchema } from './marketing';

export const publicProductsQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(140).optional(),
    minPrice: z.coerce.number().int().min(0).optional(),
    maxPrice: z.coerce.number().int().min(0).optional(),
    sort: z.enum(['nuevo', 'precio_asc', 'precio_desc']).default('nuevo'),
    featured: z.enum(['true']).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    pageSize: z.coerce.number().int().min(1).max(48).default(12),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'El precio mínimo no puede superar al máximo',
  });
export type PublicProductsQuery = z.infer<typeof publicProductsQuerySchema>;

export const slugParamSchema = z.object({ slug: z.string().trim().min(1).max(220) });

export const cartLineSchema = z.object({
  type: z.enum(['product', 'service']),
  id: z.uuid(),
  quantity: z.number().int().min(1).max(20),
});
export const cartQuoteSchema = z.object({
  items: z.array(cartLineSchema).min(1).max(30),
  couponCode: couponInputSchema,
});
export type CartLine = z.infer<typeof cartLineSchema>;

export const quoteRequestSchema = z.object({
  serviceId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  name: z.string().trim().min(2, 'Ingresa tu nombre').max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Correo inválido')),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+()\s-]{7,20}$/, 'Teléfono inválido')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  desiredDate: z.iso
    .date()
    .nullish()
    .transform((v) => v ?? null),
  details: z.string().trim().min(10, 'Cuéntanos un poco más (mínimo 10 caracteres)').max(3000),
  acceptDataPolicy: z.literal(true, {
    error: 'Debes autorizar el tratamiento de tus datos personales',
  }),
  /** Honeypot anti-spam: debe venir vacío. */
  website: z.string().max(0).optional(),
});
export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;
