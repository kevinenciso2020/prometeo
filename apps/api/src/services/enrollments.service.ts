import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  courseEditions,
  courses,
  editionSessions,
  enrollments,
  payments,
  type Db,
} from '@prometeo/db';
import {
  ACTIVE_STATES,
  SEAT_STATES,
  computeDeposit,
  computeReservedUntil,
  editionStatusForSeats,
  eventForPayment,
  isEditionOpen,
  transition,
  type CreateEnrollmentInput,
  type EditionStatus,
  type EnrollmentState,
  type PaymentMode,
} from '@prometeo/shared';
import { writeAudit } from '../lib/audit';
import type { EnrollmentEmailCtx } from '../lib/enrollment-emails';
import * as mail from '../lib/enrollment-emails';
import type { Mailer } from '../lib/mailer';
import { withTransaction, type PoolOpener } from '../lib/tx';
import { AuthError } from './auth.service';
import { assertCodeAccepted, recordRedemption, resolveDiscount } from './discounts';
import { issueGuestLink, resolveGuestLink } from './guest-links';

type Enrollment = typeof enrollments.$inferSelect;
type Edition = typeof courseEditions.$inferSelect;

const err = (status: 400 | 401 | 403 | 404 | 409, code: string, message: string) =>
  new AuthError(status as 400, code, message);

/* ------------------------------------------------------------------ */
/* Helpers de cupos                                                    */
/* ------------------------------------------------------------------ */

export async function occupiedSeats(db: Db, editionId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(eq(enrollments.editionId, editionId), inArray(enrollments.status, [...SEAT_STATES])),
    );
  return row?.n ?? 0;
}

/** Bloquea la fila de la edición (SELECT ... FOR UPDATE): serializa inscripciones concurrentes. */
async function lockEdition(tx: Db, editionId: string): Promise<Edition> {
  const [edition] = await tx
    .select()
    .from(courseEditions)
    .where(eq(courseEditions.id, editionId))
    .for('update');
  if (!edition) throw err(404, 'NOT_FOUND', 'La edición no existe');
  return edition;
}

/** Ajusta abierta <-> llena según los cupos ocupados. Devuelve los cupos libres. */
export async function syncEditionStatus(tx: Db, edition: Edition): Promise<number> {
  const occupied = await occupiedSeats(tx, edition.id);
  const next = editionStatusForSeats(edition.status as EditionStatus, occupied, edition.maxSeats);
  if (next !== edition.status)
    await tx.update(courseEditions).set({ status: next }).where(eq(courseEditions.id, edition.id));
  return Math.max(0, edition.maxSeats - occupied);
}

const issueEnrollmentLink = (db: Db, enrollmentId: string, email: string) =>
  issueGuestLink(db, 'enrollment', enrollmentId, email);

/* ------------------------------------------------------------------ */
/* Contexto para correos                                               */
/* ------------------------------------------------------------------ */

export async function emailContext(
  db: Db,
  enrollment: Enrollment,
  webUrl: string,
  statusToken?: string,
): Promise<EnrollmentEmailCtx> {
  const [row] = await db
    .select({
      courseName: courses.name,
      courseSlug: courses.slug,
      location: courseEditions.location,
    })
    .from(courseEditions)
    .innerJoin(courses, eq(courses.id, courseEditions.courseId))
    .where(eq(courseEditions.id, enrollment.editionId))
    .limit(1);
  const [first] = await db
    .select({ startsAt: editionSessions.startsAt })
    .from(editionSessions)
    .where(eq(editionSessions.editionId, enrollment.editionId))
    .orderBy(asc(editionSessions.startsAt))
    .limit(1);
  const token =
    statusToken ?? (await issueEnrollmentLink(db, enrollment.id, enrollment.contactEmail));
  return {
    to: enrollment.contactEmail,
    name: enrollment.contactName,
    courseName: row?.courseName ?? 'Curso',
    location: row?.location ?? '',
    firstSession: first?.startsAt ?? null,
    mode: enrollment.paymentMode,
    total: enrollment.totalAmount,
    paid: enrollment.paidAmount,
    reservedUntil: enrollment.reservedUntil,
    balanceDueAt: enrollment.balanceDueAt,
    statusUrl: `${webUrl}/inscripcion/${token}`,
  };
}

