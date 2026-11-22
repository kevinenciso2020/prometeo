import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLogs,
  courseEditions,
  enrollments,
  orderItems,
  orders,
  payments,
  products,
  webhookEvents,
  type Db,
} from '@prometeo/db';
import {
  PAYMENT_HOLD_MINUTES,
  computeDeposit,
  computeReservedUntil,
  eventForPayment,
  pendingAmount,
  transition,
  type EnrollmentState,
  type WompiStatus,
  type WompiTransactionInfo,
} from '@prometeo/shared';
import { depositReceived, paymentComplete } from '../lib/enrollment-emails';
import { adminNewOrder, adminReview, orderPaid, paymentRejected } from '../lib/order-emails';
import { randomHex } from '../lib/random';
import type { Mailer } from '../lib/mailer';
import { withTransaction, type PoolOpener } from '../lib/tx';
import { AuthError } from './auth.service';
import { emailContext, occupiedSeats, safeSend, syncEditionStatus } from './enrollments.service';
import { recordRedemption } from './discounts';
import { issueGuestLink } from './guest-links';
import { loadOrderWithItems, orderEmailCtx } from './orders.service';
import { loadSettings } from './settings';
import { buildWompiCheckout } from '../lib/wompi';
import type { Bindings } from '../env';

type Payment = typeof payments.$inferSelect;
type Enrollment = typeof enrollments.$inferSelect;

export interface PaymentDeps {
  db: Db;
  open: PoolOpener;
  mailer: Mailer;
  webUrl: string;
}

export type WebhookResult =
  'processed' | 'duplicate' | 'ignored' | 'review' | 'rejected' | 'pending';

type Outcome =
  | { type: 'noop' }
  | { type: 'order_paid'; orderId: string; review: boolean }
  | { type: 'order_review'; orderId: string; reason: string }
  | { type: 'enrollment_paid'; enrollmentId: string; fullyPaid: boolean }
  | { type: 'enrollment_review'; enrollmentId: string; reason: string };

const STATUS_TO_PAYMENT: Record<
  Exclude<WompiStatus, 'APPROVED' | 'PENDING'>,
  'rechazado' | 'error' | 'anulado'
> = {
  DECLINED: 'rechazado',
  ERROR: 'error',
  VOIDED: 'anulado',
};

/**
 * Procesa un evento de Wompi YA VERIFICADO (checksum válido). Idempotente:
 * - webhook_events tiene (provider, event_id) único; un evento repetido se ignora.
 * - un pago aprobado no se vuelve a aplicar.
 * La verdad del pago viene SOLO de aquí, nunca del redirect del navegador.
 */
export async function handleWompiTransaction(
  deps: PaymentDeps,
  tx: WompiTransactionInfo,
  rawEvent: unknown,
): Promise<WebhookResult> {
  const { db } = deps;
  const eventId = `${tx.id}:${tx.status}`;
  const inserted = await db
    .insert(webhookEvents)
    .values({ provider: 'wompi', eventId, payload: rawEvent as object })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (inserted.length === 0) {
    const [existing] = await db
      .select({ processedAt: webhookEvents.processedAt })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, 'wompi'), eq(webhookEvents.eventId, eventId)))
      .limit(1);
    if (existing?.processedAt) return 'duplicate';
    // Existe pero no terminó de procesarse (fallo previo): se reintenta; la lógica de negocio es idempotente.
  }

  const finish = async (result: WebhookResult): Promise<WebhookResult> => {
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(and(eq(webhookEvents.provider, 'wompi'), eq(webhookEvents.eventId, eventId)));
    return result;
  };

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.reference, tx.reference))
    .limit(1);
  if (!payment) return finish('ignored');

  // Revalida monto y moneda contra la BD (el monto del evento nunca se acepta a ciegas).
  if (tx.amountInCents !== payment.amount * 100 || tx.currency !== 'COP') {
    await flagPayment(
      db,
      payment,
      `monto/moneda no coinciden (evento ${tx.amountInCents} ${tx.currency}, esperado ${payment.amount * 100} COP)`,
      tx,
    );
    await notifyAdmin(
      deps,
      `Pago ${payment.reference}`,
      `Wompi reportó ${tx.amountInCents} centavos ${tx.currency} para la referencia ${payment.reference}, pero se esperaba ${payment.amount * 100} COP. No se aplicó el pago.`,
    );
    return finish('review');
  }

  if (tx.status === 'PENDING') return finish('pending');

  if (tx.status !== 'APPROVED') {
    const next = STATUS_TO_PAYMENT[tx.status];
    if (payment.status === 'aprobado') {
      // Anulación posterior a una aprobación (p. ej. reverso): no se revierte stock automáticamente.
      if (tx.status === 'VOIDED') {
        await db
          .update(payments)
          .set({ note: 'REVISAR: Wompi anuló una transacción ya aprobada' })
          .where(eq(payments.id, payment.id));
        await notifyAdmin(
          deps,
          `Pago ${payment.reference}`,
          `Wompi anuló (VOIDED) una transacción previamente aprobada para ${payment.reference}. Revisa el pedido o inscripción.`,
        );
        return finish('review');
      }
      return finish('ignored');
    }
    await db
      .update(payments)
      .set({ status: next, wompiTransactionId: tx.id, wompiRaw: rawEvent as object })
      .where(
        and(
          eq(payments.id, payment.id),
          inArray(payments.status, ['pendiente', 'rechazado', 'error']),
        ),
      );
    await sendRejection(deps, payment);
    return finish('rejected');
  }

  const outcome = await approve(deps, payment, tx, rawEvent);
  await afterApproval(deps, outcome);
  return finish(
    outcome.type === 'order_review' ||
      outcome.type === 'enrollment_review' ||
      (outcome.type === 'order_paid' && outcome.review)
      ? 'review'
      : outcome.type === 'noop'
        ? 'duplicate'
        : 'processed',
  );
}

