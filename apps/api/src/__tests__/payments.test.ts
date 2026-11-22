import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  courseEditions,
  enrollments,
  orders,
  payments,
  products,
  webhookEvents,
} from '@prometeo/db';
import { sha256Hex, wompiIntegritySignature } from '@prometeo/shared';
import { cancelStaleOrders } from '../cron/tasks';
import { createTestContext, insertUser } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
let t: Ctx;
let admin: string;

const EVENTS_SECRET = 'test_events_secret';
const INTEGRITY = 'test_integrity_secret';
const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

/* ---------------------- utilidades ---------------------- */
async function signedEvent(o: {
  id?: string;
  status?: string;
  reference: string;
  amountInCents: number;
  currency?: string;
  secret?: string;
  timestamp?: number;
}) {
  const id = o.id ?? `tx-${Math.random().toString(36).slice(2, 10)}`;
  const status = o.status ?? 'APPROVED';
  const timestamp = o.timestamp ?? 1_700_000_000;
  const checksum = await sha256Hex(
    `${id}${status}${o.amountInCents}${timestamp}${o.secret ?? EVENTS_SECRET}`,
  );
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id,
        status,
        amount_in_cents: o.amountInCents,
        reference: o.reference,
        currency: o.currency ?? 'COP',
      },
    },
    environment: 'test',
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum,
    },
    timestamp,
    sent_at: new Date().toISOString(),
  };
}
const webhook = (event: unknown, headers: Record<string, string> = {}) =>
  t.request('/webhooks/wompi', { method: 'POST', body: JSON.stringify(event), headers });
const approve = async (reference: string, amount: number, over: Record<string, unknown> = {}) =>
  webhook(await signedEvent({ reference, amountInCents: amount * 100, ...over }));