async function safeSend(mailer: Mailer, email: Parameters<Mailer['send']>[0]): Promise<void> {
  try {
    await mailer.send(email);
  } catch {
    /* un fallo de correo nunca debe revertir una inscripción ni un cron */
  }
}

/* ------------------------------------------------------------------ */
/* Crear inscripción                                                   */
/* ------------------------------------------------------------------ */

export interface CreatedEnrollment {
  enrollment: Enrollment;
  token: string;
  depositAmount: number;
  seatsLeft: number;
}

export async function createEnrollment(
  open: PoolOpener,
  input: CreateEnrollmentInput,
  userId: string | null,
  now = new Date(),
): Promise<CreatedEnrollment> {
  return withTransaction(open, async (tx) => {
    const edition = await lockEdition(tx, input.editionId);
    const [course] = await tx
      .select({ status: courses.status })
      .from(courses)
      .where(eq(courses.id, edition.courseId))
      .limit(1);
    if (!course || course.status !== 'publicado')
      throw err(404, 'NOT_FOUND', 'El curso no está disponible');
    if (!isEditionOpen(edition.status as EditionStatus, edition.enrollmentDeadline, now)) {
      throw err(409, 'EDITION_CLOSED', 'Las inscripciones para esta edición están cerradas');
    }
    if (!edition.allowedPaymentModes.includes(input.mode)) {
      throw err(
        400,
        'MODE_NOT_ALLOWED',
        'Esa modalidad de pago no está habilitada para esta edición',
      );
    }

    const [dup] = await tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.editionId, edition.id),
          sql`lower(${enrollments.contactEmail}) = ${input.email}`,
          inArray(enrollments.status, [...ACTIVE_STATES]),
        ),
      )
      .limit(1);
    if (dup)
      throw err(409, 'DUPLICATE', 'Ya tienes una inscripción con este correo en esta edición');

    const occupied = await occupiedSeats(tx, edition.id);
    const holdsSeat = input.mode !== 'lista';
    if (holdsSeat && occupied >= edition.maxSeats) {
      throw err(409, 'EDITION_FULL', 'No quedan cupos. Puedes unirte a la lista de espera');
    }

    // Descuento (cupón o automático) calculado en el servidor; el uso solo se registra al aprobarse el pago.
    const discount = await resolveDiscount(tx, {
      lines: [{ kind: 'course', id: edition.courseId, unitPrice: edition.price, quantity: 1 }],
      shipping: { flatRate: 0, freeThreshold: null },
      code: input.couponCode,
      email: input.email,
      now,
    });
    assertCodeAccepted(discount);
    const payable = discount.priced.total;

    const [enrollment] = await tx
      .insert(enrollments)
      .values({
        editionId: edition.id,
        userId,
        couponId: discount.coupon?.id ?? null,
        discountAmount: discount.priced.itemDiscount,
        contactName: input.name,
        contactEmail: input.email,
        contactPhone: input.phone,
        contactDocument: input.document,
        status: holdsSeat ? 'reservada' : 'lista',
        paymentMode: input.mode,
        totalAmount: payable,
        paidAmount: 0,
        reservedUntil: computeReservedUntil(
          now,
          input.mode,
          edition.reservationHours,
          edition.enrollmentDeadline,
        ),
        balanceDueAt: input.mode === 'abono' ? edition.balanceDueAt : null,
      })
      .returning();
    if (!enrollment) throw new Error('No se pudo crear la inscripción');

    const seatsLeft = await syncEditionStatus(tx, edition);
    const token = await issueEnrollmentLink(tx, enrollment.id, enrollment.contactEmail);
    return {
      enrollment,
      token,
      depositAmount: computeDeposit(payable, edition.depositType, edition.depositValue),
      seatsLeft,
    };
  });
}

