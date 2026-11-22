import { z } from 'zod';
import { ROLES } from '../constants';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Correo electrónico inválido'));

export const passwordSchema = z
  .string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres')
  .max(128, 'La contraseña es demasiado larga');

const phone = z
  .string()
  .trim()
  .regex(/^[0-9+()\s-]{7,20}$/, 'Teléfono inválido');

export const registerSchema = z.object({
  email,
  password: passwordSchema,
  name: z.string().trim().min(2, 'Ingresa tu nombre').max(120),
  phone: phone.optional(),
  acceptDataPolicy: z.literal(true, {
    error: 'Debes autorizar el tratamiento de tus datos personales',
  }),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
});

export const tokenSchema = z.object({ token: z.string().min(20).max(200) });

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const setRoleSchema = z.object({ role: z.enum(ROLES) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
