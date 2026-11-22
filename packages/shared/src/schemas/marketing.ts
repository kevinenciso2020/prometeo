import { z } from 'zod';
import { COUPON_SCOPES, COUPON_TYPES } from '../pricing';

const isoDateTime = z.iso.datetime({ offset: true });
const nullableDate = isoDateTime.nullish().transform((v) => v ?? null);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Código de cupón: se normaliza a MAYÚSCULAS. Letras, números, guion y guion bajo. */
export const couponCodeSchema = z
  .string()
  .trim()
  .min(3, 'El código debe tener al menos 3 caracteres')
  .max(40)
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9_-]+$/, 'Solo letras, números, guion y guion bajo'));

/** Código opcional escrito por el cliente (carrito, checkout, inscripción). */
export const couponInputSchema = z
  .string()
  .trim()
  .max(40)
  .nullish()
  .transform((v) => (v ? v.toUpperCase() : null));

export const couponSchema = z
  .object({
    code: couponCodeSchema.nullish().transform((v) => v ?? null),
    type: z.enum(COUPON_TYPES),
    value: z.number().int().min(0).max(2_000_000_000).default(0),
    appliesTo: z.enum(COUPON_SCOPES).default('todo'),
    targetIds: z.array(z.uuid()).max(200).default([]),
    minPurchase: z.number().int().min(0).max(2_000_000_000).default(0),
    startsAt: nullableDate,
    endsAt: nullableDate,
    maxUses: z
      .number()
      .int()
      .min(1)
      .max(10_000_000)
      .nullish()
      .transform((v) => v ?? null),
    maxUsesPerEmail: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .nullish()
      .transform((v) => v ?? null),
    isAutomatic: z.boolean().default(false),
    isActive: z.boolean().default(true),
    description: optText(300),
  })
  .superRefine((c, ctx) => {
    if (c.isAutomatic && c.code !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'Un descuento automático no lleva código',
      });
    if (!c.isAutomatic && c.code === null)
      ctx.addIssue({ code: 'custom', path: ['code'], message: 'Ingresa el código del cupón' });
    if (c.type === 'porcentaje' && (c.value < 1 || c.value > 100)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'El porcentaje debe estar entre 1 y 100',
      });
    }
    if (c.type === 'monto_fijo' && c.value < 1)
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'El monto debe ser mayor a 0' });
    if ((c.appliesTo === 'categorias' || c.appliesTo === 'items') && c.targetIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetIds'],
        message: 'Selecciona al menos un elemento',
      });
    }
    if (c.startsAt && c.endsAt && new Date(c.endsAt) <= new Date(c.startsAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'La fecha de fin debe ser posterior al inicio',
      });
    }
  });
export type CouponInput = z.infer<typeof couponSchema>;

export const validateCouponSchema = z.object({
  code: couponCodeSchema,
});

/* ------------------------------ Campañas ------------------------------ */

export const CAMPAIGN_PLACEMENTS = [
  'hero_banner',
  'banner_seccion',
  'popup',
  'barra_superior',
] as const;
export type CampaignPlacement = (typeof CAMPAIGN_PLACEMENTS)[number];
export const CAMPAIGN_TARGETS = ['producto', 'curso', 'edicion', 'categoria'] as const;

/** URL interna (/ruta) o externa (https://...). Bloquea javascript:, data:, // y similares. */
export const ctaUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (u) =>
      (u.startsWith('/') && !u.startsWith('//') && !u.includes('\\')) ||
      /^https:\/\/[^\s]+$/i.test(u),
    {
      message: 'Usa una ruta interna (/tienda) o una URL https://',
    },
  );

const imageUrl = z
  .url()
  .max(600)
  .nullish()
  .transform((v) => v ?? null);

export const campaignSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    placement: z.enum(CAMPAIGN_PLACEMENTS),
    imageDesktopUrl: imageUrl,
    imageDesktopPublicId: optText(300),
    imageMobileUrl: imageUrl,
    imageMobilePublicId: optText(300),
    title: optText(200),
    text: optText(600),
    ctaText: optText(60),
    ctaUrl: ctaUrlSchema.nullish().transform((v) => v ?? null),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    priority: z.number().int().min(0).max(1000).default(0),
    isActive: z.boolean().default(true),
    /** Rutas donde se muestra; vacío = todas. Admite comodín final: /tienda* */
    pages: z
      .array(
        z
          .string()
          .trim()
          .regex(/^\/[A-Za-z0-9\-_/.*]*$/, 'Ruta inválida (ej. /tienda o /cursos*)')
          .max(200),
      )
      .max(30)
      .default([]),
    popupFrequencyHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .default(24),
    targetType: z
      .enum(CAMPAIGN_TARGETS)
      .nullish()
      .transform((v) => v ?? null),
    targetId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    couponId: z
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
  })
  .superRefine((c, ctx) => {
    if (new Date(c.endsAt) <= new Date(c.startsAt))
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'La fecha de fin debe ser posterior al inicio',
      });
    if ((c.targetType === null) !== (c.targetId === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetId'],
        message: 'Indica el tipo y el elemento promocionado',
      });
    }
    if (c.placement !== 'barra_superior' && !c.imageDesktopUrl && !c.title) {
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'Agrega una imagen o un título' });
    }
    if (c.placement === 'barra_superior' && !c.title && !c.text) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'La barra superior necesita un texto',
      });
    }
    if (c.ctaText && !c.ctaUrl && !c.targetId) {
      ctx.addIssue({
        code: 'custom',
        path: ['ctaUrl'],
        message: 'El botón necesita una URL o un elemento promocionado',
      });
    }
  });
export type CampaignInput = z.infer<typeof campaignSchema>;

export const campaignEventSchema = z.object({ type: z.enum(['impression', 'click']) });

export const publicCampaignsQuerySchema = z.object({
  path: z
    .string()
    .trim()
    .max(300)
    .regex(/^\/[^\s]*$/)
    .default('/'),
  placement: z.enum(CAMPAIGN_PLACEMENTS).optional(),
});

/** ¿La ruta actual cumple la segmentación de la campaña? (vacío = todas; admite comodín final) */
export function campaignMatchesPath(pages: readonly string[], path: string): boolean {
  if (pages.length === 0) return true;
  const clean = path.split('?')[0]?.split('#')[0] ?? '/';
  return pages.some((p) =>
    p.endsWith('*') ? clean.startsWith(p.slice(0, -1)) : clean === p || clean === `${p}/`,
  );
}