/** Una persona en lista asegura el cupo (si aún hay) eligiendo una modalidad. */
export async function secureSeat(
  open: PoolOpener,
  token: string,
  mode: Exclude<PaymentMode, 'lista'>,
  now = new Date(),
): Promise<Enrollment> {
  return withTransaction(open, async (tx) => {
    const subjectId = await resolveGuestLink(tx, 'enrollment', token);
    if (!subjectId) throw err(404, 'NOT_FOUND', 'El enlace no es válido o venció');
    const [pre] = await tx
      .select({ editionId: enrollments.editionId })
      .from(enrollments)
      .where(eq(enrollments.id, subjectId))
      .limit(1);
    if (!pre) throw err(404, 'NOT_FOUND', 'Inscripción no encontrada');

    const edition = await lockEdition(tx, pre.editionId);
    const [current] = await tx
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, subjectId))
      .for('update');
    if (!current) throw err(404, 'NOT_FOUND', 'Inscripción no encontrada');
    const next = transition(current.status as EnrollmentState, 'reserve');
    if (!next) throw err(409, 'INVALID_STATE', 'Esta inscripción ya no está en lista de espera');
    if (!isEditionOpen(edition.status as EditionStatus, edition.enrollmentDeadline, now)) {
      throw err(409, 'EDITION_CLOSED', 'Las inscripciones para esta edición están cerradas');
    }
    if (!edition.allowedPaymentModes.includes(mode))
      throw err(400, 'MODE_NOT_ALLOWED', 'Esa modalidad de pago no está habilitada');
    if ((await occupiedSeats(tx, edition.id)) >= edition.maxSeats)
      throw err(409, 'EDITION_FULL', 'Ya no quedan cupos disponibles');

    const [updated] = await tx
      .update(enrollments)
      .set({
        status: next,
        paymentMode: mode,
        reservedUntil: computeReservedUntil(
          now,
          mode,
          edition.reservationHours,
          edition.enrollmentDeadline,
        ),
        balanceDueAt: mode === 'abono' ? edition.balanceDueAt : null,
        reservationReminderSentAt: null,
      })
      .where(eq(enrollments.id, current.id))
      .returning();
    await syncEditionStatus(tx, edition);
    if (!updated) throw new Error('No se pudo actualizar la inscripción');
    return updated;
  });
}

/* ------------------------------------------------------------------ */
/* Pagos manuales y cancelación (admin)                                */
/* ------------------------------------------------------------------ */

export interface ManualPaymentResult {
  enrollment: Enrollment;
  previousPaid: number;
  fullyPaid: boolean;
}

export async function registerManualPayment(
  open: PoolOpener,
  enrollmentId: string,
  actorId: string,
  input: { amount: number; method: 'efectivo' | 'transferencia'; note: string | null },
  now = new Date(),
): Promise<ManualPaymentResult> {
  return withTransaction(open, async (tx) => {
    const [pre] = await tx
      .select({ editionId: enrollments.editionId })
      .from(enrollments)
      .where(eq(enrollments.id, enrollmentId))
      .limit(1);
    if (!pre) throw err(404, 'NOT_FOUND', 'Inscripción no encontrada');
    const edition = await lockEdition(tx, pre.editionId);
    const [current] = await tx
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, enrollmentId))
      .for('update');
    if (!current) throw err(404, 'NOT_FOUND', 'Inscripción no encontrada');

    const remaining = current.totalAmount - current.paidAmount;
    if (current.status === 'pagada' || remaining <= 0)
      throw err(400, 'ALREADY_PAID', 'Esta inscripción ya está pagada por completo');
    if (current.status === 'vencida' || current.status === 'cancelada') {
      throw err(
        400,
        'INVALID_STATE',
        `No se puede registrar un pago en una inscripción ${current.status}`,
      );
    }
    if (input.amount > remaining)
      throw err(400, 'OVERPAY', `El monto supera el saldo pendiente (${remaining})`);

    const paidAfter = current.paidAmount + input.amount;
    const event = eventForPayment(paidAfter, current.totalAmount);
    const next = transition(current.status as EnrollmentState, event);
    if (!next) throw err(400, 'INVALID_STATE', 'Transición de estado no permitida');

    // Una persona en lista solo obtiene cupo si aún hay disponibles.
    if (current.status === 'lista' && (await occupiedSeats(tx, edition.id)) >= edition.maxSeats) {
      throw err(409, 'EDITION_FULL', 'No quedan cupos: no se puede asegurar a esta persona');
    }

    const purpose = current.paidAmount > 0 ? 'saldo' : next === 'pagada' ? 'total' : 'abono';
    await tx.insert(payments).values({
      kind: 'enrollment',
      enrollmentId: current.id,
      purpose,
      amount: input.amount,
      method: input.method,
      status: 'aprobado',
      reference: `MAN-${crypto.randomUUID()}`,
      recordedBy: actorId,
      note: input.note,
      paidAt: now,
    });
    const [updated] = await tx
      .update(enrollments)
      .set({ status: next, paidAmount: paidAfter, reservedUntil: null })
      .where(eq(enrollments.id, current.id))
      .returning();
    await syncEditionStatus(tx, edition);
    if (current.couponId) {
      await recordRedemption(tx, {
        couponId: current.couponId,
        enrollmentId: current.id,
        email: current.contactEmail,
        discountAmount: current.discountAmount,
      });
    }
    await writeAudit(tx, {
      actorId,
      action: 'enrollment.manual_payment',
      entityType: 'enrollment',
      entityId: current.id,
      before: { status: current.status, paid: current.paidAmount },
      after: { status: next, paid: paidAfter, amount: input.amount, method: input.method },
    });
    if (!updated) throw new Error('No se pudo registrar el pago');
    return { enrollment: updated, previousPaid: current.paidAmount, fullyPaid: next === 'pagada' };
  });
}

