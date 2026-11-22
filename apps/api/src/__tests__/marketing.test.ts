import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLogs,
  campaignEvents,
  campaigns,
  couponRedemptions,
  coupons,
  enrollments,
  orders,
} from '@prometeo/db';
import { sha256Hex } from '@prometeo/shared';
import { deactivateExpiredMarketing } from '../cron/tasks';
import { createTestContext, env, insertUser, setCookies } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
let t: Ctx;
let admin: string;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const EVENTS_SECRET = 'test_events_secret';

/* ---------------- utilidades ---------------- */
async function approveEvent(reference: string, amount: number, status = 'APPROVED', id?: string) {
  const txId = id ?? `tx-${Math.random().toString(36).slice(2, 9)}`;
  const timestamp = 1_700_000_000;
  const checksum = await sha256Hex(`${txId}${status}${amount * 100}${timestamp}${EVENTS_SECRET}`);
  return t.request('/webhooks/wompi', {
    method: 'POST',
    body: JSON.stringify({
      event: 'transaction.updated',
      data: {
        transaction: {
          id: txId,
          status,
          amount_in_cents: amount * 100,
          reference,
          currency: 'COP',
        },
      },
      signature: {
        properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
        checksum,
      },
      timestamp,
    }),
  });
}

async function mkCategory(name = 'Tazas') {
  const res = await t.post(
    '/admin/categories',
    { name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 6)}` },
    admin,
  );
  return ((await res.json()) as { item: { id: string } }).item.id;
}
async function mkProduct(over: Record<string, unknown> = {}) {
  const n = Math.random().toString(36).slice(2, 8);
  const res = await t.post(
    '/admin/products',
    {
      name: `Taza ${n}`,
      slug: `taza-${n}`,
      price: 50_000,
      stock: 10,
      status: 'publicado',
      images: [],
      ...over,
    },
    admin,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}
async function mkCoupon(over: Record<string, unknown> = {}) {
  const res = await t.post(
    '/admin/coupons',
    { code: 'PROMO10', type: 'porcentaje', value: 10, appliesTo: 'todo', ...over },
    admin,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

const person = {
  name: 'Ana Pérez',
  email: 'ana@correo.com',
  phone: '3001234567',
  acceptDataPolicy: true,
  acceptTerms: true,
};
const address = { departmentCode: '05', municipalityCode: '05001', address: 'Calle 10 # 20-30' };
const line = (id: string, quantity = 1) => ({ type: 'product', id, quantity });
interface CheckoutRes {
  order: { number: number; total: number; shipping: number };
  reference: string;
  checkoutUrl: string;
  token: string;
}
async function checkout(
  items: unknown[],
  couponCode?: string | null,
  over: Record<string, unknown> = {},
) {
  const res = await t.post('/public/checkout/order', {
    items,
    shipping: address,
    couponCode,
    ...person,
    ...over,
  });
  return {
    res,
    body: (await res.clone().json()) as CheckoutRes & { error?: { code: string; message: string } },
  };
}
interface Quote {
  subtotal: number;
  itemDiscount: number;
  shipping: number;
  total: number;
  coupon: {
    applied: { code: string | null; isAutomatic: boolean } | null;
    status: string;
    message: string | null;
  };
}
const quote = async (items: unknown[], couponCode?: string) =>
  (await (await t.post('/public/cart/quote', { items, couponCode })).json()) as Quote;

beforeEach(async () => {
  t = await createTestContext();
  await insertUser(t.db, 'admin@correo.com', 'clave-segura-123', 'ADMIN');
  admin = await t.login('admin@correo.com');
  await t.put(
    '/admin/settings',
    { shipping_flat_rate: 12000, free_shipping_threshold: 250000 },
    admin,
  );
});

/* ====================== CUPONES: ADMIN ====================== */
describe('gestión de cupones (admin)', () => {
  it('crea cupones normalizando el código y exige rol admin', async () => {
    const id = await mkCoupon({ code: 'verano20', value: 20 });
    const [row] = await t.db.select().from(coupons).where(eq(coupons.id, id));
    expect(row?.code).toBe('VERANO20');
    expect(
      (await t.post('/admin/coupons', { code: 'X1X', type: 'porcentaje', value: 5 })).status,
    ).toBe(401);
    expect(
      await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'coupon.create')),
    ).toHaveLength(1);
  });

  it('el código es único sin distinguir mayúsculas', async () => {
    await mkCoupon({ code: 'ABC123' });
    expect(
      (await t.post('/admin/coupons', { code: 'abc123', type: 'porcentaje', value: 5 }, admin))
        .status,
    ).toBe(409);
  });

  it('valida reglas del cupón y que los elementos objetivo existan', async () => {
    const bad = (over: Record<string, unknown>) =>
      t.post('/admin/coupons', { code: 'ZZZ', type: 'porcentaje', value: 10, ...over }, admin);
    expect((await bad({ value: 150 })).status).toBe(400);
    expect((await bad({ code: null })).status).toBe(400);
    expect((await bad({ appliesTo: 'categorias', targetIds: [] })).status).toBe(400);
    expect(
      (await bad({ appliesTo: 'categorias', targetIds: ['11111111-1111-4111-8111-111111111111'] }))
        .status,
    ).toBe(400);
    expect((await bad({ startsAt: iso(DAY), endsAt: iso(0) })).status).toBe(400);
    const cat = await mkCategory();
    expect((await bad({ appliesTo: 'categorias', targetIds: [cat] })).status).toBe(201);
  });

  it('descuento automático: sin código; lista filtrable con usos', async () => {
    await mkCoupon({ code: null, isAutomatic: true, value: 5 });
    await mkCoupon({ code: 'MANUAL' });
    const autos = (await (
      await t.request('/admin/coupons?kind=automatico', { cookies: admin })
    ).json()) as { items: { isAutomatic: boolean; uses: number }[] };
    expect(autos.items).toHaveLength(1);
    expect(autos.items[0]).toMatchObject({ isAutomatic: true, uses: 0 });
  });

  it('un cupón con usos no se elimina (se desactiva para conservar historial)', async () => {
    const id = await mkCoupon();
    const p = await mkProduct();
    const { body } = await checkout([line(p)], 'PROMO10');
    await approveEvent(body.reference, body.order.total);
    expect(
      (await t.request(`/admin/coupons/${id}`, { method: 'DELETE', cookies: admin })).status,
    ).toBe(400);
    const unused = await mkCoupon({ code: 'SINUSO' });
    expect(
      (await t.request(`/admin/coupons/${unused}`, { method: 'DELETE', cookies: admin })).status,
    ).toBe(200);
  });
});

/* ====================== CÁLCULO EN CARRITO ====================== */
describe('cupones en el carrito (vista previa)', () => {
  it('aplica el código sin distinguir mayúsculas y recalcula el total en el servidor', async () => {
    await mkCoupon({ code: 'TAZAS20', value: 20 });
    const p = await mkProduct({ price: 50_000 });
    const q = await quote([line(p, 2)], 'tazas20');
    expect(q).toMatchObject({
      subtotal: 100_000,
      itemDiscount: 20_000,
      shipping: 12_000,
      total: 92_000,
    });
    expect(q.coupon).toMatchObject({ status: 'applied', applied: { code: 'TAZAS20' } });
  });

  it('códigos inexistentes o inválidos informan el motivo en español sin cambiar el precio', async () => {
    await mkCoupon({ code: 'VENCIDO', endsAt: iso(-1000), startsAt: iso(-DAY) });
    await mkCoupon({ code: 'MIN', minPurchase: 500_000 });
    await mkCoupon({ code: 'APAGADO', isActive: false });
    const p = await mkProduct({ price: 50_000 });
    for (const [code, msg] of [
      ['NOEXISTE', 'no existe'],
      ['VENCIDO', 'venció'],
      ['MIN', 'mínimo'],
      ['APAGADO', 'no está activo'],
    ] as const) {
      const q = await quote([line(p)], code);
      expect(q.coupon.status).toBe('rejected');
      expect(q.coupon.message).toContain(msg);
      expect(q.total).toBe(62_000);
    }
  });

  it('descuento automático se aplica sin código; no se acumula con un cupón peor', async () => {
    await mkCoupon({ code: null, isAutomatic: true, value: 15 });
    await mkCoupon({ code: 'POCO', value: 5 });
    const p = await mkProduct({ price: 100_000 });
    const sin = await quote([line(p)]);
    expect(sin).toMatchObject({
      itemDiscount: 15_000,
      coupon: { status: 'none', applied: { isAutomatic: true } },
    });
    const con = await quote([line(p)], 'POCO');
    expect(con.itemDiscount).toBe(15_000); // gana el automático, no se suman
    expect(con.coupon.status).toBe('outranked');
  });

  it('cupón por categoría solo descuenta esos productos', async () => {
    const cat = await mkCategory('Tazas');
    await mkCoupon({ code: 'SOLOTAZAS', value: 50, appliesTo: 'categorias', targetIds: [cat] });
    const taza = await mkProduct({ price: 40_000, categoryId: cat });
    const jarron = await mkProduct({ price: 100_000 });
    expect((await quote([line(taza), line(jarron)], 'SOLOTAZAS')).itemDiscount).toBe(20_000);
    expect((await quote([line(jarron)], 'SOLOTAZAS')).coupon.status).toBe('rejected');
  });

  it('envío gratis: cupón de tipo envio_gratis', async () => {
    await mkCoupon({ code: 'ENVIOFREE', type: 'envio_gratis', value: 0 });
    const p = await mkProduct({ price: 50_000 });
    expect(await quote([line(p)], 'ENVIOFREE')).toMatchObject({
      itemDiscount: 0,
      shipping: 0,
      total: 50_000,
    });
  });
});

/* ====================== CHECKOUT ====================== */
describe('cupones en el checkout de pedidos', () => {
  it('guarda el descuento, firma el monto ya descontado y NO registra el uso al crear el pedido', async () => {
    const id = await mkCoupon({ code: 'TAZAS20', value: 20 });
    const p = await mkProduct({ price: 50_000 });
    const { res, body } = await checkout([line(p, 2)], 'tazas20');
    expect(res.status).toBe(201);
    expect(body.order.total).toBe(92_000);
    const [o] = await t.db.select().from(orders);
    expect(o).toMatchObject({
      subtotal: 100_000,
      discountTotal: 20_000,
      shippingTotal: 12_000,
      total: 92_000,
      couponId: id,
    });
    expect(new URL(body.checkoutUrl).searchParams.get('amount-in-cents')).toBe('9200000');
    expect(await t.db.select().from(couponRedemptions)).toHaveLength(0);
  });

  it('el uso se registra SOLO cuando el pago se aprueba (una vez, aunque el webhook se repita)', async () => {
    const id = await mkCoupon({ code: 'TAZAS20', value: 20 });
    const p = await mkProduct({ price: 50_000 });
    const { body } = await checkout([line(p, 2)], 'TAZAS20');
    await approveEvent(body.reference, body.order.total, 'DECLINED');
    expect(await t.db.select().from(couponRedemptions)).toHaveLength(0);
    await approveEvent(body.reference, body.order.total, 'APPROVED', 'tx-1');
    await approveEvent(body.reference, body.order.total, 'APPROVED', 'tx-1');
    await approveEvent(body.reference, body.order.total, 'APPROVED', 'tx-2');
    const red = await t.db.select().from(couponRedemptions);
    expect(red).toHaveLength(1);
    expect(red[0]).toMatchObject({ couponId: id, email: 'ana@correo.com', discountAmount: 20_000 });
  });

  it('un código inválido en el checkout es un error explícito (no se ignora en silencio)', async () => {
    const p = await mkProduct();
    const { res, body } = await checkout([line(p)], 'FALSO123');
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('COUPON_INVALID');
    expect(body.error?.message).toContain('no existe');
    expect(await t.db.select().from(orders)).toHaveLength(0);
  });

  it('usos máximos totales: tras el último uso aprobado, el cupón se rechaza', async () => {
    await mkCoupon({ code: 'UNICO', maxUses: 1 });
    const p = await mkProduct();
    const a = await checkout([line(p)], 'UNICO', { email: 'a@correo.com' });
    // Aún no se aprobó: el segundo cliente todavía puede crear su pedido
    expect((await checkout([line(p)], 'UNICO', { email: 'b@correo.com' })).res.status).toBe(201);
    await approveEvent(a.body.reference, a.body.order.total);
    const c2 = await checkout([line(p)], 'UNICO', { email: 'c@correo.com' });
    expect(c2.res.status).toBe(400);
    expect(c2.body.error?.message).toContain('límite de usos');
  });

  it('usos máximos por correo (sin distinguir mayúsculas)', async () => {
    await mkCoupon({ code: 'UNAVEZ', maxUsesPerEmail: 1 });
    const p = await mkProduct();
    const a = await checkout([line(p)], 'UNAVEZ', { email: 'Ana@Correo.com' });
    await approveEvent(a.body.reference, a.body.order.total);
    expect((await checkout([line(p)], 'UNAVEZ', { email: 'ANA@correo.com' })).res.status).toBe(400);
    expect((await checkout([line(p)], 'UNAVEZ', { email: 'otra@correo.com' })).res.status).toBe(
      201,
    );
  });

  it('un descuento automático se aplica sin escribir código y también se registra al aprobar', async () => {
    const id = await mkCoupon({ code: null, isAutomatic: true, value: 10 });
    const p = await mkProduct({ price: 100_000 });
    const { body } = await checkout([line(p)]);
    expect(body.order.total).toBe(102_000); // 100.000 - 10.000 + 12.000
    await approveEvent(body.reference, body.order.total);
    expect((await t.db.select().from(couponRedemptions))[0]).toMatchObject({
      couponId: id,
      discountAmount: 10_000,
    });
  });

  it('el cliente no puede forzar un descuento: el monto sale solo del servidor', async () => {
    const p = await mkProduct({ price: 50_000 });
    const res = await t.post('/public/checkout/order', {
      items: [line(p)],
      shipping: address,
      ...person,
      discountTotal: 49_000,
      total: 1000,
      couponId: '11111111-1111-4111-8111-111111111111',
    });
    expect(res.status).toBe(201);
    expect((await t.db.select().from(orders))[0]).toMatchObject({
      discountTotal: 0,
      total: 62_000,
      couponId: null,
    });
  });
});

/* ====================== INSCRIPCIONES ====================== */
describe('cupones en inscripciones a cursos', () => {
  async function edition() {
    const c = (await (
      await t.post(
        '/admin/courses',
        {
          name: 'Torno',
          slug: `t-${Math.random().toString(36).slice(2, 6)}`,
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
          maxSeats: 5,
          price: 300_000,
          enrollmentDeadline: iso(10 * DAY),
          allowedPaymentModes: ['total', 'reserva', 'abono', 'lista'],
          reservationHours: 48,
          depositType: 'porcentaje',
          depositValue: 30,
          balanceDueAt: iso(11 * DAY),
          sessions: [{ startsAt: iso(12 * DAY), endsAt: iso(12 * DAY + 3_600_000) }],
        },
        admin,
      )
    ).json()) as { item: { id: string } };
    return { course: c.item.id, edition: e.item.id };
  }
  const enroll = (editionId: string, mode: string, couponCode?: string, email = 'ana@correo.com') =>
    t.post('/public/enrollments', {
      editionId,
      mode,
      couponCode,
      name: 'Ana',
      email,
      phone: '3001234567',
      acceptDataPolicy: true,
    });

  it('aplica el cupón al total, el abono se calcula sobre el total descontado y el uso se registra al pagar', async () => {
    const id = await mkCoupon({ code: 'CURSO20', value: 20, appliesTo: 'cursos' });
    const { edition: ed } = await edition();
    const res = await enroll(ed, 'abono', 'curso20');
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      depositAmount: number;
      enrollment: { id: string; totalAmount: number };
    };
    expect(body.enrollment.totalAmount).toBe(240_000);
    expect(body.depositAmount).toBe(72_000); // 30% de 240.000
    const [row] = await t.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, body.enrollment.id));
    expect(row).toMatchObject({ couponId: id, discountAmount: 60_000, totalAmount: 240_000 });
    expect(await t.db.select().from(couponRedemptions)).toHaveLength(0);

    const pay = (await (
      await t.post(`/public/enrollments/${body.token}/pay`, { type: 'deposit' })
    ).json()) as { reference: string; amount: number };
    expect(pay.amount).toBe(72_000);
    await approveEvent(pay.reference, pay.amount);
    expect(await t.db.select().from(couponRedemptions)).toHaveLength(1);
    // un segundo pago (saldo) no duplica el uso
    const bal = (await (
      await t.post(`/public/enrollments/${body.token}/pay`, { type: 'full' })
    ).json()) as { reference: string; amount: number };
    await approveEvent(bal.reference, bal.amount);
    expect(await t.db.select().from(couponRedemptions)).toHaveLength(1);
  });

  it('un cupón de productos no aplica a cursos y uno que dejaría el total en cero se rechaza', async () => {
    await mkCoupon({ code: 'SOLOPROD', appliesTo: 'productos' });
    await mkCoupon({ code: 'GRATIS', value: 100, appliesTo: 'cursos' });
    const { edition: ed } = await edition();
    expect((await enroll(ed, 'total', 'SOLOPROD')).status).toBe(400);
    const r = await enroll(ed, 'total', 'GRATIS');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain('cero');
  });

  it('el pago manual del admin también registra el uso del cupón (una vez)', async () => {
    await mkCoupon({ code: 'CURSO10', value: 10, appliesTo: 'cursos' });
    const { edition: ed } = await edition();
    const e = (await (await enroll(ed, 'reserva', 'CURSO10')).json()) as {
      enrollment: { id: string };
    };
    expect(await t.db.select().from(couponRedemptions)).toHaveLength(0);
    await t.post(
      `/admin/enrollments/${e.enrollment.id}/payments`,
      { amount: 100_000, method: 'efectivo' },
      admin,
    );
    await t.post(
      `/admin/enrollments/${e.enrollment.id}/payments`,
      { amount: 170_000, method: 'efectivo' },
      admin,
    );
    expect(await t.db.select().from(couponRedemptions)).toHaveLength(1);
  });
});

/* ====================== CAMPAÑAS ====================== */
const img = (n: string) => ({
  url: `https://res.cloudinary.com/democloud/image/upload/v1/prometeo/campaigns/${n}.jpg`,
  publicId: `prometeo/campaigns/${n}`,
});
async function mkCampaign(over: Record<string, unknown> = {}) {
  const res = await t.post(
    '/admin/campaigns',
    {
      name: 'Verano',
      placement: 'banner_seccion',
      title: 'Hasta 20% en tazas',
      ctaText: 'Ver tazas',
      ctaUrl: '/tienda',
      startsAt: iso(-DAY),
      endsAt: iso(DAY),
      priority: 1,
      ...over,
    },
    admin,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}
interface PubCampaign {
  id: string;
  placement: string;
  ctaUrl: string | null;
  couponCode: string | null;
  title: string | null;
}
const pub = async (qs = '') =>
  ((await (await t.request(`/public/campaigns${qs}`)).json()) as { items: PubCampaign[] }).items;

describe('gestión de campañas (admin)', () => {
  it('crea con imágenes de Cloudinary y valida destinos, cupón y URLs peligrosas', async () => {
    const d = img('desktop');
    await mkCampaign({
      placement: 'hero_banner',
      imageDesktopUrl: d.url,
      imageDesktopPublicId: d.publicId,
    });
    const bad = (over: Record<string, unknown>) =>
      t.post(
        '/admin/campaigns',
        {
          name: 'X',
          placement: 'popup',
          title: 'T',
          startsAt: iso(-DAY),
          endsAt: iso(DAY),
          ...over,
        },
        admin,
      );
    expect(
      (await bad({ imageDesktopUrl: 'https://res.cloudinary.com/otro/image/upload/a.jpg' })).status,
    ).toBe(400);
    expect((await bad({ ctaText: 'Ir', ctaUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await bad({ ctaText: 'Ir', ctaUrl: '//evil.com' })).status).toBe(400);
    expect(
      (await bad({ targetType: 'producto', targetId: '11111111-1111-4111-8111-111111111111' }))
        .status,
    ).toBe(400);
    expect((await bad({ couponId: '11111111-1111-4111-8111-111111111111' })).status).toBe(400);
    expect((await bad({ startsAt: iso(DAY), endsAt: iso(-DAY) })).status).toBe(400);
    expect((await t.post('/admin/campaigns', {})).status).toBe(401);
  });

  it('al reemplazar o eliminar imágenes también se borran en Cloudinary', async () => {
    const a = img('a');
    const b = img('b');
    const id = await mkCampaign({ imageDesktopUrl: a.url, imageDesktopPublicId: a.publicId });
    await t.put(
      `/admin/campaigns/${id}`,
      {
        name: 'Verano',
        placement: 'banner_seccion',
        title: 'x',
        startsAt: iso(-DAY),
        endsAt: iso(DAY),
        imageDesktopUrl: b.url,
        imageDesktopPublicId: b.publicId,
      },
      admin,
    );
    expect(t.destroyed).toEqual([a.publicId]);
    await t.request(`/admin/campaigns/${id}`, { method: 'DELETE', cookies: admin });
    expect(t.destroyed).toEqual([a.publicId, b.publicId]);
    expect(await t.db.select().from(campaigns)).toHaveLength(0);
  });
});

describe('campañas públicas (por fecha, estado, ubicación y página)', () => {
  it('solo devuelve campañas activas y dentro de su rango, ordenadas por prioridad', async () => {
    await mkCampaign({ name: 'Baja', title: 'baja', priority: 1 });
    await mkCampaign({ name: 'Alta', title: 'alta', priority: 9 });
    await mkCampaign({ name: 'Futura', title: 'futura', startsAt: iso(DAY), endsAt: iso(2 * DAY) });
    await mkCampaign({
      name: 'Vencida',
      title: 'vencida',
      startsAt: iso(-3 * DAY),
      endsAt: iso(-DAY),
    });
    await mkCampaign({ name: 'Apagada', title: 'apagada', isActive: false });
    expect((await pub()).map((c) => c.title)).toEqual(['alta', 'baja']);
  });

  it('filtra por ubicación y por página (con comodín)', async () => {
    await mkCampaign({ title: 'hero', placement: 'hero_banner', pages: ['/'] });
    await mkCampaign({ title: 'barra', placement: 'barra_superior', pages: [] });
    await mkCampaign({ title: 'cursos', placement: 'popup', pages: ['/cursos*'] });
    expect((await pub('?path=/&placement=hero_banner')).map((c) => c.title)).toEqual(['hero']);
    expect((await pub('?path=/tienda')).map((c) => c.title)).toEqual(['barra']);
    expect((await pub('?path=/cursos/torno')).map((c) => c.title).sort()).toEqual([
      'barra',
      'cursos',
    ]);
    expect((await t.request('/public/campaigns?path=sin-barra')).status).toBe(400);
  });

  it('deriva el destino del elemento promocionado y expone el código del cupón vinculado', async () => {
    const p = await mkProduct({ slug: 'taza-sol', name: 'Taza Sol' });
    const k = await mkCoupon({ code: 'TAZAS20' });
    await mkCampaign({
      title: 'promo',
      ctaText: 'Ver',
      ctaUrl: null,
      targetType: 'producto',
      targetId: p,
      couponId: k,
    });
    const [c] = await pub();
    expect(c).toMatchObject({ ctaUrl: '/producto/taza-sol', couponCode: 'TAZAS20' });
    const cat = await mkCategory('Jarrones');
    await mkCampaign({
      title: 'cat',
      ctaText: 'Ver',
      targetType: 'categoria',
      targetId: cat,
      ctaUrl: null,
      priority: 0,
    });
    expect((await pub()).find((x) => x.title === 'cat')?.ctaUrl).toMatch(
      /^\/tienda\?category=jarrones-/,
    );
  });

  it('trae caché pública corta y no expone datos internos', async () => {
    await mkCampaign();
    const res = await t.request('/public/campaigns');
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    expect(JSON.stringify(await res.json())).not.toMatch(/isActive|startsAt|createdAt/);
  });
});

describe('tracking de impresiones y clics', () => {
  const track = (id: string, type: string, headers: Record<string, string> = {}) =>
    t.request(`/public/campaigns/${id}/events`, {
      method: 'POST',
      body: JSON.stringify({ type }),
      headers,
    });

  it('cuenta impresiones y clics por día, sin cookies', async () => {
    const id = await mkCampaign();
    for (const type of ['impression', 'impression', 'impression', 'click']) {
      const res = await track(id, type);
      expect(res.status).toBe(204);
      expect(setCookies(res)).toHaveLength(0);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    const rows = await t.db.select().from(campaignEvents);
    expect(rows).toHaveLength(2); // una fila por (campaña, tipo, día): contadores agregados
    expect(rows.find((r) => r.type === 'impression')?.count).toBe(3);
    expect(rows.find((r) => r.type === 'click')?.count).toBe(1);
  });

  it('ignora campañas no vigentes y rechaza tipos inválidos', async () => {
    const off = await mkCampaign({ isActive: false });
    const old = await mkCampaign({ startsAt: iso(-3 * DAY), endsAt: iso(-DAY) });
    expect((await track(off, 'click')).status).toBe(204);
    expect((await track(old, 'impression')).status).toBe(204);
    expect(await t.db.select().from(campaignEvents)).toHaveLength(0);
    const id = await mkCampaign();
    expect((await track(id, 'otro')).status).toBe(400);
    expect((await track('no-es-uuid', 'click')).status).toBe(400);
  });

  it('limita el abuso por IP (rate limit)', async () => {
    const id = await mkCampaign();
    const call = () =>
      t.app.request(
        `/public/campaigns/${id}/events`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'impression' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:4321',
            'cf-connecting-ip': '203.0.113.9',
          },
        },
        env,
      );
    let last = 204;
    for (let i = 0; i < 70; i++) last = (await call()).status;
    expect(last).toBe(429);
    const stored = (await t.db.select().from(campaignEvents))[0];
    expect(stored?.count).toBeLessThanOrEqual(60);
  });

  it('métricas del admin: impresiones, clics y CTR por campaña y para el dashboard', async () => {
    const a = await mkCampaign({ name: 'Camp A', title: 'a' });
    const b = await mkCampaign({ name: 'Camp B', title: 'b' });
    for (let i = 0; i < 10; i++)
      await track(a, 'impression', { 'cf-connecting-ip': `10.1.0.${i}` });
    for (let i = 0; i < 2; i++) await track(a, 'click', { 'cf-connecting-ip': `10.2.0.${i}` });
    await track(b, 'impression');
    const list = (await (
      await t.request('/admin/campaigns?days=30', { cookies: admin })
    ).json()) as {
      items: {
        name: string;
        live: boolean;
        recent: { impressions: number; clicks: number; ctr: number };
      }[];
    };
    const A = list.items.find((x) => x.name === 'Camp A');
    expect(A).toMatchObject({ live: true, recent: { impressions: 10, clicks: 2, ctr: 20 } });
    const m = (await (
      await t.request('/admin/campaigns/metrics?days=30', { cookies: admin })
    ).json()) as {
      impressions: number;
      clicks: number;
      ctr: number;
      activeCampaigns: number;
      top: { name: string }[];
    };
    expect(m).toMatchObject({ impressions: 11, clicks: 2, activeCampaigns: 2 });
    expect(m.top[0]?.name).toBe('Camp A');
    expect((await t.request('/admin/campaigns/metrics')).status).toBe(401);
  });
});

describe('cron diario: desactivar campañas y cupones vencidos', () => {
  it('desactiva lo vencido, respeta lo vigente y es idempotente', async () => {
    const oldCamp = await mkCampaign({ title: 'old', startsAt: iso(-3 * DAY), endsAt: iso(-DAY) });
    const liveCamp = await mkCampaign({ title: 'live' });
    const oldCoupon = await mkCoupon({ code: 'OLD', startsAt: iso(-3 * DAY), endsAt: iso(-DAY) });
    const liveCoupon = await mkCoupon({ code: 'LIVE' });
    expect(await deactivateExpiredMarketing(t.db)).toEqual({ campaigns: 1, coupons: 1 });
    expect(await deactivateExpiredMarketing(t.db)).toEqual({ campaigns: 0, coupons: 0 });
    expect(
      (await t.db.select().from(campaigns).where(eq(campaigns.id, oldCamp)))[0]?.isActive,
    ).toBe(false);
    expect(
      (await t.db.select().from(campaigns).where(eq(campaigns.id, liveCamp)))[0]?.isActive,
    ).toBe(true);
    expect((await t.db.select().from(coupons).where(eq(coupons.id, oldCoupon)))[0]?.isActive).toBe(
      false,
    );
    expect((await t.db.select().from(coupons).where(eq(coupons.id, liveCoupon)))[0]?.isActive).toBe(
      true,
    );
  });
});
