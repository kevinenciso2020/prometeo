import { z } from 'zod';
import { PAYMENT_MODES } from '../enrollment';
import { CONTENT_STATUSES, imagesSchema, slugSchema } from './catalog';

const cop = z.number().int('Debe ser un entero en pesos').min(0).max(2_000_000_000);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
/** Fecha-hora ISO con zona (el panel envía America/Bogota como -05:00). */
const isoDateTime = z.iso.datetime({ offset: true });

export const courseSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: slugSchema,
  description: z.string().trim().max(10_000).default(''),
  level: text(40),
  durationText: text(120),
  includes: text(2000),
  status: z.enum(CONTENT_STATUSES).default('borrador'),
  images: imagesSchema,
});
export type CourseInput = z.infer<typeof courseSchema>;

export const sessionSchema = z
  .object({ startsAt: isoDateTime, endsAt: isoDateTime })
  .refine((s) => new Date(s.endsAt) > new Date(s.startsAt), {
    path: ['endsAt'],
    message: 'La hora de fin debe ser posterior al inicio',
  });

/** Estados que el admin puede fijar a mano. `llena` y `finalizada` los calcula el sistema. */
export const ADMIN_EDITION_STATUSES = ['abierta', 'cerrada', 'cancelada'] as const;

export const editionSchema = z
  .object({
    courseId: z.uuid(),
    location: z.string().trim().min(2).max(200),
    instructor: text(120),
    maxSeats: z.number().int().min(1, 'Mínimo 1 cupo').max(500),
    price: cop,
    enrollmentDeadline: isoDateTime,
    status: z.enum(ADMIN_EDITION_STATUSES).default('abierta'),
    allowedPaymentModes: z
      .array(z.enum(PAYMENT_MODES))
      .min(1, 'Habilita al menos una modalidad de pago')
      .max(4),
    reservationHours: z.number().int().min(1).max(720).default(48),
    depositType: z.enum(['monto', 'porcentaje']).default('porcentaje'),
    depositValue: z.number().int().min(1).max(2_000_000_000).default(30),
    balanceDueAt: isoDateTime.nullish().transform((v) => v ?? null),
    sessions: z.array(sessionSchema).min(1, 'Agrega al menos una sesión').max(40),
  })
  .superRefine((e, ctx) => {
    const firstStart = Math.min(...e.sessions.map((s) => new Date(s.startsAt).getTime()));
    if (new Date(e.enrollmentDeadline).getTime() > firstStart) {
      ctx.addIssue({
        code: 'custom',
        path: ['enrollmentDeadline'],
        message: 'La fecha límite debe ser antes de la primera sesión',
      });
    }
    if (e.balanceDueAt && new Date(e.balanceDueAt).getTime() > firstStart) {
      ctx.addIssue({
        code: 'custom',
        path: ['balanceDueAt'],
        message: 'El saldo debe pagarse antes de la primera sesión',
      });
    }
    if (e.allowedPaymentModes.includes('abono')) {
      if (e.depositType === 'porcentaje' && e.depositValue > 99) {
        ctx.addIssue({
          code: 'custom',
          path: ['depositValue'],
          message: 'El abono en porcentaje debe ser entre 1 y 99',
        });
      }
      if (e.depositType === 'monto' && e.depositValue >= e.price) {
        ctx.addIssue({
          code: 'custom',
          path: ['depositValue'],
          message: 'El abono debe ser menor al precio',
        });
      }
    }
  });
export type EditionInput = z.infer<typeof editionSchema>;

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

export const createEnrollmentSchema = z.object({
  editionId: z.uuid(),
  mode: z.enum(PAYMENT_MODES),
  ...contact,
  acceptDataPolicy: z.literal(true, {
    error: 'Debes autorizar el tratamiento de tus datos personales',
  }),
  website: z.string().max(0).optional(),
});
export type CreateEnrollmentInput = z.infer<typeof createEnrollmentSchema>;

export const secureSeatSchema = z.object({ mode: z.enum(['total', 'reserva', 'abono']) });

export const manualPaymentSchema = z.object({
  amount: z
    .number()
    .int('El monto debe ser un entero en pesos')
    .min(1, 'El monto debe ser mayor a 0')
    .max(2_000_000_000),
  method: z.enum(['efectivo', 'transferencia']),
  note: text(500),
});

export const tokenParamSchema = z.object({ token: z.string().min(20).max(120) });
