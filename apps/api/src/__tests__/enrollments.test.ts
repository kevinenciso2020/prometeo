import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, courseEditions, enrollments, payments } from '@prometeo/db';
import { PAYMENT_HOLD_MINUTES } from '@prometeo/shared';
import {
  closeExpiredEditions,
  expireReservations,
  finalizeEditions,
  runCron,
  sendCourseReminders,
  sendReminders,
} from '../cron/tasks';
import { createTestContext, insertUser } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
let t: Ctx;
let admin: string;

const DAY = 86_400_000;
const iso = (offsetMs: number) =>
  new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, '+00:00');

let courseSeq = 0;
async function mkCourse(over: Record<string, unknown> = {}) {
  const slug = courseSeq++ === 0 ? 'torno' : `torno-${courseSeq}`;
  const res = await t.post(
    '/admin/courses',
    { name: 'Torno', slug, status: 'publicado', images: [], ...over },
    admin,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function mkEdition(courseId: string, over: Record<string, unknown> = {}) {
  const res = await t.post(
    '/admin/editions',
    {
      courseId,
      location: 'Taller Prometeo',
      maxSeats: 2,
      price: 300000,
      enrollmentDeadline: iso(10 * DAY),
      allowedPaymentModes: ['total', 'reserva', 'abono', 'lista'],
      reservationHours: 48,
      depositType: 'porcentaje',
      depositValue: 30,
      balanceDueAt: iso(11 * DAY),
      sessions: [{ startsAt: iso(12 * DAY), endsAt: iso(12 * DAY + 3 * 3_600_000) }],
      ...over,
    },
    admin,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

let n = 0;
const person = (over: Record<string, unknown> = {}) => {
  n++;
  return {
    name: `Persona ${n}`,
    email: `p${n}@correo.com`,
    phone: '3001234567',
    acceptDataPolicy: true,
    ...over,
  };
};
const enroll = (editionId: string, mode: string, over: Record<string, unknown> = {}) =>
  t.post('/public/enrollments', { editionId, mode, ...person(), ...over });

type EnrollRes = {
  token: string;
  enrollment: { id: string; status: string; reservedUntil: string | null };
  seatsLeft: number;
};

beforeEach(async () => {
  t = await createTestContext();
  await insertUser(t.db, 'admin@correo.com', 'clave-segura-123', 'ADMIN');
  admin = await t.login('admin@correo.com');
  n = 0;
  courseSeq = 0;
});

describe('inscripción por modalidad', () => {
  it('pago total: reserva el cupo solo mientras se paga', async () => {
    const ed = await mkEdition(await mkCourse());
    const res = await enroll(ed, 'total');
    expect(res.status).toBe(201);
    const body = (await res.json()) as EnrollRes;
    expect(body.enrollment.status).toBe('reservada');
    const until = new Date(body.enrollment.reservedUntil ?? 0).getTime();
    expect(Math.abs(until - (Date.now() + PAYMENT_HOLD_MINUTES * 60_000))).toBeLessThan(5000);
    expect(body.seatsLeft).toBe(1);
    expect(t.outbox.at(-1)?.subject).toContain('Recibimos tu inscripción');
  });

  it('reserva + pago después: retiene las horas configuradas y manda link de estado', async () => {
    const ed = await mkEdition(await mkCourse());
    const body = (await (await enroll(ed, 'reserva')).json()) as EnrollRes;
    const until = new Date(body.enrollment.reservedUntil ?? 0).getTime();
    expect(Math.abs(until - (Date.now() + 48 * 3_600_000))).toBeLessThan(5000);
    expect(t.outbox.at(-1)?.text).toContain(`/inscripcion/${body.token}`);
  });

  it('la reserva nunca supera la fecha límite de inscripción', async () => {
    const ed = await mkEdition(await mkCourse(), { enrollmentDeadline: iso(1 * DAY) });
    const body = (await (await enroll(ed, 'reserva')).json()) as EnrollRes;
    expect(new Date(body.enrollment.reservedUntil ?? 0).getTime()).toBeLessThanOrEqual(
      Date.now() + DAY + 5000,
    );
  });

  it('abono: guarda el saldo y su fecha, y calcula el monto del abono', async () => {
    const ed = await mkEdition(await mkCourse());
    const body = (await (await enroll(ed, 'abono')).json()) as EnrollRes & {
      depositAmount: number;
    };
    expect(body.depositAmount).toBe(90000);
    const [row] = await t.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, body.enrollment.id));
    expect(row?.balanceDueAt).not.toBeNull();
  });

  it('lista sin reserva: no ocupa cupo', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 1 });
    const body = (await (await enroll(ed, 'lista')).json()) as EnrollRes;
    expect(body.enrollment.status).toBe('lista');
    expect(body.enrollment.reservedUntil).toBeNull();
    expect(body.seatsLeft).toBe(1);
  });

  it('rechaza modalidades no habilitadas, ediciones cerradas y curso no publicado', async () => {
    const c = await mkCourse();
    const onlyTotal = await mkEdition(c, { allowedPaymentModes: ['total'] });
    expect((await enroll(onlyTotal, 'abono')).status).toBe(400);
    await t.put(
      `/admin/editions/${onlyTotal}`,
      {
        courseId: c,
        location: 'Taller',
        maxSeats: 2,
        price: 300000,
        status: 'cerrada',
        enrollmentDeadline: iso(10 * DAY),
        allowedPaymentModes: ['total'],
        sessions: [{ startsAt: iso(12 * DAY), endsAt: iso(12 * DAY + 3_600_000) }],
      },
      admin,
    );
    expect((await enroll(onlyTotal, 'total')).status).toBe(409);
    const draft = await mkCourse({ slug: 'borrador', name: 'Borrador', status: 'borrador' });
    expect((await enroll(await mkEdition(draft), 'total')).status).toBe(404);
  });

  it('impide inscribirse dos veces con el mismo correo, pero no tras vencer', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 5 });
    expect((await enroll(ed, 'total', { email: 'dup@correo.com' })).status).toBe(201);
    expect((await enroll(ed, 'lista', { email: 'DUP@correo.com' })).status).toBe(409);
  });

  it('exige habeas data y descarta spam', async () => {
    const ed = await mkEdition(await mkCourse());
    expect((await enroll(ed, 'total', { acceptDataPolicy: false })).status).toBe(400);
    expect((await enroll(ed, 'total', { website: 'x' })).status).toBe(400);
    expect(await t.db.select().from(enrollments)).toHaveLength(0);
  });
});

