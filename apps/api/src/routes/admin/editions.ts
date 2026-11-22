import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { courseEditions, courses, editionSessions, enrollments } from '@prometeo/db';
import {
  PAYMENT_MODE_LABELS,
  editionSchema,
  editionStatusForSeats,
  idParamSchema,
  pendingAmount,
  type EditionStatus,
} from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { toCsv } from '../../lib/csv';
import { fmtDateTime } from '../../lib/dates';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';
import { occupiedSeats } from '../../services/enrollments.service';

export const editionsRoutes = new Hono<AppEnv>();
const notFound = () => new AuthError(404, 'NOT_FOUND', 'Edición no encontrada');

const listSchema = z.object({
  courseId: z.uuid().optional(),
  status: z.enum(['abierta', 'llena', 'cerrada', 'finalizada', 'cancelada']).optional(),
});

const OCC = sql<number>`(select count(*)::int from enrollments en where en.edition_id = "course_editions"."id" and en.status in ('reservada','abonada','pagada'))`;
const WAIT = sql<number>`(select count(*)::int from enrollments en where en.edition_id = "course_editions"."id" and en.status = 'lista')`;
const FIRST = sql<
  string | null
>`(select min(s.starts_at) from edition_sessions s where s.edition_id = "course_editions"."id")`;

editionsRoutes.get('/', validate('query', listSchema), async (c) => {
  const { courseId, status } = c.req.valid('query');
  const filters: SQL[] = [];
  if (courseId) filters.push(eq(courseEditions.courseId, courseId));
  if (status) filters.push(eq(courseEditions.status, status));
  const rows = await c
    .get('db')
    .select({
      id: courseEditions.id,
      courseId: courseEditions.courseId,
      courseName: courses.name,
      location: courseEditions.location,
      maxSeats: courseEditions.maxSeats,
      price: courseEditions.price,
      status: courseEditions.status,
      enrollmentDeadline: courseEditions.enrollmentDeadline,
      occupied: OCC,
      waitlist: WAIT,
      firstStart: FIRST,
    })
    .from(courseEditions)
    .innerJoin(courses, eq(courses.id, courseEditions.courseId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(courseEditions.createdAt))
    .limit(200);
  return c.json({ items: rows });
});

async function loadEdition(c: { get: (k: 'db') => AppEnv['Variables']['db'] }, id: string) {
  const db = c.get('db');
  const [row] = await db.select().from(courseEditions).where(eq(courseEditions.id, id)).limit(1);
  if (!row) throw notFound();
  const sessions = await db
    .select()
    .from(editionSessions)
    .where(eq(editionSessions.editionId, id))
    .orderBy(asc(editionSessions.startsAt));
  const occupied = await occupiedSeats(db, id);
  return { row, sessions, occupied };
}

editionsRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const { row, sessions, occupied } = await loadEdition(c, c.req.valid('param').id);
  const [course] = await c
    .get('db')
    .select({ name: courses.name, slug: courses.slug })
    .from(courses)
    .where(eq(courses.id, row.courseId))
    .limit(1);
  return c.json({
    item: { ...row, sessions, occupied, seatsLeft: Math.max(0, row.maxSeats - occupied), course },
  });
});

editionsRoutes.post('/', validate('json', editionSchema), async (c) => {
  const db = c.get('db');
  const { sessions, ...input } = c.req.valid('json');
  const [course] = await db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.id, input.courseId))
    .limit(1);
  if (!course) throw new AuthError(400, 'INVALID_COURSE', 'El curso no existe');
  const [row] = await db
    .insert(courseEditions)
    .values({
      ...input,
      enrollmentDeadline: new Date(input.enrollmentDeadline),
      balanceDueAt: input.balanceDueAt ? new Date(input.balanceDueAt) : null,
    })
    .returning();
  if (!row) throw new Error('No se pudo crear la edición');
  await db.insert(editionSessions).values(
    sessions.map((s) => ({
      editionId: row.id,
      startsAt: new Date(s.startsAt),
      endsAt: new Date(s.endsAt),
    })),
  );
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'edition.create',
    entityType: 'edition',
    entityId: row.id,
    after: { price: row.price, maxSeats: row.maxSeats },
  });
  return c.json({ item: row }, 201);
});

