import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  campaigns,
  coupons,
  courseEditions,
  editionSessions,
  enrollments,
  orders,
  type Db,
} from '@prometeo/db';
import type { Mailer } from '../lib/mailer';
import { tomorrowRangeBogota } from '../lib/dates';
import * as mail from '../lib/enrollment-emails';
import { withTransaction, type PoolOpener } from '../lib/tx';
import {
  emailContext,
  notifyWaitlist,
  safeSend,
  syncEditionStatus,
} from '../services/enrollments.service';

export interface CronDeps {
  open: PoolOpener;
  mailer: Mailer;
  webUrl: string;
  log?: (msg: string) => void;
}

const HOUR = 3_600_000;

/** Cada 15 min: vence reservas, libera cupos y avisa a la lista de espera. Idempotente. */
export async function expireReservations(
  deps: CronDeps,
  now = new Date(),
): Promise<{ expired: number; notified: number }> {
  const handle = deps.open();
  try {
    const db = handle.db;
    const due = await db
      .select({ id: enrollments.id, editionId: enrollments.editionId })
      .from(enrollments)
      .where(and(eq(enrollments.status, 'reservada'), lte(enrollments.reservedUntil, now)))
      .limit(500);

    const expiredIds: string[] = [];
    const editions = new Set<string>();
    for (const row of due) {
      const done = await withTransaction(
        () => ({ db, close: async () => undefined }),
        async (tx) => {
          const [edition] = await tx
            .select()
            .from(courseEditions)
            .where(eq(courseEditions.id, row.editionId))
            .for('update');
          // Re-verifica bajo bloqueo: pudo pagarse entre la consulta y ahora.
          const claimed = await tx
            .update(enrollments)
            .set({ status: 'vencida', reservedUntil: null })
            .where(
              and(
                eq(enrollments.id, row.id),
                eq(enrollments.status, 'reservada'),
                lte(enrollments.reservedUntil, now),
              ),
            )
            .returning({ id: enrollments.id });
          if (claimed.length === 0 || !edition) return false;
          await syncEditionStatus(tx, edition);
          return true;
        },
      );
      if (done) {
        expiredIds.push(row.id);
        editions.add(row.editionId);
      }
    }

    for (const id of expiredIds) {
      const [e] = await db.select().from(enrollments).where(eq(enrollments.id, id)).limit(1);
      if (e)
        await safeSend(
          deps.mailer,
          mail.reservationExpired(await emailContext(db, e, deps.webUrl)),
        );
    }
    let notified = 0;
    for (const editionId of editions)
      notified += await notifyWaitlist(db, deps.mailer, editionId, deps.webUrl, now);
    deps.log?.(`[cron] reservas vencidas=${expiredIds.length} avisos_lista=${notified}`);
    return { expired: expiredIds.length, notified };
  } finally {
    await handle.close();
  }
}

/** Cada hora: recordatorio de reservas que vencen en <12 h y de saldos que vencen en <48 h. */
export async function sendReminders(
  deps: CronDeps,
  now = new Date(),
): Promise<{ reservations: number; balances: number }> {
  const handle = deps.open();
  try {
    const db = handle.db;
    let reservations = 0;
    let balances = 0;

    const resv = await db
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.status, 'reservada'),
          eq(enrollments.paymentMode, 'reserva'),
          sql`${enrollments.reservedUntil} > ${now}`,
          sql`${enrollments.reservedUntil} <= ${new Date(now.getTime() + 12 * HOUR)}`,
          sql`${enrollments.reservationReminderSentAt} is null`,
        ),
      )
      .limit(500);
    for (const e of resv) {
      const claimed = await db
        .update(enrollments)
        .set({ reservationReminderSentAt: now })
        .where(
          and(
            eq(enrollments.id, e.id),
            sql`${enrollments.reservationReminderSentAt} is null`,
            eq(enrollments.status, 'reservada'),
          ),
        )
        .returning({ id: enrollments.id });
      if (claimed.length === 0) continue;
      await safeSend(deps.mailer, mail.reservationReminder(await emailContext(db, e, deps.webUrl)));
      reservations++;
    }

    const bal = await db
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.status, 'abonada'),
          sql`${enrollments.balanceDueAt} > ${now}`,
          sql`${enrollments.balanceDueAt} <= ${new Date(now.getTime() + 48 * HOUR)}`,
          sql`${enrollments.balanceReminderSentAt} is null`,
        ),
      )
      .limit(500);
    for (const e of bal) {
      const claimed = await db
        .update(enrollments)
        .set({ balanceReminderSentAt: now })
        .where(
          and(
            eq(enrollments.id, e.id),
            sql`${enrollments.balanceReminderSentAt} is null`,
            eq(enrollments.status, 'abonada'),
          ),
        )
        .returning({ id: enrollments.id });
      if (claimed.length === 0) continue;
      await safeSend(deps.mailer, mail.balanceReminder(await emailContext(db, e, deps.webUrl)));
      balances++;
    }
    deps.log?.(`[cron] recordatorios reservas=${reservations} saldos=${balances}`);
    return { reservations, balances };
  } finally {
    await handle.close();
  }
}

