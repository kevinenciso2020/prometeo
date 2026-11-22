import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { courseEditions, courses, enrollments, payments } from '@prometeo/db';
import { idParamSchema, manualPaymentSchema, pendingAmount } from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { balanceReminder, depositReceived, paymentComplete } from '../../lib/enrollment-emails';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';
import {
  cancelEnrollment,
  emailContext,
  notifyWaitlist,
  registerManualPayment,
  safeSend,
} from '../../services/enrollments.service';

export const enrollmentsRoutes = new Hono<AppEnv>();

enrollmentsRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [e] = await db.select().from(enrollments).where(eq(enrollments.id, id)).limit(1);
  if (!e) throw new AuthError(404, 'NOT_FOUND', 'Inscripción no encontrada');
  const [ctx] = await db
    .select({ courseName: courses.name, location: courseEditions.location })
    .from(courseEditions)
    .innerJoin(courses, eq(courses.id, courseEditions.courseId))
    .where(eq(courseEditions.id, e.editionId))
    .limit(1);
  const pays = await db
    .select()
    .from(payments)
    .where(eq(payments.enrollmentId, id))
    .orderBy(asc(payments.createdAt));
  return c.json({
    item: {
      ...e,
      pendingAmount: pendingAmount(e.totalAmount, e.paidAmount),
      ...ctx,
      payments: pays,
    },
  });
});

/** Registra un pago manual (efectivo/transferencia). Actualiza estado y cupos en una transacción. */
enrollmentsRoutes.post(
  '/:id/payments',
  validate('param', idParamSchema),
  validate('json', manualPaymentSchema),
  async (c) => {
    const actor = c.get('user');
    if (!actor) throw new AuthError(401, 'UNAUTHENTICATED', 'Inicia sesión');
    const { id } = c.req.valid('param');
    const result = await registerManualPayment(
      c.get('openPool'),
      id,
      actor.id,
      c.req.valid('json'),
    );
    const db = c.get('db');
    const ctx = await emailContext(db, result.enrollment, c.env.WEB_URL);
    await safeSend(c.get('mailer'), result.fullyPaid ? paymentComplete(ctx) : depositReceived(ctx));
    return c.json({
      item: {
        ...result.enrollment,
        pendingAmount: pendingAmount(result.enrollment.totalAmount, result.enrollment.paidAmount),
      },
    });
  },
);

enrollmentsRoutes.post('/:id/cancel', validate('param', idParamSchema), async (c) => {
  const actor = c.get('user');
  if (!actor) throw new AuthError(401, 'UNAUTHENTICATED', 'Inicia sesión');
  const { enrollment, freedSeat } = await cancelEnrollment(
    c.get('openPool'),
    c.req.valid('param').id,
    actor.id,
  );
  let notified = 0;
  if (freedSeat)
    notified = await notifyWaitlist(
      c.get('db'),
      c.get('mailer'),
      enrollment.editionId,
      c.env.WEB_URL,
    );
  return c.json({ item: enrollment, waitlistNotified: notified });
});

/** Reenvía el recordatorio de saldo manualmente. */
enrollmentsRoutes.post('/:id/remind-balance', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const [e] = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, c.req.valid('param').id))
    .limit(1);
  if (!e) throw new AuthError(404, 'NOT_FOUND', 'Inscripción no encontrada');
  if (e.status !== 'abonada')
    throw new AuthError(
      400,
      'INVALID_STATE',
      'Solo se recuerda el saldo de inscripciones abonadas',
    );
  await safeSend(c.get('mailer'), balanceReminder(await emailContext(db, e, c.env.WEB_URL)));
  return c.json({ ok: true });
});