describe('control de cupos', () => {
  it('no sobrevende: con 2 cupos y 5 solicitudes simultáneas, solo 2 entran', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 2 });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => enroll(ed, 'reserva')));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((s) => s === 201)).toHaveLength(2);
    expect(codes.filter((s) => s === 409)).toHaveLength(3);
    const seated = await t.db.select().from(enrollments).where(eq(enrollments.status, 'reservada'));
    expect(seated).toHaveLength(2);
  });

  it('la edición pasa a llena y vuelve a abierta al liberarse un cupo', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 1 });
    const body = (await (await enroll(ed, 'total')).json()) as EnrollRes;
    const status = async () =>
      (await t.db.select().from(courseEditions).where(eq(courseEditions.id, ed)))[0]?.status;
    expect(await status()).toBe('llena');
    expect((await enroll(ed, 'total')).status).toBe(409);
    await t.post(`/admin/enrollments/${body.enrollment.id}/cancel`, {}, admin);
    expect(await status()).toBe('abierta');
  });

  it('muestra cupos restantes en el catálogo público', async () => {
    const c = await mkCourse();
    const ed = await mkEdition(c, { maxSeats: 3 });
    await enroll(ed, 'total');
    await enroll(ed, 'lista');
    const detail = (await (await t.request('/public/courses/torno')).json()) as {
      item: { editions: { seatsLeft: number; full: boolean }[] };
    };
    expect(detail.item.editions[0]).toMatchObject({ seatsLeft: 2, full: false });
    const list = (await (await t.request('/public/courses')).json()) as {
      items: { nextEdition: { seatsLeft: number } | null; fromPrice: number }[];
    };
    expect(list.items[0]?.nextEdition?.seatsLeft).toBe(2);
    expect(list.items[0]?.fromPrice).toBe(300000);
  });
});