async function mkProduct(over: Record<string, unknown> = {}) {
  const n = Math.random().toString(36).slice(2, 8);
  const res = await t.post(
    '/admin/products',
    {
      name: `Taza ${n}`,
      slug: `taza-${n}`,
      price: 45000,
      stock: 5,
      status: 'publicado',
      images: [],
      ...over,
    },
    admin,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

const person = {
  name: 'Ana Pérez',
  email: 'ana@correo.com',
  phone: '3001234567',
  acceptDataPolicy: true,
  acceptTerms: true,
};
const address = {
  departmentCode: '05',
  municipalityCode: '05001',
  address: 'Calle 10 # 20-30',
  neighborhood: 'Laureles',
};

interface OrderRes {
  order: { number: number; code: string; total: number; shipping: number };
  reference: string;
  token: string;
  checkoutUrl: string;
}
async function checkout(items: unknown[], over: Record<string, unknown> = {}) {
  const res = await t.post('/public/checkout/order', {
    items,
    shipping: address,
    ...person,
    ...over,
  });
  return { res, body: (await res.clone().json()) as OrderRes };
}
const line = (id: string, quantity = 1) => ({ type: 'product', id, quantity });

beforeEach(async () => {
  t = await createTestContext();
  await insertUser(t.db, 'admin@correo.com', 'clave-segura-123', 'ADMIN');
  admin = await t.login('admin@correo.com');
  await t.put(
    '/admin/settings',
    {
      shipping_flat_rate: 12000,
      free_shipping_threshold: 250000,
      contact: { email: 'taller@prometeo.co', phone: '', whatsapp: '', address: '', hours: '' },
    },
    admin,
  );
  t.outbox.length = 0;
});

/* ====================== CHECKOUT ====================== */
describe('checkout de pedidos', () => {
  it('calcula todo en el servidor, guarda la dirección DIVIPOLA y firma la URL de Wompi', async () => {
    const p = await mkProduct({ price: 45000 });
    const { res, body } = await checkout([{ ...line(p, 2), price: 1, unitPrice: 1 }]); // precios del cliente se ignoran
    expect(res.status).toBe(201);
    expect(body.order).toMatchObject({
      total: 102000,
      shipping: 12000,
      code: expect.stringMatching(/^PR-\d{6}$/),
    });

    const [o] = await t.db.select().from(orders);
    expect(o).toMatchObject({
      status: 'pendiente_pago',
      subtotal: 90000,
      shippingTotal: 12000,
      total: 102000,
      contactEmail: 'ana@correo.com',
      stockDeducted: false,
    });
    expect(o?.shippingAddress).toMatchObject({
      departmentName: 'Antioquia',
      municipalityName: 'Medellín',
      address: 'Calle 10 # 20-30',
    });
    const [pay] = await t.db.select().from(payments);
    expect(pay).toMatchObject({
      kind: 'order',
      status: 'pendiente',
      amount: 102000,
      currency: 'COP',
      purpose: 'total',
    });
    expect(pay?.reference).toBe(body.reference);

    const url = new URL(body.checkoutUrl);
    expect(url.origin + url.pathname).toBe('https://checkout.wompi.co/p/');
    expect(url.searchParams.get('public-key')).toBe('pub_test_abc123');
    expect(url.searchParams.get('amount-in-cents')).toBe('10200000');
    expect(url.searchParams.get('currency')).toBe('COP');
    expect(url.searchParams.get('reference')).toBe(body.reference);
    expect(url.searchParams.get('signature:integrity')).toBe(
      await wompiIntegritySignature({
        reference: body.reference,
        amountInCents: 10_200_000,
        secret: INTEGRITY,
      }),
    );
    expect(url.searchParams.get('redirect-url')).toContain(
      `/pago/resultado/${body.reference}/${body.token}`,
    );
    expect(body.checkoutUrl).not.toContain('integrity_secret');
    expect(t.outbox.at(-1)?.subject).toContain('Recibimos tu pedido');
  });

  it('envío gratis sobre el umbral y servicios sin envío ni dirección', async () => {
    const big = await mkProduct({ price: 300000 });
    expect((await checkout([line(big)])).body.order.shipping).toBe(0);
    const svc = (await (
      await t.post(
        '/admin/services',
        {
          name: 'Horno',
          slug: 'horno',
          mode: 'pago_online',
          price: 80000,
          status: 'publicado',
          images: [],
        },
        admin,
      )
    ).json()) as { item: { id: string } };
    const { res, body } = await checkout([{ type: 'service', id: svc.item.id, quantity: 1 }], {
      shipping: null,
    });
    expect(res.status).toBe(201);
    expect(body.order).toMatchObject({ total: 80000, shipping: 0 });
  });

  it('valida: dirección obligatoria, municipio coherente, autorizaciones y stock', async () => {
    const p = await mkProduct({ stock: 1 });
    expect((await checkout([line(p)], { shipping: null })).res.status).toBe(400);
    expect(
      (await checkout([line(p)], { shipping: { ...address, departmentCode: '76' } })).res.status,
    ).toBe(400);
    expect((await checkout([line(p)], { acceptTerms: false })).res.status).toBe(400);
    expect((await checkout([line(p)], { acceptDataPolicy: false })).res.status).toBe(400);
    const tooMany = await checkout([line(p, 3)]);
    expect(tooMany.res.status).toBe(409);
    expect(await t.db.select().from(orders)).toHaveLength(0);
    expect((await checkout([line('11111111-1111-4111-8111-111111111111')])).res.status).toBe(409);
    expect((await checkout([line(p)], { website: 'spam' })).res.status).toBe(400);
  });

  it('el enlace de invitado muestra el pedido y permite reintentar el pago', async () => {
    const p = await mkProduct();
    const { body } = await checkout([line(p)]);
    const view = (await (await t.request(`/public/orders/${body.token}`)).json()) as {
      order: { status: string; payable: boolean; total: number };
      items: { name: string }[];
    };
    expect(view.order).toMatchObject({ status: 'pendiente_pago', payable: true, total: 57000 });
    expect(view.items).toHaveLength(1);
    const again = await t.post(`/public/orders/${body.token}/pay`, {});
    expect(again.status).toBe(200);
    expect(((await again.json()) as { reference: string }).reference).not.toBe(body.reference);
    expect(await t.db.select().from(payments)).toHaveLength(2);
    expect((await t.request('/public/orders/' + 'x'.repeat(43))).status).toBe(404);
  });
});

/* ====================== WEBHOOK: FIRMA ====================== */
describe('webhook de Wompi: verificación de firma', () => {
  it('rechaza checksum inválido, secreto ajeno, datos alterados y header que no coincide', async () => {
    const p = await mkProduct();
    const { body } = await checkout([line(p)]);
    const amount = body.order.total * 100;

    const bad = await signedEvent({
      reference: body.reference,
      amountInCents: amount,
      secret: 'otro_secreto',
    });
    expect((await webhook(bad)).status).toBe(401);

    const tampered = await signedEvent({ reference: body.reference, amountInCents: amount });
    (tampered.data.transaction as Record<string, unknown>).status = 'DECLINED';
    expect((await webhook(tampered)).status).toBe(401);

    const ok = await signedEvent({ reference: body.reference, amountInCents: amount });
    expect((await webhook(ok, { 'x-event-checksum': 'ABC' })).status).toBe(401);

    // nada cambió
    const [o] = await t.db.select().from(orders);
    expect(o?.status).toBe('pendiente_pago');
    expect(await t.db.select().from(webhookEvents)).toHaveLength(0);
  });

  it('rechaza JSON inválido y estructuras ajenas; ignora eventos que no son de transacciones', async () => {
    expect((await t.request('/webhooks/wompi', { method: 'POST', body: '{no json' })).status).toBe(
      400,
    );
    expect((await webhook({ hola: 'mundo' })).status).toBe(400);
    const ev = await signedEvent({ reference: 'x', amountInCents: 100 });
    expect(
      (
        (await (await webhook({ ...ev, event: 'nequi_token.updated' })).json()) as {
          ignored: boolean;
        }
      ).ignored,
    ).toBe(true);
    expect(
      (await t.request('/webhooks/wompi', { method: 'POST', body: 'x'.repeat(100_001) })).status,
    ).toBe(413);
  });

  it('no exige cookies ni Origin (se autentica por firma)', async () => {
    const ev = await signedEvent({ reference: 'desconocida', amountInCents: 100 });
    const res = await t.app.request(
      '/webhooks/wompi',
      {
        method: 'POST',
        body: JSON.stringify(ev),
        headers: { 'Content-Type': 'application/json', Origin: 'https://wompi.co' },
      },
      (await import('./helpers')).env,
    );
    expect(res.status).toBe(200);
  });
});

/* ====================== WEBHOOK: APROBACIÓN ====================== */
describe('webhook de Wompi: pago aprobado', () => {
  it('marca pagado, descuenta stock, guarda la transacción y envía correos', async () => {
    const p = await mkProduct({ stock: 5 });
    const { body } = await checkout([line(p, 2)]);
    t.outbox.length = 0;
    const res = await approve(body.reference, body.order.total, { id: 'wompi-tx-1' });
    expect(((await res.json()) as { result: string }).result).toBe('processed');

    const [o] = await t.db.select().from(orders);
    expect(o).toMatchObject({ status: 'pagado', needsReview: false, stockDeducted: true });
    expect(o?.paidAt).not.toBeNull();
    const [pay] = await t.db.select().from(payments);
    expect(pay).toMatchObject({ status: 'aprobado', wompiTransactionId: 'wompi-tx-1' });
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(3);
    expect(t.outbox.map((e) => e.subject)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Pago aprobado'),
        expect.stringContaining('Nuevo pedido'),
      ]),
    );
    expect(t.outbox.find((e) => e.to === 'taller@prometeo.co')).toBeTruthy();
    expect((await t.db.select().from(webhookEvents))[0]?.processedAt).not.toBeNull();
  });

  it('es idempotente: el mismo evento repetido no descuenta stock dos veces', async () => {
    const p = await mkProduct({ stock: 5 });
    const { body } = await checkout([line(p, 2)]);
    const ev = await signedEvent({
      reference: body.reference,
      amountInCents: body.order.total * 100,
      id: 'tx-dup',
    });
    const first = (await (await webhook(ev)).json()) as { result: string };
    t.outbox.length = 0;
    const second = (await (await webhook(ev)).json()) as { result: string };
    const third = (await (await webhook(ev)).json()) as { result: string };
    expect([first.result, second.result, third.result]).toEqual([
      'processed',
      'duplicate',
      'duplicate',
    ]);
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(3);
    expect(t.outbox).toHaveLength(0);
    expect(await t.db.select().from(webhookEvents)).toHaveLength(1);
  });

  it('una segunda aprobación distinta sobre el mismo pago no se aplica dos veces', async () => {
    const p = await mkProduct({ stock: 5 });
    const { body } = await checkout([line(p)]);
    await approve(body.reference, body.order.total, { id: 'tx-a' });
    const r = (await (await approve(body.reference, body.order.total, { id: 'tx-b' })).json()) as {
      result: string;
    };
    expect(r.result).toBe('duplicate');
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(4);
  });

  it('revalida monto y moneda: si no coinciden no se paga y se marca para revisión', async () => {
    const p = await mkProduct();
    const { body } = await checkout([line(p)]);
    t.outbox.length = 0;
    expect(
      ((await (await approve(body.reference, 1000)).json()) as { result: string }).result,
    ).toBe('review');
    const [o] = await t.db.select().from(orders);
    expect(o).toMatchObject({ status: 'pendiente_pago', needsReview: true });
    const [pay] = await t.db.select().from(payments);
    expect(pay?.status).toBe('error');
    expect(pay?.note).toContain('REVISAR');
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(5);
    expect(t.outbox.some((e) => e.subject.includes('Requiere revisión'))).toBe(true);

    const other = await checkout([line(await mkProduct())]);
    await webhook(
      await signedEvent({
        reference: other.body.reference,
        amountInCents: other.body.order.total * 100,
        currency: 'USD',
      }),
    );
    expect(
      (await t.db.select().from(orders).where(eq(orders.number, other.body.order.number)))[0]
        ?.status,
    ).toBe('pendiente_pago');
  });

  it('referencia desconocida: se confirma (200) sin tocar nada', async () => {
    const res = await approve('ORD-0-inexistente', 10000);
    expect(((await res.json()) as { result: string }).result).toBe('ignored');
  });

  it('sin stock al confirmar: queda pagado pero marcado para revisión, sin descontar', async () => {
    const p = await mkProduct({ stock: 2 });
    const { body } = await checkout([line(p, 2)]);
    await t.db.update(products).set({ stock: 1 }).where(eq(products.id, p)); // otro cliente compró una unidad
    t.outbox.length = 0;
    const r = (await (await approve(body.reference, body.order.total)).json()) as {
      result: string;
    };
    expect(r.result).toBe('review');
    const [o] = await t.db.select().from(orders);
    expect(o).toMatchObject({ status: 'pagado', needsReview: true, stockDeducted: false });
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(1);
    expect((await t.db.select().from(payments))[0]?.note).toContain('sin stock');
    expect(t.outbox.some((e) => e.subject.includes('Requiere revisión'))).toBe(true);

    // El admin lo resuelve: no alcanza el stock -> 409; repone y descuenta -> 200
    const resolve = () =>
      t.post(`/admin/orders/${o?.id}/resolve-review`, { deductStock: true }, admin);
    expect((await resolve()).status).toBe(409);
    await t.db.update(products).set({ stock: 4 }).where(eq(products.id, p));
    expect((await resolve()).status).toBe(200);
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(2);
    expect((await t.db.select().from(orders))[0]).toMatchObject({
      needsReview: false,
      stockDeducted: true,
    });
  });

  it('carrera por la última unidad: solo uno recibe el stock, nunca queda negativo', async () => {
    const p = await mkProduct({ stock: 1 });
    const a = await checkout([line(p)], { email: 'a@correo.com' });
    const b = await checkout([line(p)], { email: 'b@correo.com' });
    const [ra, rb] = await Promise.all([
      approve(a.body.reference, a.body.order.total),
      approve(b.body.reference, b.body.order.total),
    ]);
    const results = [
      ((await ra.json()) as { result: string }).result,
      ((await rb.json()) as { result: string }).result,
    ].sort();
    expect(results).toEqual(['processed', 'review']);
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(0);
    expect(await t.db.select().from(orders).where(eq(orders.needsReview, true))).toHaveLength(1);
  });

  it('un pago aprobado en un pedido cancelado requiere revisión', async () => {
    const p = await mkProduct();
    const { body } = await checkout([line(p)]);
    const [o] = await t.db.select().from(orders);
    await t.request(`/admin/orders/${o?.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelado' }),
      cookies: admin,
    });
    const r = (await (await approve(body.reference, body.order.total)).json()) as {
      result: string;
    };
    expect(r.result).toBe('review');
    expect((await t.db.select().from(orders))[0]).toMatchObject({
      status: 'cancelado',
      needsReview: true,
    });
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(5);
  });
});

/* ====================== WEBHOOK: RECHAZOS ====================== */
describe('webhook de Wompi: rechazos', () => {
  it.each([
    ['DECLINED', 'rechazado'],
    ['ERROR', 'error'],
    ['VOIDED', 'anulado'],
  ])('%s marca el pago, no toca el stock y el pedido sigue pendiente', async (status, expected) => {
    const p = await mkProduct({ stock: 5 });
    const { body } = await checkout([line(p, 2)]);
    t.outbox.length = 0;
    const r = (await (await approve(body.reference, body.order.total, { status })).json()) as {
      result: string;
    };
    expect(r.result).toBe('rejected');
    expect((await t.db.select().from(payments))[0]?.status).toBe(expected);
    expect((await t.db.select().from(orders))[0]?.status).toBe('pendiente_pago');
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(5);
    expect(t.outbox.some((e) => e.subject.includes('no pudo completarse'))).toBe(true);
  });

  it('tras un rechazo se puede reintentar y pagar con éxito', async () => {
    const p = await mkProduct({ stock: 5 });
    const { body } = await checkout([line(p)]);
    await approve(body.reference, body.order.total, { status: 'DECLINED' });
    const retry = (await (await t.post(`/public/orders/${body.token}/pay`, {})).json()) as {
      reference: string;
    };
    await approve(retry.reference, body.order.total);
    expect((await t.db.select().from(orders))[0]?.status).toBe('pagado');
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(4);
  });

  it('PENDING no cambia nada; un pago aprobado no se revierte por un DECLINED tardío', async () => {
    const p = await mkProduct();
    const { body } = await checkout([line(p)]);
    expect(
      (
        (await (await approve(body.reference, body.order.total, { status: 'PENDING' })).json()) as {
          result: string;
        }
      ).result,
    ).toBe('pending');
    expect((await t.db.select().from(payments))[0]?.status).toBe('pendiente');
    await approve(body.reference, body.order.total, { id: 'ok' });
    await approve(body.reference, body.order.total, { id: 'ok', status: 'DECLINED' });
    expect((await t.db.select().from(payments))[0]?.status).toBe('aprobado');
    expect((await t.db.select().from(orders))[0]?.status).toBe('pagado');
  });

  it('VOIDED posterior a una aprobación se marca para revisión sin revertir', async () => {
    const p = await mkProduct();
    const { body } = await checkout([line(p)]);
    await approve(body.reference, body.order.total, { id: 'ok' });
    const r = (await (
      await approve(body.reference, body.order.total, { id: 'ok', status: 'VOIDED' })
    ).json()) as { result: string };
    expect(r.result).toBe('review');
    expect((await t.db.select().from(payments))[0]).toMatchObject({ status: 'aprobado' });
    expect((await t.db.select().from(payments))[0]?.note).toContain('anuló');
  });
});

/* ====================== INSCRIPCIONES ====================== */
describe('pagos de inscripciones con Wompi', () => {
  async function setup(over: Record<string, unknown> = {}, mode = 'abono') {
    const c = (await (
      await t.post(
        '/admin/courses',
        {
          name: 'Torno',
          slug: `torno-${Math.random().toString(36).slice(2, 6)}`,
          status: 'publicado',
          images: [],
        },
        admin,
      )
    ).json()) as { item: { id: string } };
    const e = (await (
      await t.post(
        '/admin/editions',
        {
          courseId: c.item.id,
          location: 'Taller',
          maxSeats: 2,
          price: 300000,
          enrollmentDeadline: iso(10 * DAY),
          allowedPaymentModes: ['total', 'reserva', 'abono', 'lista'],
          reservationHours: 48,
          depositType: 'porcentaje',
          depositValue: 30,
          balanceDueAt: iso(11 * DAY),
          sessions: [{ startsAt: iso(12 * DAY), endsAt: iso(12 * DAY + 3_600_000) }],
          ...over,
        },
        admin,
      )
    ).json()) as { item: { id: string } };
    const enr = (await (
      await t.post('/public/enrollments', {
        editionId: e.item.id,
        mode,
        ...person,
        email: `e${Math.random().toString(36).slice(2, 6)}@correo.com`,
        phone: '3001234567',
      })
    ).json()) as { token: string; enrollment: { id: string } };
    return { edition: e.item.id, token: enr.token, id: enr.enrollment.id };
  }
  const pay = async (token: string, type: 'full' | 'deposit') => {
    const res = await t.post(`/public/enrollments/${token}/pay`, { type });
    return {
      res,
      body: (await res.clone().json()) as {
        reference: string;
        amount: number;
        purpose: string;
        checkoutUrl: string;
      },
    };
  };

  it('abono y luego saldo: reservada → abonada → pagada, con firma y monto del servidor', async () => {
    const { token, id } = await setup();
    const dep = await pay(token, 'deposit');
    expect(dep.res.status).toBe(200);
    expect(dep.body).toMatchObject({ amount: 90000, purpose: 'abono' });
    expect(new URL(dep.body.checkoutUrl).searchParams.get('amount-in-cents')).toBe('9000000');
    t.outbox.length = 0;
    await approve(dep.body.reference, 90000);
    let [e] = await t.db.select().from(enrollments).where(eq(enrollments.id, id));
    expect(e).toMatchObject({ status: 'abonada', paidAmount: 90000, reservedUntil: null });
    expect(t.outbox.at(-1)?.subject).toContain('Recibimos tu pago');

    const bal = await pay(token, 'full');
    expect(bal.body).toMatchObject({ amount: 210000, purpose: 'saldo' });
    await approve(bal.body.reference, 210000);
    [e] = await t.db.select().from(enrollments).where(eq(enrollments.id, id));
    expect(e).toMatchObject({ status: 'pagada', paidAmount: 300000 });
    expect(t.outbox.at(-1)?.subject).toContain('Pago completo');
    expect((await pay(token, 'full')).res.status).toBe(409); // ya pagada
  });

  it('pago total directo; el abono solo existe para la modalidad abono', async () => {
    const a = await setup({}, 'total');
    expect((await pay(a.token, 'deposit')).res.status).toBe(400);
    const full = await pay(a.token, 'full');
    expect(full.body).toMatchObject({ amount: 300000, purpose: 'total' });
    await approve(full.body.reference, 300000);
    expect((await t.db.select().from(enrollments).where(eq(enrollments.id, a.id)))[0]?.status).toBe(
      'pagada',
    );
  });

  it('no se puede pagar desde la lista sin asegurar cupo', async () => {
    const l = await setup({}, 'lista');
    expect((await pay(l.token, 'full')).res.status).toBe(409);
  });

  it('crear el pago extiende la retención del cupo (no vence mientras se paga)', async () => {
    const { token, id } = await setup({}, 'reserva');
    await t.db
      .update(enrollments)
      .set({ reservedUntil: new Date(Date.now() + 5 * 60_000) })
      .where(eq(enrollments.id, id));
    await pay(token, 'full');
    const [e] = await t.db.select().from(enrollments).where(eq(enrollments.id, id));
    expect((e?.reservedUntil?.getTime() ?? 0) - Date.now()).toBeGreaterThan(50 * 60_000);
  });

  it('webhook idempotente: el mismo evento no suma el pago dos veces', async () => {
    const { token, id } = await setup();
    const dep = await pay(token, 'deposit');
    const ev = await signedEvent({
      reference: dep.body.reference,
      amountInCents: 9_000_000,
      id: 'dup-enr',
    });
    await webhook(ev);
    await webhook(ev);
    expect(
      (await t.db.select().from(enrollments).where(eq(enrollments.id, id)))[0]?.paidAmount,
    ).toBe(90000);
  });

  it('pago tardío tras vencer la reserva: se acepta si aún hay cupo', async () => {
    const { token, id } = await setup({}, 'total');
    const dep = await pay(token, 'full');
    await t.db
      .update(enrollments)
      .set({ status: 'vencida', reservedUntil: null })
      .where(eq(enrollments.id, id));
    await approve(dep.body.reference, 300000);
    expect((await t.db.select().from(enrollments).where(eq(enrollments.id, id)))[0]).toMatchObject({
      status: 'pagada',
      paidAmount: 300000,
    });
  });

  it('pago tardío sin cupo: queda aprobado pero marcado para revisión (sin cambiar la inscripción)', async () => {
    const a = await setup({ maxSeats: 1 }, 'total');
    const dep = await pay(a.token, 'full');
    await t.db
      .update(enrollments)
      .set({ status: 'vencida', reservedUntil: null })
      .where(eq(enrollments.id, a.id));
    // otra persona toma el único cupo
    await t.post('/public/enrollments', {
      editionId: a.edition,
      mode: 'reserva',
      ...person,
      email: 'otra@correo.com',
    });
    t.outbox.length = 0;
    const r = (await (await approve(dep.body.reference, 300000)).json()) as { result: string };
    expect(r.result).toBe('review');
    expect(
      (await t.db.select().from(enrollments).where(eq(enrollments.id, a.id)))[0],
    ).toMatchObject({ status: 'vencida', paidAmount: 0 });
    expect(
      (await t.db.select().from(payments).where(eq(payments.reference, dep.body.reference)))[0]
        ?.note,
    ).toContain('REVISAR');
    expect(
      await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'enrollment.payment_review')),
    ).toHaveLength(1);
    expect(t.outbox.some((e) => e.subject.includes('Requiere revisión'))).toBe(true);
  });

  it('un rechazo no cambia la inscripción', async () => {
    const { token, id } = await setup();
    const dep = await pay(token, 'deposit');
    await approve(dep.body.reference, 90000, { status: 'DECLINED' });
    expect((await t.db.select().from(enrollments).where(eq(enrollments.id, id)))[0]).toMatchObject({
      status: 'reservada',
      paidAmount: 0,
    });
    expect((await t.db.select().from(courseEditions))[0]?.status).toBe('abierta');
  });

  it('estado del pago por referencia para la página de resultado', async () => {
    const { token } = await setup();
    const dep = await pay(token, 'deposit');
    let r = (await (await t.request(`/public/payments/${dep.body.reference}`)).json()) as {
      payment: { status: string; kind: string };
    };
    expect(r.payment).toMatchObject({ status: 'pendiente', kind: 'enrollment' });
    await approve(dep.body.reference, 90000);
    r = (await (await t.request(`/public/payments/${dep.body.reference}`)).json()) as {
      payment: { status: string; kind: string };
    };
    expect(r.payment.status).toBe('aprobado');
    expect((await t.request('/public/payments/no-existe-esta-ref')).status).toBe(404);
  });
});

/* ====================== ADMIN: PEDIDOS Y COTIZACIONES ====================== */
describe('gestión de pedidos (admin)', () => {
  async function paidOrder(stock = 5, qty = 2) {
    const p = await mkProduct({ stock });
    const { body } = await checkout([line(p, qty)]);
    await approve(body.reference, body.order.total);
    const [o] = await t.db.select().from(orders).where(eq(orders.number, body.order.number));
    return { p, id: o?.id ?? '', token: body.token };
  }
  const setStatus = (id: string, status: string, trackingNumber?: string) =>
    t.request(`/admin/orders/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, trackingNumber }),
      cookies: admin,
    });

  it('avanza pagado → preparando → enviado (con guía y correo) → entregado', async () => {
    const { id } = await paidOrder();
    expect((await setStatus(id, 'preparando')).status).toBe(200);
    expect((await setStatus(id, 'enviado')).status).toBe(400); // exige guía
    t.outbox.length = 0;
    expect((await setStatus(id, 'enviado', 'SERV-998877')).status).toBe(200);
    expect(t.outbox.at(-1)?.text).toContain('SERV-998877');
    expect((await setStatus(id, 'entregado')).status).toBe(200);
    expect((await t.db.select().from(orders))[0]).toMatchObject({
      status: 'entregado',
      trackingNumber: 'SERV-998877',
    });
    expect(
      await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'order.status_change')),
    ).toHaveLength(3);
  });

  it('rechaza transiciones inválidas y no permite marcar pagado a mano', async () => {
    const p = await mkProduct();
    const { body } = await checkout([line(p)]);
    const [o] = await t.db.select().from(orders).where(eq(orders.number, body.order.number));
    expect((await setStatus(o?.id ?? '', 'pagado')).status).toBe(400);
    expect((await setStatus(o?.id ?? '', 'enviado', 'X')).status).toBe(400);
    const paid = await paidOrder();
    await setStatus(paid.id, 'preparando');
    await setStatus(paid.id, 'enviado', 'G1');
    expect((await setStatus(paid.id, 'cancelado')).status).toBe(400); // ya enviado
    expect((await setStatus(paid.id, 'preparando')).status).toBe(400); // no retrocede
  });

  it('cancelar un pedido pagado repone el stock (una sola vez)', async () => {
    const { p, id } = await paidOrder(5, 2);
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(3);
    const res = await setStatus(id, 'cancelado');
    expect(((await res.json()) as { restocked: boolean }).restocked).toBe(true);
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(5);
    expect((await setStatus(id, 'cancelado')).status).toBe(400);
    expect((await t.db.select().from(products).where(eq(products.id, p)))[0]?.stock).toBe(5);
  });

  it('lista con filtros (estado, revisión, búsqueda) y detalle con pagos', async () => {
    const a = await paidOrder();
    const p = await mkProduct({ stock: 1 });
    const { body } = await checkout([line(p)], { email: 'otra@correo.com', name: 'Otra Persona' });
    await t.db.update(products).set({ stock: 0 }).where(eq(products.id, p));
    await approve(body.reference, body.order.total);
    const list = async (qs: string) =>
      (await (await t.request(`/admin/orders?${qs}`, { cookies: admin })).json()) as {
        items: { code: string }[];
        total: number;
      };
    expect((await list('')).total).toBe(2);
    expect((await list('review=true')).items).toHaveLength(1);
    expect((await list('status=pagado')).total).toBe(2);
    expect((await list('q=otra@')).items).toHaveLength(1);
    expect((await list(`q=${body.order.number}`)).items[0]?.code).toBe(body.order.code);
    const detail = (await (
      await t.request(`/admin/orders/${a.id}`, { cookies: admin })
    ).json()) as {
      item: { items: unknown[]; payments: { status: string }[]; nextStatuses: string[] };
    };
    expect(detail.item.payments[0]?.status).toBe('aprobado');
    expect(detail.item.nextStatuses).toEqual(['preparando', 'cancelado']);
    expect((await t.request('/admin/orders')).status).toBe(401);
  });
});