async function flagPayment(
  db: Db,
  payment: Payment,
  reason: string,
  tx: WompiTransactionInfo,
): Promise<void> {
  await db
    .update(payments)
    .set({ status: 'error', note: `REVISAR: ${reason}`, wompiTransactionId: tx.id })
    .where(and(eq(payments.id, payment.id), eq(payments.status, 'pendiente')));
  if (payment.orderId)
    await db.update(orders).set({ needsReview: true }).where(eq(orders.id, payment.orderId));
}

async function notifyAdmin(deps: PaymentDeps, subject: string, detail: string): Promise<void> {
  const to = (await loadSettings(deps.db)).contact.email;
  if (to) await safeSend(deps.mailer, adminReview(to, subject, detail));
}

/** Aprobación: dentro de una transacción con bloqueo de filas (orden/productos o edición/inscripción). */
async function approve(
  deps: PaymentDeps,
  payment: Payment,
  tx: WompiTransactionInfo,
  rawEvent: unknown,
): Promise<Outcome> {
  return withTransaction(deps.open, async (t) => {
    const [pay] = await t.select().from(payments).where(eq(payments.id, payment.id)).for('update');
    if (!pay || pay.status === 'aprobado') return { type: 'noop' } as const;
    if (pay.status === 'anulado') return { type: 'noop' } as const;
    const now = new Date();
    const markApproved = async (note: string | null = null) => {
      await t
        .update(payments)
        .set({
          status: 'aprobado',
          wompiTransactionId: tx.id,
          wompiRaw: rawEvent as object,
          paidAt: now,
          note,
        })
        .where(eq(payments.id, pay.id));
    };

    /* ----------------------------- PEDIDOS ----------------------------- */
    if (pay.kind === 'order' && pay.orderId) {
      const [order] = await t.select().from(orders).where(eq(orders.id, pay.orderId)).for('update');
      if (!order) {
        await markApproved('REVISAR: el pedido no existe');
        return { type: 'noop' } as const;
      }
      if (order.status !== 'pendiente_pago') {
        // Pago aprobado en un pedido que ya no es pagable (cancelado o ya pagado): requiere revisión humana.
        await markApproved(`REVISAR: pago aprobado en un pedido ${order.status}`);
        await t.update(orders).set({ needsReview: true }).where(eq(orders.id, order.id));
        return {
          type: 'order_review',
          orderId: order.id,
          reason: `Pago aprobado en pedido ${order.status}`,
        } as const;
      }
      const items = await t.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      const needs = new Map<string, number>();
      for (const it of items)
        if (it.productId) needs.set(it.productId, (needs.get(it.productId) ?? 0) + it.quantity);
      const ids = [...needs.keys()].sort(); // orden fijo => sin interbloqueos
      let enough = true;
      if (ids.length) {
        const rows = await t
          .select({ id: products.id, stock: products.stock })
          .from(products)
          .where(inArray(products.id, ids))
          .orderBy(products.id)
          .for('update');
        enough = ids.every(
          (id) => (rows.find((r) => r.id === id)?.stock ?? 0) >= (needs.get(id) ?? 0),
        );
        if (enough) {
          for (const id of ids) {
            await t
              .update(products)
              .set({ stock: sql`${products.stock} - ${needs.get(id) ?? 0}` })
              .where(eq(products.id, id));
          }
        }
      }
      await markApproved(enough ? null : 'REVISAR: sin stock al confirmar el pago');
      await t
        .update(orders)
        .set({
          status: 'pagado',
          paidAt: now,
          needsReview: !enough,
          stockDeducted: enough && ids.length > 0,
        })
        .where(eq(orders.id, order.id));
      if (order.couponId) {
        await recordRedemption(t, {
          couponId: order.couponId,
          orderId: order.id,
          email: order.contactEmail,
          discountAmount: order.discountTotal,
        });
      }
      return { type: 'order_paid', orderId: order.id, review: !enough } as const;
    }

    /* ---------------------------- INSCRIPCIONES ---------------------------- */
    if (pay.kind === 'enrollment' && pay.enrollmentId) {
      const [pre] = await t
        .select({ editionId: enrollments.editionId })
        .from(enrollments)
        .where(eq(enrollments.id, pay.enrollmentId))
        .limit(1);
      if (!pre) {
        await markApproved('REVISAR: la inscripción no existe');
        return { type: 'noop' } as const;
      }
      const [edition] = await t
        .select()
        .from(courseEditions)
        .where(eq(courseEditions.id, pre.editionId))
        .for('update');
      const [e] = await t
        .select()
        .from(enrollments)
        .where(eq(enrollments.id, pay.enrollmentId))
        .for('update');
      if (!e || !edition) {
        await markApproved('REVISAR: inscripción o edición inexistente');
        return { type: 'noop' } as const;
      }
      const flag = async (reason: string) => {
        await markApproved(`REVISAR: ${reason}`);
        await t.insert(auditLogs).values({
          actorId: null,
          action: 'enrollment.payment_review',
          entityType: 'enrollment',
          entityId: e.id,
          after: { reason, payment: pay.reference },
        });
        return { type: 'enrollment_review', enrollmentId: e.id, reason } as const;
      };

      if (e.status === 'cancelada') return flag('pago aprobado en una inscripción cancelada');
      if (e.status === 'pagada' || pay.amount > pendingAmount(e.totalAmount, e.paidAmount))
        return flag('el pago supera el saldo pendiente');

      // Una reserva vencida o una persona en lista paga: solo se acepta si todavía hay cupo.
      let from = e.status as EnrollmentState;
      if (from === 'vencida' || from === 'lista') {
        if ((await occupiedSeats(t, edition.id)) >= edition.maxSeats)
          return flag(`pago aprobado pero ya no hay cupos (inscripción ${from})`);
        from = 'reservada';
      }
      const paidAfter = e.paidAmount + pay.amount;
      const next = transition(from, eventForPayment(paidAfter, e.totalAmount));
      if (!next) return flag('transición de estado no permitida');
      await markApproved();
      await t
        .update(enrollments)
        .set({
          status: next,
          paidAmount: paidAfter,
          reservedUntil: null,
          reservationReminderSentAt: null,
        })
        .where(eq(enrollments.id, e.id));
      await syncEditionStatus(t, edition);
      if (e.couponId) {
        await recordRedemption(t, {
          couponId: e.couponId,
          enrollmentId: e.id,
          email: e.contactEmail,
          discountAmount: e.discountAmount,
        });
      }
      return { type: 'enrollment_paid', enrollmentId: e.id, fullyPaid: next === 'pagada' } as const;
    }

    await markApproved('REVISAR: pago sin pedido ni inscripción');
    return { type: 'noop' } as const;
  });
}

