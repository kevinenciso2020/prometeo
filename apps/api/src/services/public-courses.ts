import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { courseEditions, editionSessions, type Db } from '@prometeo/db';
import { computeDeposit, isEditionOpen, type EditionStatus } from '@prometeo/shared';

const OCCUPIED = sql<number>`(select count(*)::int from enrollments en where en.edition_id = "course_editions"."id" and en.status in ('reservada','abonada','pagada'))`;

/** Ediciones vigentes (abiertas o llenas, aún no finalizadas) con cupos restantes y sesiones. */
export async function loadPublicEditions(db: Db, opts: { courseId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({
      id: courseEditions.id,
      courseId: courseEditions.courseId,
      location: courseEditions.location,
      instructor: courseEditions.instructor,
      maxSeats: courseEditions.maxSeats,
      price: courseEditions.price,
      enrollmentDeadline: courseEditions.enrollmentDeadline,
      status: courseEditions.status,
      allowedPaymentModes: courseEditions.allowedPaymentModes,
      reservationHours: courseEditions.reservationHours,
      depositType: courseEditions.depositType,
      depositValue: courseEditions.depositValue,
      balanceDueAt: courseEditions.balanceDueAt,
      occupied: OCCUPIED,
    })
    .from(courseEditions)
    .where(
      and(
        inArray(courseEditions.status, ['abierta', 'llena']),
        gt(courseEditions.enrollmentDeadline, now),
        opts.courseId ? eq(courseEditions.courseId, opts.courseId) : undefined,
      ),
    );
  if (rows.length === 0) return [];
  const sessions = await db
    .select({
      editionId: editionSessions.editionId,
      startsAt: editionSessions.startsAt,
      endsAt: editionSessions.endsAt,
    })
    .from(editionSessions)
    .where(
      inArray(
        editionSessions.editionId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(editionSessions.startsAt));

  return rows
    .map((e) => {
      const seatsLeft = Math.max(0, e.maxSeats - e.occupied);
      const mine = sessions
        .filter((s) => s.editionId === e.id)
        .map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt }));
      return {
        id: e.id,
        courseId: e.courseId,
        location: e.location,
        instructor: e.instructor,
        price: e.price,
        maxSeats: e.maxSeats,
        seatsLeft,
        enrollmentDeadline: e.enrollmentDeadline,
        allowedPaymentModes: e.allowedPaymentModes,
        reservationHours: e.reservationHours,
        depositAmount: computeDeposit(e.price, e.depositType, e.depositValue),
        balanceDueAt: e.balanceDueAt,
        open: isEditionOpen(e.status as EditionStatus, e.enrollmentDeadline, now),
        full: seatsLeft === 0,
        sessions: mine,
        firstStart: mine[0]?.startsAt ?? null,
      };
    })
    .sort((a, b) => (a.firstStart?.getTime() ?? Infinity) - (b.firstStart?.getTime() ?? Infinity));
}