editionsRoutes.put(
  '/:id',
  validate('param', idParamSchema),
  validate('json', editionSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const { sessions, ...input } = c.req.valid('json');
    const { row: before, occupied } = await loadEdition(c, id);
    if (before.status === 'finalizada')
      throw new AuthError(400, 'FINALIZED', 'La edición ya finalizó y no se puede modificar');
    if (input.maxSeats < occupied)
      throw new AuthError(
        400,
        'SEATS_BELOW_OCCUPIED',
        `Ya hay ${occupied} cupos ocupados: no puedes bajar el máximo de ${occupied}`,
      );

    const requested = input.status as EditionStatus;
    const status =
      requested === 'abierta'
        ? editionStatusForSeats('abierta', occupied, input.maxSeats)
        : requested;
    const [row] = await db
      .update(courseEditions)
      .set({
        ...input,
        status,
        enrollmentDeadline: new Date(input.enrollmentDeadline),
        balanceDueAt: input.balanceDueAt ? new Date(input.balanceDueAt) : null,
      })
      .where(eq(courseEditions.id, id))
      .returning();
    await db.delete(editionSessions).where(eq(editionSessions.editionId, id));
    await db.insert(editionSessions).values(
      sessions.map((s) => ({
        editionId: id,
        startsAt: new Date(s.startsAt),
        endsAt: new Date(s.endsAt),
      })),
    );
    if (before.price !== input.price) {
      await writeAudit(db, {
        actorId: c.get('user')?.id ?? null,
        action: 'edition.price_change',
        entityType: 'edition',
        entityId: id,
        before: { price: before.price },
        after: { price: input.price },
      });
    }
    return c.json({ item: row });
  },
);

editionsRoutes.delete('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  await loadEdition(c, id);
  const [any] = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(eq(enrollments.editionId, id))
    .limit(1);
  if (any)
    throw new AuthError(
      400,
      'IN_USE',
      'La edición tiene inscripciones. Cancélala en lugar de eliminarla',
    );
  await db.delete(courseEditions).where(eq(courseEditions.id, id));
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'edition.delete',
    entityType: 'edition',
    entityId: id,
  });
  return c.json({ ok: true });
});

/* ---- Inscritos de una edición ---- */
async function listEnrollments(
  c: { get: (k: 'db') => AppEnv['Variables']['db'] },
  editionId: string,
) {
  return c
    .get('db')
    .select()
    .from(enrollments)
    .where(eq(enrollments.editionId, editionId))
    .orderBy(asc(enrollments.createdAt));
}

editionsRoutes.get('/:id/enrollments', validate('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const { row, occupied } = await loadEdition(c, id);
  const rows = await listEnrollments(c, id);
  const active = rows.filter(
    (r) => r.status !== 'vencida' && r.status !== 'cancelada' && r.status !== 'lista',
  );
  return c.json({
    edition: {
      id,
      maxSeats: row.maxSeats,
      occupied,
      seatsLeft: Math.max(0, row.maxSeats - occupied),
      status: row.status,
    },
    totals: {
      collected: rows.reduce((n, r) => n + r.paidAmount, 0),
      pending: active.reduce((n, r) => n + pendingAmount(r.totalAmount, r.paidAmount), 0),
    },
    items: rows.map((r) => ({
      id: r.id,
      name: r.contactName,
      email: r.contactEmail,
      phone: r.contactPhone,
      document: r.contactDocument,
      status: r.status,
      paymentMode: r.paymentMode,
      totalAmount: r.totalAmount,
      paidAmount: r.paidAmount,
      pendingAmount:
        r.status === 'vencida' || r.status === 'cancelada'
          ? 0
          : pendingAmount(r.totalAmount, r.paidAmount),
      reservedUntil: r.reservedUntil,
      createdAt: r.createdAt,
    })),
  });
});

editionsRoutes.get('/:id/enrollments/export', validate('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const { row } = await loadEdition(c, id);
  const [course] = await c
    .get('db')
    .select({ slug: courses.slug })
    .from(courses)
    .where(eq(courses.id, row.courseId))
    .limit(1);
  const rows = await listEnrollments(c, id);
  const csv = toCsv(
    [
      'Nombre',
      'Correo',
      'Teléfono',
      'Documento',
      'Estado',
      'Modalidad',
      'Total (COP)',
      'Pagado (COP)',
      'Pendiente (COP)',
      'Reserva hasta',
      'Inscrito el',
    ],
    rows.map((r) => [
      r.contactName,
      r.contactEmail,
      r.contactPhone,
      r.contactDocument,
      r.status,
      PAYMENT_MODE_LABELS[r.paymentMode],
      r.totalAmount,
      r.paidAmount,
      r.status === 'vencida' || r.status === 'cancelada'
        ? 0
        : pendingAmount(r.totalAmount, r.paidAmount),
      r.reservedUntil ? fmtDateTime(r.reservedUntil) : '',
      fmtDateTime(r.createdAt),
    ]),
  );
  await writeAudit(c.get('db'), {
    actorId: c.get('user')?.id ?? null,
    action: 'enrollments.export',
    entityType: 'edition',
    entityId: id,
    after: { rows: rows.length },
  });
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inscritos-${course?.slug ?? 'edicion'}-${id.slice(0, 8)}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
});