/** Cierra inscripciones con fecha límite vencida (cada hora). */
export async function closeExpiredEditions(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(courseEditions)
    .set({ status: 'cerrada' })
    .where(
      and(
        inArray(courseEditions.status, ['abierta', 'llena']),
        lte(courseEditions.enrollmentDeadline, now),
      ),
    )
    .returning({ id: courseEditions.id });
  return rows.length;
}

/** Diario: marca como finalizadas las ediciones cuya última sesión ya terminó. */
export async function finalizeEditions(db: Db, now = new Date()): Promise<number> {
  const res = await db.execute(sql`
    update course_editions e set status = 'finalizada', updated_at = now()
    where e.status in ('abierta','llena','cerrada')
      and exists (select 1 from edition_sessions s where s.edition_id = e.id)
      and not exists (select 1 from edition_sessions s where s.edition_id = e.id and s.ends_at > ${now})
    returning e.id`);
  const rows = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
  return Array.isArray(rows) ? rows.length : 0;
}

/** Diario: desactiva campañas y cupones cuya vigencia ya terminó. Idempotente. */
export async function deactivateExpiredMarketing(
  db: Db,
  now = new Date(),
): Promise<{ campaigns: number; coupons: number }> {
  const c = await db
    .update(campaigns)
    .set({ isActive: false })
    .where(and(eq(campaigns.isActive, true), lte(campaigns.endsAt, now)))
    .returning({ id: campaigns.id });
  const k = await db
    .update(coupons)
    .set({ isActive: false })
    .where(
      and(eq(coupons.isActive, true), sql`${coupons.endsAt} is not null`, lte(coupons.endsAt, now)),
    )
    .returning({ id: coupons.id });
  return { campaigns: c.length, coupons: k.length };
}

/** Diario: cancela pedidos sin pago aprobado tras N días (por defecto 7). Idempotente. */
export async function cancelStaleOrders(db: Db, now = new Date(), days = 7): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * HOUR);
  const rows = await db
    .update(orders)
    .set({ status: 'cancelado' })
    .where(
      and(
        eq(orders.status, 'pendiente_pago'),
        lte(orders.createdAt, cutoff),
        sql`not exists (select 1 from payments p where p.order_id = ${orders.id} and p.status = 'aprobado')`,
      ),
    )
    .returning({ id: orders.id });
  return rows.length;
}

/** Diario: recordatorio de las clases del día siguiente (Bogotá), una vez por sesión. */
export async function sendCourseReminders(deps: CronDeps, now = new Date()): Promise<number> {
  const handle = deps.open();
  try {
    const db = handle.db;
    const { start, end } = tomorrowRangeBogota(now);
    const sessions = await db
      .select({ editionId: editionSessions.editionId, startsAt: editionSessions.startsAt })
      .from(editionSessions)
      .where(
        and(
          sql`${editionSessions.startsAt} >= ${start}`,
          sql`${editionSessions.startsAt} < ${end}`,
        ),
      );
    let sent = 0;
    for (const s of sessions) {
      const people = await db
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.editionId, s.editionId),
            inArray(enrollments.status, ['abonada', 'pagada']),
            sql`(${enrollments.lastSessionReminderFor} is null or ${enrollments.lastSessionReminderFor} <> ${s.startsAt})`,
          ),
        );
      for (const e of people) {
        const claimed = await db
          .update(enrollments)
          .set({ lastSessionReminderFor: s.startsAt })
          .where(
            and(
              eq(enrollments.id, e.id),
              sql`(${enrollments.lastSessionReminderFor} is null or ${enrollments.lastSessionReminderFor} <> ${s.startsAt})`,
            ),
          )
          .returning({ id: enrollments.id });
        if (claimed.length === 0) continue;
        await safeSend(
          deps.mailer,
          mail.courseReminder(await emailContext(db, e, deps.webUrl), s.startsAt),
        );
        sent++;
      }
    }
    deps.log?.(`[cron] recordatorios de curso=${sent}`);
    return sent;
  } finally {
    await handle.close();
  }
}

/** Despacha según la expresión cron configurada en wrangler.toml. */
export async function runCron(cron: string, deps: CronDeps, now = new Date()): Promise<void> {
  const log = deps.log ?? console.log;
  const d = { ...deps, log };
  switch (cron) {
    case '*/15 * * * *':
      await expireReservations(d, now);
      break;
    case '0 * * * *': {
      const h = deps.open();
      try {
        log(`[cron] ediciones cerradas=${await closeExpiredEditions(h.db, now)}`);
      } finally {
        await h.close();
      }
      await sendReminders(d, now);
      break;
    }
    case '0 10 * * *': {
      await sendCourseReminders(d, now);
      const h = deps.open();
      try {
        log(`[cron] ediciones finalizadas=${await finalizeEditions(h.db, now)}`);
        log(`[cron] pedidos sin pago cancelados=${await cancelStaleOrders(h.db, now)}`);
        const off = await deactivateExpiredMarketing(h.db, now);
        log(`[cron] campañas desactivadas=${off.campaigns} cupones desactivados=${off.coupons}`);
      } finally {
        await h.close();
      }
      break;
    }
    default:
      log(`[cron] expresión desconocida: ${cron}`);
  }
}