async function afterApproval(deps: PaymentDeps, outcome: Outcome): Promise<void> {
  const { db, mailer, webUrl } = deps;
  const adminTo = (await loadSettings(db)).contact.email;
  if (outcome.type === 'order_paid' || outcome.type === 'order_review') {
    const data = await loadOrderWithItems(db, outcome.orderId);
    if (!data) return;
    const token = await issueGuestLink(db, 'order', data.order.id, data.order.contactEmail);
    const ctx = orderEmailCtx(data.order, data.items, webUrl, token);
    if (outcome.type === 'order_paid') {
      await safeSend(mailer, orderPaid(ctx));
      if (adminTo) await safeSend(mailer, adminNewOrder(adminTo, ctx, data.order.contactEmail));
      if (outcome.review)
        await notifyAdmin(
          deps,
          `Pedido PR-${data.order.number}`,
          `El pago del pedido ${data.order.number} fue aprobado pero NO había stock suficiente al confirmar. No se descontó inventario: revisa el pedido en el panel.`,
        );
    } else {
      await notifyAdmin(
        deps,
        `Pedido PR-${data.order.number}`,
        `${outcome.reason}. Revisa el pedido ${data.order.number} en el panel.`,
      );
    }
  } else if (outcome.type === 'enrollment_paid' || outcome.type === 'enrollment_review') {
    const [e] = await db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, outcome.enrollmentId))
      .limit(1);
    if (!e) return;
    if (outcome.type === 'enrollment_paid') {
      const ctx = await emailContext(db, e, webUrl);
      await safeSend(mailer, outcome.fullyPaid ? paymentComplete(ctx) : depositReceived(ctx));
    } else {
      await notifyAdmin(
        deps,
        `Inscripción de ${e.contactName}`,
        `${outcome.reason}. Inscripción ${e.id}. Revisa el pago en el panel.`,
      );
    }
  }
}

