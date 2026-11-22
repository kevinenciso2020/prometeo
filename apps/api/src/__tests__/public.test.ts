import { beforeEach, describe, expect, it } from 'vitest';
import { products, quoteRequests } from '@prometeo/db';
import { createTestContext, insertUser } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
let t: Ctx;
let admin: string;

const img = (n: string) => ({
  url: `https://res.cloudinary.com/democloud/image/upload/v1/prometeo/products/${n}.jpg`,
  publicId: `prometeo/products/${n}`,
  isPrimary: true,
});

async function mk(body: Record<string, unknown>) {
  const res = await t.post(
    '/admin/products',
    { stock: 5, status: 'publicado', images: [], ...body },
    admin,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item;
}

beforeEach(async () => {
  t = await createTestContext();
  await insertUser(t.db, 'admin@correo.com', 'clave-segura-123', 'ADMIN');
  admin = await t.login('admin@correo.com');
});

describe('catálogo público', () => {
  it('solo expone productos publicados y no requiere sesión', async () => {
    await mk({ name: 'Taza Sol', slug: 'taza-sol', price: 40000, images: [img('sol')] });
    await mk({ name: 'Borrador', slug: 'borrador', price: 1000, status: 'borrador' });
    await mk({ name: 'Archivada', slug: 'archivada', price: 1000, status: 'archivado' });
    const res = (await (await t.request('/public/products')).json()) as {
      items: { slug: string; image: string | null }[];
      total: number;
    };
    expect(res.total).toBe(1);
    expect(res.items[0]?.slug).toBe('taza-sol');
    expect(res.items[0]?.image).toContain('prometeo/products/sol');
    expect((await t.request('/public/products/borrador')).status).toBe(404);
    expect((await t.request('/public/products/taza-sol')).status).toBe(200);
  });

  it('filtra por categoría, precio y texto, y ordena', async () => {
    const { item: cat } = (await (
      await t.post('/admin/categories', { name: 'Tazas', slug: 'tazas' }, admin)
    ).json()) as { item: { id: string } };
    await mk({ name: 'Taza Mar', slug: 'taza-mar', price: 30000, categoryId: cat.id });
    await mk({ name: 'Taza Luna', slug: 'taza-luna', price: 90000, categoryId: cat.id });
    await mk({ name: 'Jarrón Alto', slug: 'jarron-alto', price: 150000 });
    const get = async (qs: string) =>
      (
        (await (await t.request(`/public/products?${qs}`)).json()) as { items: { slug: string }[] }
      ).items.map((i) => i.slug);
    expect(await get('category=tazas&sort=precio_desc')).toEqual(['taza-luna', 'taza-mar']);
    expect(await get('minPrice=50000&maxPrice=100000')).toEqual(['taza-luna']);
    expect(await get('q=jarr')).toEqual(['jarron-alto']);
    expect(await get('category=no-existe')).toEqual([]);
    expect((await t.request('/public/products?minPrice=10&maxPrice=5')).status).toBe(400);
  });

  it('no incluye campos internos y trae caché pública', async () => {
    await mk({ name: 'Taza', slug: 'taza', price: 1000 });
    const res = await t.request('/public/products/taza');
    expect(res.headers.get('cache-control')).toContain('public');
    expect(JSON.stringify(await res.json())).not.toMatch(/createdAt|status/);
  });

  it('lista servicios publicados y oculta borradores', async () => {
    await t.post(
      '/admin/services',
      { name: 'Taller', slug: 'taller', mode: 'cotizacion', status: 'publicado', images: [] },
      admin,
    );
    await t.post(
      '/admin/services',
      { name: 'Oculto', slug: 'oculto', mode: 'cotizacion', images: [] },
      admin,
    );
    const res = (await (await t.request('/public/services')).json()) as {
      items: { slug: string }[];
    };
    expect(res.items.map((s) => s.slug)).toEqual(['taller']);
    expect((await t.request('/public/services/oculto')).status).toBe(404);
  });
});

describe('cotización del carrito (precios siempre del servidor)', () => {
  it('recalcula precio, valida stock y calcula envío', async () => {
    const a = await mk({ name: 'Taza', slug: 'taza', price: 40000, stock: 3 });
    const b = await mk({ name: 'Plato', slug: 'plato', price: 20000, stock: 1 });
    const res = (await (
      await t.post('/public/cart/quote', {
        items: [
          { type: 'product', id: a.id, quantity: 2 },
          { type: 'product', id: b.id, quantity: 2 },
        ],
      })
    ).json()) as {
      lines: { available: boolean; reason: string | null; lineTotal: number }[];
      subtotal: number;
      shipping: number;
      total: number;
    };
    expect(res.lines[0]).toMatchObject({ available: true, lineTotal: 80000 });
    expect(res.lines[1]).toMatchObject({ available: false, reason: 'Solo quedan 1' });
    expect(res.subtotal).toBe(80000);
    expect(res.shipping).toBe(12000);
    expect(res.total).toBe(92000);
  });

  it('envío gratis sobre el umbral configurado y servicios sin envío', async () => {
    await t.put(
      '/admin/settings',
      { shipping_flat_rate: 12000, free_shipping_threshold: 100000 },
      admin,
    );
    const a = await mk({ name: 'Jarrón', slug: 'jarron', price: 120000 });
    const free = (await (
      await t.post('/public/cart/quote', { items: [{ type: 'product', id: a.id, quantity: 1 }] })
    ).json()) as { shipping: number };
    expect(free.shipping).toBe(0);
    const svc = (await (
      await t.post(
        '/admin/services',
        {
          name: 'Horno',
          slug: 'horno',
          mode: 'pago_online',
          price: 50000,
          status: 'publicado',
          images: [],
        },
        admin,
      )
    ).json()) as { item: { id: string } };
    const s = (await (
      await t.post('/public/cart/quote', {
        items: [{ type: 'service', id: svc.item.id, quantity: 1 }],
      })
    ).json()) as { shipping: number; total: number };
    expect(s).toMatchObject({ shipping: 0, total: 50000 });
  });

  it('ignora productos no publicados o inexistentes y limita piezas únicas a 1', async () => {
    const u = await mk({ name: 'Única', slug: 'unica', price: 10000, stock: 1, isUnique: true });
    const d = await mk({ name: 'Draft', slug: 'draft', price: 10000, status: 'borrador' });
    const res = (await (
      await t.post('/public/cart/quote', {
        items: [
          { type: 'product', id: u.id, quantity: 9 },
          { type: 'product', id: d.id, quantity: 1 },
        ],
      })
    ).json()) as {
      lines: { available: boolean; quantity?: number }[];
    };
    expect(res.lines[0]).toMatchObject({ available: true, quantity: 1 });
    expect(res.lines[1]?.available).toBe(false);
    expect((await t.post('/public/cart/quote', { items: [] })).status).toBe(400);
  });
});

describe('solicitudes de cotización', () => {
  const valid = {
    name: 'Ana',
    email: 'ana@correo.com',
    details: 'Queremos un taller para 10 personas',
    acceptDataPolicy: true,
  };

  it('guarda la solicitud y avisa al taller por correo', async () => {
    await t.put(
      '/admin/settings',
      { contact: { email: 'taller@prometeo.co', phone: '', whatsapp: '', address: '', hours: '' } },
      admin,
    );
    const res = await t.post('/public/quotes', valid);
    expect(res.status).toBe(201);
    expect(await t.db.select().from(quoteRequests)).toHaveLength(1);
    expect(t.outbox.at(-1)?.to).toBe('taller@prometeo.co');
  });

  it('exige autorización de datos y descarta spam por honeypot', async () => {
    expect((await t.post('/public/quotes', { ...valid, acceptDataPolicy: false })).status).toBe(
      400,
    );
    expect((await t.post('/public/quotes', { ...valid, details: 'corto' })).status).toBe(400);
    expect((await t.post('/public/quotes', { ...valid, website: 'http://spam.io' })).status).toBe(
      400,
    );
    expect(await t.db.select().from(quoteRequests)).toHaveLength(0);
  });

  it('un producto no puede inyectarse por la tabla de pedidos (sanity)', async () => {
    expect(await t.db.select().from(products)).toHaveLength(0);
  });
});