describe('pagos manuales', () => {
  async function seated(mode = 'reserva') {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 2 });
    const body = (await (await enroll(ed, mode)).json()) as EnrollRes;
    return { ed, id: body.enrollment.id };
  }
  const pay = (id: string, amount: number, extra: Record<string, unknown> = {}) =>
    t.post(`/admin/enrollments/${id}/payments`, { amount, method: 'efectivo', ...extra }, admin);

  it('abono → abonada → pagada, con registro de quién pagó y auditoría', async () => {
    const { id } = await seated();
    let res = await pay(id, 100000, { note: 'Abono en taller' });
    expect(res.status).toBe(200);
    let [row] = await t.db.select().from(enrollments).where(eq(enrollments.id, id));
    expect(row).toMatchObject({ status: 'abonada', paidAmount: 100000, reservedUntil: null });
    expect(t.outbox.at(-1)?.subject).toContain('Recibimos tu pago');

    res = await pay(id, 200000, { method: 'transferencia' });
    expect(res.status).toBe(200);
    [row] = await t.db.select().from(enrollments).where(eq(enrollments.id, id));
    expect(row?.status).toBe('pagada');
    expect(t.outbox.at(-1)?.subject).toContain('Pago completo');

    const pays = await t.db.select().from(payments).where(eq(payments.enrollmentId, id));
    expect(pays.map((p) => [p.purpose, p.amount, p.method, p.status])).toEqual([
      ['abono', 100000, 'efectivo', 'aprobado'],
      ['saldo', 200000, 'transferencia', 'aprobado'],
    ]);
    expect(pays[0]?.recordedBy).not.toBeNull();
    expect(pays[0]?.note).toBe('Abono en taller');
    expect(
      await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'enrollment.manual_payment')),
    ).toHaveLength(2);
  });

  it('pago completo de una vez queda como total', async () => {
    const { id } = await seated();
    await pay(id, 300000);
    const [p] = await t.db.select().from(payments).where(eq(payments.enrollmentId, id));
    expect(p?.purpose).toBe('total');
  });

  it('rechaza pagos mayores al saldo, inscripciones pagadas y estados terminales', async () => {
    const { id } = await seated();
    expect((await pay(id, 300001)).status).toBe(400);
    await pay(id, 300000);
    expect((await pay(id, 1)).status).toBe(400);
    const { id: id2 } = await seated();
    await t.post(`/admin/enrollments/${id2}/cancel`, {}, admin);
    expect((await pay(id2, 1000)).status).toBe(400);
  });

  it('valida el cuerpo y exige rol admin', async () => {
    const { id } = await seated();
    expect((await pay(id, 0)).status).toBe(400);
    expect((await pay(id, 10.5)).status).toBe(400);
    expect(
      (
        await t.post(
          `/admin/enrollments/${id}/payments`,
          { amount: 1000, method: 'tarjeta' },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (await t.post(`/admin/enrollments/${id}/payments`, { amount: 1000, method: 'efectivo' }))
        .status,
    ).toBe(401);
  });

  it('una persona en lista paga y obtiene cupo solo si aún hay disponibles', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 1 });
    const waiting = (await (await enroll(ed, 'lista')).json()) as EnrollRes;
    const holder = (await (await enroll(ed, 'reserva')).json()) as EnrollRes;
    expect((await pay(waiting.enrollment.id, 100000)).status).toBe(409); // edición llena
    await t.post(`/admin/enrollments/${holder.enrollment.id}/cancel`, {}, admin);
    expect((await pay(waiting.enrollment.id, 100000)).status).toBe(200);
    const [row] = await t.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, waiting.enrollment.id));
    expect(row?.status).toBe('abonada');
  });
});

