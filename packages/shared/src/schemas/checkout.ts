import { z } from 'zod';
import { isValidLocation } from '../divipola';
import { ORDER_STATUSES } from '../orders';
import { cartLineSchema } from './public';

const contact = {
  name: z.string().trim().min(2, 'Ingresa tu nombre').max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Correo inválido')),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+()\s-]{7,20}$/, 'Teléfono inválido'),
  document: z
    .string()
    .trim()
    .max(30)
    .optional()
    .transform((v) => (v ? v : null)),
};

export const shippingAddressSchema = z
  .object({
    departmentCode: z.string().regex(/^\d{2}$/, 'Selecciona el departamento'),
    municipalityCode: z.string().regex(/^\d{5}$/, 'Selecciona el municipio'),
    address: z.string().trim().min(5, 'Ingresa la dirección').max(200),
    neighborhood: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((v) => (v ? v : null)),
    notes: z
      .string()
      .trim()
      .max(300)
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .refine((a) => isValidLocation(a.departmentCode, a.municipalityCode), {
    path: ['municipalityCode'],
    message: 'El municipio no pertenece al departamento seleccionado',
  });
export type ShippingAddressInput = z.infer<typeof shippingAddressSchema>;

export const checkoutOrderSchema = z.object({
  items: z.array(cartLineSchema).min(1, 'Tu carrito está vacío').max(30),
  ...contact,
  shipping: shippingAddressSchema.nullish().transform((v) => v ?? null),
  acceptDataPolicy: z.literal(true, {
    error: 'Debes autorizar el tratamiento de tus datos personales',
  }),
  acceptTerms: z.literal(true, {
    error: 'Debes aceptar los términos y la política de devoluciones',
  }),
  website: z.string().max(0).optional(),
});
export type CheckoutOrderInput = z.infer<typeof checkoutOrderSchema>;

/** Pago de una inscripción: completo (lo pendiente) o solo el abono. */
export const payEnrollmentSchema = z.object({ type: z.enum(['full', 'deposit']) });

export const updateOrderStatusSchema = z
  .object({
    status: z.enum(ORDER_STATUSES),
    trackingNumber: z
      .string()
      .trim()
      .max(80)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .refine((o) => o.status !== 'enviado' || o.trackingNumber !== null, {
    path: ['trackingNumber'],
    message: 'Ingresa el número de guía para marcar el pedido como enviado',
  });

export const resolveReviewSchema = z.object({ deductStock: z.boolean() });

export const quoteStatusSchema = z.object({ status: z.enum(['nueva', 'contactada', 'cerrada']) });
export const orderListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  review: z.enum(['true']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const referenceParamSchema = z.object({ reference: z.string().min(8).max(80) });