async function sendRejection(deps: PaymentDeps, payment: Payment): Promise<void> {
  if (payment.kind === 'order' && payment.orderId) {
    const data = await loadOrderWithItems(deps.db, payment.orderId);
    if (!data || data.order.status !== 'pendiente_pago') return;
    const token = await issueGuestLink(deps.db, 'order', data.order.id, data.order.contactEmail);
    await safeSend(
      deps.mailer,
      paymentRejected(orderEmailCtx(data.order, data.items, deps.webUrl, token)),
    );
  } else if (payment.enrollmentId) {
    const [e] = await deps.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, payment.enrollmentId))
      .limit(1);
    if (!e) return;
    const ctx = await emailContext(deps.db, e, deps.webUrl);
    await safeSend(deps.mailer, {
      to: ctx.to,
      subject: 'Tu pago no pudo completarse — Prometeo',
      text: `Hola ${ctx.name},\n\nTu pago para ${ctx.courseName} no pudo completarse. No se te cobró. Puedes intentarlo de nuevo: ${ctx.statusUrl}`,
      html: `<p>Hola ${ctx.name},</p><p>Tu pago para <strong>${ctx.courseName}</strong> no pudo completarse. No se te cobró.</p><p><a href="${ctx.statusUrl}">Intentar de nuevo</a></p>`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Pagos de inscripciones (total, abono, saldo)                        */
/* ------------------------------------------------------------------ */

export async function createEnrollmentPayment(
  db: Db,
  env: Bindings,
  enrollment: Enrollment,
  token: string,
  type: 'full' | 'deposit',
  now = new Date(),
) {
  if (enrollment.status !== 'reservada' && enrollment.status !== 'abonada') {
    throw new AuthError(
      409,
      'INVALID_STATE',
      enrollment.status === 'lista'
        ? 'Primero asegura tu cupo'
        : `No se puede pagar una inscripción ${enrollment.status}`,
    );
  }
  const pending = pendingAmount(enrollment.totalAmount, enrollment.paidAmount);
  if (pending <= 0) throw new AuthError(409, 'ALREADY_PAID', 'Esta inscripción ya está pagada');
  const [edition] = await db
    .select()
    .from(courseEditions)
    .where(eq(courseEditions.id, enrollment.editionId))
    .limit(1);
  if (!edition) throw new AuthError(404, 'NOT_FOUND', 'Edición no encontrada');

  let amount = pending;
  let purpose: 'total' | 'abono' | 'saldo' = enrollment.paidAmount > 0 ? 'saldo' : 'total';
  if (type === 'deposit') {
    if (
      enrollment.paymentMode !== 'abono' ||
      enrollment.paidAmount > 0 ||
      !edition.allowedPaymentModes.includes('abono')
    ) {
      throw new AuthError(
        400,
        'DEPOSIT_NOT_ALLOWED',
        'El abono no está disponible para esta inscripción',
      );
    }
    amount = Math.min(
      pending,
      computeDeposit(enrollment.totalAmount, edition.depositType, edition.depositValue),
    );
    purpose = amount >= pending ? 'total' : 'abono';
  }

  // Mientras se paga, el cupo no debe vencer: se extiende la retención (sin pasar de la fecha límite).
  if (enrollment.status === 'reservada') {
    const hold = computeReservedUntil(
      now,
      'total',
      edition.reservationHours,
      edition.enrollmentDeadline,
    );
    if (hold && (!enrollment.reservedUntil || hold > enrollment.reservedUntil)) {
      await db
        .update(enrollments)
        .set({ reservedUntil: hold })
        .where(and(eq(enrollments.id, enrollment.id), eq(enrollments.status, 'reservada')));
    }
  }

  const [payment] = await db
    .insert(payments)
    .values({
      kind: 'enrollment',
      enrollmentId: enrollment.id,
      purpose,
      amount,
      method: 'wompi',
      status: 'pendiente',
      reference: `INS-${randomHex(4)}-${randomHex(5)}`,
    })
    .returning();
  if (!payment) throw new Error('No se pudo crear el pago');
  const checkout = await buildWompiCheckout(env, {
    reference: payment.reference,
    amount,
    redirectUrl: `${env.WEB_URL}/pago/resultado/${payment.reference}/${token}`,
    email: enrollment.contactEmail,
    fullName: enrollment.contactName,
    phone: enrollment.contactPhone,
  });
  return { payment, checkout, holdMinutes: PAYMENT_HOLD_MINUTES };
}

export async function paymentStatus(db: Db, reference: string) {
  const [p] = await db
    .select({
      status: payments.status,
      kind: payments.kind,
      amount: payments.amount,
      purpose: payments.purpose,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .where(eq(payments.reference, reference))
    .limit(1);
  return p ?? null;
}