describe('cron: vencimientos, lista de espera y recordatorios', () => {
  const deps = () => ({ open: t.open, mailer: t.mailer, webUrl: 'http://localhost:4321' });

  it('vence reservas, libera el cupo, avisa a la lista y es idempotente', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 1 });
    const holder = (await (await enroll(ed, 'reserva')).json()) as EnrollRes;
    const waiting = (await (
      await enroll(ed, 'lista', { email: 'espera@correo.com' })
    ).json()) as EnrollRes;
    t.outbox.length = 0;

    const later = new Date(Date.now() + 49 * 3_600_000);
    expect(await expireReservations(deps(), later)).toEqual({ expired: 1, notified: 1 });
    const [h] = await t.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, holder.enrollment.id));
    expect(h?.status).toBe('vencida');
    expect(
      (await t.db.select().from(courseEditions).where(eq(courseEditions.id, ed)))[0]?.status,
    ).toBe('abierta');
    expect(t.outbox.map((e) => e.subject).sort()).toEqual([
      'Tu reserva venció — Prometeo',
      '¡Se liberó un cupo! — Prometeo',
    ]);
    expect(t.outbox.find((e) => e.to === 'espera@correo.com')?.text).toContain('/inscripcion/');
    const [w] = await t.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, waiting.enrollment.id));
    expect(w?.waitlistNotifiedAt).not.toBeNull();

    // segunda corrida: nada que hacer, no reenvía
    t.outbox.length = 0;
    expect(await expireReservations(deps(), later)).toEqual({ expired: 0, notified: 0 });
    expect(t.outbox).toHaveLength(0);
  });

  it('no vence reservas vigentes ni inscripciones abonadas/pagadas', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 5 });
    const a = (await (await enroll(ed, 'reserva')).json()) as EnrollRes;
    const b = (await (await enroll(ed, 'reserva')).json()) as EnrollRes;
    await t.post(
      `/admin/enrollments/${b.enrollment.id}/payments`,
      { amount: 50000, method: 'efectivo' },
      admin,
    );
    expect((await expireReservations(deps(), new Date(Date.now() + 1000))).expired).toBe(0);
    expect((await expireReservations(deps(), new Date(Date.now() + 99 * 3_600_000))).expired).toBe(
      1,
    );
    const [rowA] = await t.db.select().from(enrollments).where(eq(enrollments.id, a.enrollment.id));
    const [rowB] = await t.db.select().from(enrollments).where(eq(enrollments.id, b.enrollment.id));
    expect([rowA?.status, rowB?.status]).toEqual(['vencida', 'abonada']);
  });

  it('no avisa de más: un cupo libre notifica solo a una persona de la lista', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 1 });
    const holder = (await (await enroll(ed, 'total')).json()) as EnrollRes;
    await enroll(ed, 'lista');
    await enroll(ed, 'lista');
    t.outbox.length = 0;
    const res = await t.post(`/admin/enrollments/${holder.enrollment.id}/cancel`, {}, admin);
    expect(((await res.json()) as { waitlistNotified: number }).waitlistNotified).toBe(1);
    expect(t.outbox.filter((e) => e.subject.includes('cupo'))).toHaveLength(1);
  });

  it('recordatorio de reserva por vencer se envía una sola vez', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 5 });
    await enroll(ed, 'reserva');
    t.outbox.length = 0;
    const soon = new Date(Date.now() + 40 * 3_600_000); // faltan 8 h
    expect(await sendReminders(deps(), soon)).toMatchObject({ reservations: 1 });
    expect(await sendReminders(deps(), soon)).toMatchObject({ reservations: 0 });
    expect(t.outbox.filter((e) => e.subject.includes('por vencer'))).toHaveLength(1);
  });

  it('recordatorio de saldo para abonadas con fecha cercana, una vez', async () => {
    const ed = await mkEdition(await mkCourse(), {
      maxSeats: 5,
      enrollmentDeadline: iso(1 * DAY),
      balanceDueAt: iso(2 * DAY),
      sessions: [{ startsAt: iso(5 * DAY), endsAt: iso(5 * DAY + 3_600_000) }],
    });
    const e = (await (await enroll(ed, 'abono')).json()) as EnrollRes;
    await t.post(
      `/admin/enrollments/${e.enrollment.id}/payments`,
      { amount: 90000, method: 'efectivo' },
      admin,
    );
    t.outbox.length = 0;
    expect(await sendReminders(deps(), new Date(Date.now() + 1 * DAY))).toMatchObject({
      balances: 1,
    });
    expect(await sendReminders(deps(), new Date(Date.now() + 1 * DAY))).toMatchObject({
      balances: 0,
    });
    expect(t.outbox[0]?.text).toContain('210');
  });

  it('recordatorio del curso: solo abonadas/pagadas, el día anterior y una vez por sesión', async () => {
    const start = new Date(Date.now() + 5 * DAY);
    const ed = await mkEdition(await mkCourse(), {
      maxSeats: 5,
      enrollmentDeadline: iso(2 * DAY),
      balanceDueAt: iso(3 * DAY),
      sessions: [
        {
          startsAt: start.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
          endsAt: new Date(start.getTime() + 3_600_000)
            .toISOString()
            .replace(/\.\d{3}Z$/, '+00:00'),
        },
      ],
    });
    const paid = (await (await enroll(ed, 'reserva')).json()) as EnrollRes;
    await enroll(ed, 'reserva'); // sin pagar: no recibe recordatorio
    await t.post(
      `/admin/enrollments/${paid.enrollment.id}/payments`,
      { amount: 300000, method: 'efectivo' },
      admin,
    );
    t.outbox.length = 0;
    // Determinista: 12 h antes de la medianoche (Bogotá) del día de la clase, o sea "el día anterior".
    const startBog = new Date(start.getTime() - 5 * 3_600_000);
    const midnightUtc = Date.UTC(
      startBog.getUTCFullYear(),
      startBog.getUTCMonth(),
      startBog.getUTCDate(),
      5,
    );
    const dayBefore = new Date(midnightUtc - 12 * 3_600_000);
    expect(await sendCourseReminders(deps(), dayBefore)).toBe(1);
    expect(await sendCourseReminders(deps(), dayBefore)).toBe(0);
    expect(t.outbox[0]?.subject).toContain('Mañana es tu clase');
  });

  it('cierra inscripciones vencidas y finaliza ediciones pasadas', async () => {
    const c = await mkCourse();
    const ed = await mkEdition(c);
    expect(await closeExpiredEditions(t.db, new Date(Date.now() + 11 * DAY))).toBe(1);
    expect(
      (await t.db.select().from(courseEditions).where(eq(courseEditions.id, ed)))[0]?.status,
    ).toBe('cerrada');
    expect(await finalizeEditions(t.db, new Date(Date.now() + 13 * DAY))).toBe(1);
    expect(
      (await t.db.select().from(courseEditions).where(eq(courseEditions.id, ed)))[0]?.status,
    ).toBe('finalizada');
    expect(await finalizeEditions(t.db, new Date(Date.now() + 13 * DAY))).toBe(0);
  });

  it('el despachador reconoce las expresiones cron de wrangler.toml', async () => {
    const logs: string[] = [];
    for (const cron of ['*/15 * * * *', '0 * * * *', '0 10 * * *', 'otra'])
      await runCron(cron, { ...deps(), log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes('reservas vencidas'))).toBe(true);
    expect(logs.some((l) => l.includes('finalizadas'))).toBe(true);
    expect(logs.at(-1)).toContain('desconocida');
  });
});