describe('cotizaciones, cuenta del cliente y cron', () => {
  it('el admin gestiona las solicitudes: nueva → contactada → cerrada', async () => {
    await t.post('/public/quotes', {
      name: 'Ana',
      email: 'ana@correo.com',
      details: 'Queremos un taller grupal',
      acceptDataPolicy: true,
    });
    const list = (await (
      await t.request('/admin/quotes?status=nueva', { cookies: admin })
    ).json()) as { items: { id: string; status: string }[] };
    expect(list.items).toHaveLength(1);
    const id = list.items[0]?.id;
    expect(
      (
        await t.request(`/admin/quotes/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'contactada' }),
          cookies: admin,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (await (await t.request('/admin/quotes?status=nueva', { cookies: admin })).json()) as {
          items: unknown[];
        }
      ).items,
    ).toHaveLength(0);
    expect(
      (
        await t.request(`/admin/quotes/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'rara' }),
          cookies: admin,
        })
      ).status,
    ).toBe(400);
  });

  it('Mi cuenta: un cliente verificado ve sus pedidos e inscripciones y abre enlaces seguros', async () => {
    await insertUser(t.db, 'ana@correo.com', 'clave-segura-123', 'CLIENTE', true);
    const cookies = await t.login('ana@correo.com');
    const p = await mkProduct();
    const res = await t.request('/public/checkout/order', {
      method: 'POST',
      body: JSON.stringify({ items: [line(p)], shipping: address, ...person }),
      cookies,
    });
    expect(res.status).toBe(201);
    const sum = (await (await t.request('/account/summary', { cookies })).json()) as {
      orders: { id: string; code: string }[];
      enrollments: unknown[];
    };
    expect(sum.orders).toHaveLength(1);
    const link = (await (
      await t.post('/account/links', { type: 'order', id: sum.orders[0]?.id }, cookies)
    ).json()) as { token: string };
    expect((await t.request(`/public/orders/${link.token}`)).status).toBe(200);

    // los pedidos de otra persona no son accesibles
    await insertUser(t.db, 'otro@correo.com', 'clave-segura-123');
    expect(
      (
        await t.post(
          '/account/links',
          { type: 'order', id: sum.orders[0]?.id },
          await t.login('otro@correo.com'),
        )
      ).status,
    ).toBe(404);
    expect((await t.request('/account/summary')).status).toBe(401);
  });

  it('un invitado queda sin cuenta; el pedido se vincula al verificar su correo', async () => {
    const p = await mkProduct();
    await checkout([line(p)]);
    expect((await t.db.select().from(orders))[0]?.userId).toBeNull();
    await t.post('/auth/register', {
      email: 'ana@correo.com',
      password: 'clave-segura-123',
      name: 'Ana',
      acceptDataPolicy: true,
    });
    const mail = t.outbox.filter((e) => e.subject.includes('Verifica')).at(-1);
    await t.post('/auth/verify-email', { token: mail?.text.match(/token=([\w-]+)/)?.[1] });
    expect((await t.db.select().from(orders))[0]?.userId).not.toBeNull();
  });

  it('el cron cancela pedidos pendientes viejos sin pago aprobado (idempotente)', async () => {
    const p = await mkProduct();
    const old = await checkout([line(p)], { email: 'vieja@correo.com' });
    const fresh = await checkout([line(p)], { email: 'nueva@correo.com' });
    await t.db
      .update(orders)
      .set({ createdAt: new Date(Date.now() - 8 * DAY) })
      .where(eq(orders.number, old.body.order.number));
    expect(await cancelStaleOrders(t.db)).toBe(1);
    expect(await cancelStaleOrders(t.db)).toBe(0);
    expect(
      (await t.db.select().from(orders).where(eq(orders.number, old.body.order.number)))[0]?.status,
    ).toBe('cancelado');
    expect(
      (await t.db.select().from(orders).where(eq(orders.number, fresh.body.order.number)))[0]
        ?.status,
    ).toBe('pendiente_pago');
  });
});