export async function cancelEnrollment(
  open: PoolOpener,
  enrollmentId: string,
  actorId: string,
): Promise<{ enrollment: Enrollment; freedSeat: boolean }> {
  return withTransaction(open, async (tx) => {
    const [pre] = await tx
      .select({ editionId: enrollments.editionId })
      .from(enrollments)
      .where(eq(enrollments.id, enrollmentId))
      .limit(1);
    if (!pre) throw err(404, 'NOT_FOUND', 'Inscripción no encontrada');
    const edition = await lockEdition(tx, pre.editionId);
    const [current] = await tx
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, enrollmentId))
      .for('update');
    if (!current) throw err(404, 'NOT_FOUND', 'Inscripción no encontrada');
    const next = transition(current.status as EnrollmentState, 'cancel');
    if (!next)
      throw err(400, 'INVALID_STATE', `No se puede cancelar una inscripción ${current.status}`);
    const [updated] = await tx
      .update(enrollments)
      .set({ status: next, reservedUntil: null })
      .where(eq(enrollments.id, current.id))
      .returning();
    await syncEditionStatus(tx, edition);
    await writeAudit(tx, {
      actorId,
      action: 'enrollment.cancel',
      entityType: 'enrollment',
      entityId: current.id,
      before: { status: current.status, paid: current.paidAmount },
      after: { status: next },
    });
    if (!updated) throw new Error('No se pudo cancelar');
    return {
      enrollment: updated,
      freedSeat: (SEAT_STATES as readonly string[]).includes(current.status),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Lista de espera                                                     */
/* ------------------------------------------------------------------ */

const WAITLIST_PENDING_WINDOW_MS = 24 * 3_600_000;

/** Avisa a quienes están en lista cuando hay cupos libres (sin avisar de más). Idempotente. */
export async function notifyWaitlist(
  db: Db,
  mailer: Mailer,
  editionId: string,
  webUrl: string,
  now = new Date(),
): Promise<number> {
  const [edition] = await db
    .select()
    .from(courseEditions)
    .where(eq(courseEditions.id, editionId))
    .limit(1);
  if (!edition || !isEditionOpen(edition.status as EditionStatus, edition.enrollmentDeadline, now))
    return 0;
  const free = edition.maxSeats - (await occupiedSeats(db, editionId));
  const since = new Date(now.getTime() - WAITLIST_PENDING_WINDOW_MS);
  const [pend] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.editionId, editionId),
        eq(enrollments.status, 'lista'),
        sql`${enrollments.waitlistNotifiedAt} > ${since}`,
      ),
    );
  const slots = free - (pend?.n ?? 0);
  if (slots <= 0) return 0;

  const candidates = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.editionId, editionId),
        eq(enrollments.status, 'lista'),
        isNull(enrollments.waitlistNotifiedAt),
      ),
    )
    .orderBy(asc(enrollments.createdAt))
    .limit(slots);
  let sent = 0;
  for (const c of candidates) {
    const claimed = await db
      .update(enrollments)
      .set({ waitlistNotifiedAt: now })
      .where(and(eq(enrollments.id, c.id), isNull(enrollments.waitlistNotifiedAt)))
      .returning({ id: enrollments.id });
    if (claimed.length === 0) continue;
    await safeSend(mailer, mail.seatFreed(await emailContext(db, c, webUrl)));
    sent++;
  }
  return sent;
}

export { safeSend };