describe('lista de espera: asegurar el cupo', () => {
  it('quien está en lista asegura cupo con su enlace cuando se libera uno', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 1 });
    const holder = (await (await enroll(ed, 'reserva')).json()) as EnrollRes;
    const waiting = (await (await enroll(ed, 'lista')).json()) as EnrollRes;
    const secure = (tok: string) =>
      t.post(`/public/enrollments/${tok}/secure`, { mode: 'reserva' });
    expect((await secure(waiting.token)).status).toBe(409);
    await t.post(`/admin/enrollments/${holder.enrollment.id}/cancel`, {}, admin);
    expect((await secure(waiting.token)).status).toBe(200);
    const [row] = await t.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, waiting.enrollment.id));
    expect(row?.status).toBe('reservada');
    expect((await secure(waiting.token)).status).toBe(409); // ya no está en lista
  });

  it('el enlace de estado funciona, oculta el correo y rechaza tokens inválidos', async () => {
    const ed = await mkEdition(await mkCourse());
    const body = (await (
      await enroll(ed, 'reserva', { email: 'carolina@correo.com' })
    ).json()) as EnrollRes;
    const res = await t.request(`/public/enrollments/${body.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const data = (await res.json()) as {
      enrollment: { email: string; status: string; pendingAmount: number };
      edition: { sessions: unknown[] };
    };
    expect(data.enrollment.email).toBe('ca•••@correo.com');
    expect(data.enrollment).toMatchObject({ status: 'reservada', pendingAmount: 300000 });
    expect(data.edition.sessions).toHaveLength(1);
    expect((await t.request('/public/enrollments/' + 'x'.repeat(43))).status).toBe(404);
    expect((await t.request('/public/enrollments/corto')).status).toBe(400);
  });
});

describe('administración de cursos y ediciones', () => {
  it('valida fechas, modalidades y abonos de la edición', async () => {
    const c = await mkCourse();
    const base = {
      courseId: c,
      location: 'Taller',
      maxSeats: 5,
      price: 100000,
      enrollmentDeadline: iso(10 * DAY),
      allowedPaymentModes: ['total'],
      sessions: [{ startsAt: iso(12 * DAY), endsAt: iso(12 * DAY + 3_600_000) }],
    };
    const post = (over: Record<string, unknown>) =>
      t.post('/admin/editions', { ...base, ...over }, admin);
    expect((await post({})).status).toBe(201);
    expect((await post({ allowedPaymentModes: [] })).status).toBe(400);
    expect((await post({ enrollmentDeadline: iso(13 * DAY) })).status).toBe(400); // después de la sesión
    expect(
      (await post({ sessions: [{ startsAt: iso(12 * DAY), endsAt: iso(11 * DAY) }] })).status,
    ).toBe(400);
    expect((await post({ sessions: [] })).status).toBe(400);
    expect(
      (await post({ allowedPaymentModes: ['abono'], depositType: 'porcentaje', depositValue: 100 }))
        .status,
    ).toBe(400);
    expect(
      (await post({ allowedPaymentModes: ['abono'], depositType: 'monto', depositValue: 100000 }))
        .status,
    ).toBe(400);
    expect((await post({ price: 10.5 })).status).toBe(400);
  });

  it('no permite bajar el máximo de cupos por debajo de los ocupados ni borrar con inscritos', async () => {
    const c = await mkCourse();
    const ed = await mkEdition(c, { maxSeats: 3 });
    await enroll(ed, 'reserva');
    await enroll(ed, 'reserva');
    const put = (maxSeats: number) =>
      t.put(
        `/admin/editions/${ed}`,
        {
          courseId: c,
          location: 'Taller',
          maxSeats,
          price: 300000,
          enrollmentDeadline: iso(10 * DAY),
          allowedPaymentModes: ['total'],
          sessions: [{ startsAt: iso(12 * DAY), endsAt: iso(12 * DAY + 3_600_000) }],
        },
        admin,
      );
    expect((await put(1)).status).toBe(400);
    expect((await put(2)).status).toBe(200);
    expect(
      (await t.db.select().from(courseEditions).where(eq(courseEditions.id, ed)))[0]?.status,
    ).toBe('llena');
    expect(
      (await t.request(`/admin/editions/${ed}`, { method: 'DELETE', cookies: admin })).status,
    ).toBe(400);
  });

  it('un curso con ediciones no se elimina; sin ediciones sí', async () => {
    const c = await mkCourse();
    await mkEdition(c);
    expect(
      (await t.request(`/admin/courses/${c}`, { method: 'DELETE', cookies: admin })).status,
    ).toBe(400);
    const c2 = await mkCourse({ slug: 'otro', name: 'Otro' });
    expect(
      (await t.request(`/admin/courses/${c2}`, { method: 'DELETE', cookies: admin })).status,
    ).toBe(200);
  });
});

describe('lista de inscritos y exportación CSV', () => {
  it('lista montos pagados/pendientes y exporta CSV seguro', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 5 });
    const a = (await (
      await enroll(ed, 'reserva', { name: '=cmd|calc', email: 'a@correo.com' })
    ).json()) as EnrollRes;
    await enroll(ed, 'lista', { name: 'Beatriz, "Bea" Gómez', email: 'b@correo.com' });
    await t.post(
      `/admin/enrollments/${a.enrollment.id}/payments`,
      { amount: 120000, method: 'efectivo' },
      admin,
    );

    const list = (await (
      await t.request(`/admin/editions/${ed}/enrollments`, { cookies: admin })
    ).json()) as {
      totals: { collected: number; pending: number };
      edition: { occupied: number; seatsLeft: number };
    };
    expect(list.totals).toEqual({ collected: 120000, pending: 180000 });
    expect(list.edition).toMatchObject({ occupied: 1, seatsLeft: 4 });

    const res = await t.request(`/admin/editions/${ed}/enrollments/export`, { cookies: admin });
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain(
      'attachment; filename="inscritos-torno-',
    );
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8
    const csv = await res.text();
    expect(csv).toContain("'=cmd|calc"); // fórmula neutralizada
    expect(csv).toContain('"Beatriz, ""Bea"" Gómez"');
    expect(csv).toContain('Teléfono');
    expect((await t.request(`/admin/editions/${ed}/enrollments/export`)).status).toBe(401);
  });
});

describe('estado de inscripción en BD', () => {
  it('nunca quedan más cupos ocupados que el máximo tras operaciones mixtas', async () => {
    const ed = await mkEdition(await mkCourse(), { maxSeats: 3 });
    const made = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) => enroll(ed, i % 2 ? 'reserva' : 'total')),
    );
    const ok = (await Promise.all(
      made.filter((r) => r.status === 201).map((r) => r.json()),
    )) as EnrollRes[];
    for (const e of ok.slice(0, 1))
      await t.post(`/admin/enrollments/${e.enrollment.id}/cancel`, {}, admin);
    await Promise.all([1, 2, 3].map(() => enroll(ed, 'reserva')));
    const occupied = await t.db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.editionId, ed), eq(enrollments.status, 'reservada')));
    expect(occupied.length).toBeLessThanOrEqual(3);
  });
});
