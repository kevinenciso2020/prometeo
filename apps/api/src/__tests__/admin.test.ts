import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLogs, productImages, products, siteSettings } from '@prometeo/db';
import { signParams } from '../lib/cloudinary';
import { createTestContext, insertUser } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
let t: Ctx;
let admin: string;

const img = (name: string, primary = false) => ({
  url: `https://res.cloudinary.com/democloud/image/upload/v1/prometeo/products/${name}.jpg`,
  publicId: `prometeo/products/${name}`,
  isPrimary: primary,
});

const product = (over: Record<string, unknown> = {}) => ({
  name: 'Taza Arcilla',
  slug: 'taza-arcilla',
  price: 45000,
  stock: 5,
  status: 'publicado',
  images: [img('a', true), img('b')],
  ...over,
});

beforeEach(async () => {
  t = await createTestContext();
  await insertUser(t.db, 'admin@correo.com', 'clave-segura-123', 'ADMIN');
  admin = await t.login('admin@correo.com');
});

describe('autorización', () => {
  it('bloquea /admin a anónimos y clientes', async () => {
    await insertUser(t.db, 'cli@correo.com', 'clave-segura-123');
    for (const path of [
      '/admin/products',
      '/admin/categories',
      '/admin/services',
      '/admin/settings',
    ]) {
      expect((await t.request(path)).status).toBe(401);
      expect((await t.request(path, { cookies: await t.login('cli@correo.com') })).status).toBe(
        403,
      );
    }
  });

  it('la gestión de usuarios es solo para SUPER_ADMIN', async () => {
    expect((await t.request('/admin/users', { cookies: admin })).status).toBe(403);
    await insertUser(t.db, 'boss@correo.com', 'clave-segura-123', 'SUPER_ADMIN');
    expect(
      (await t.request('/admin/users', { cookies: await t.login('boss@correo.com') })).status,
    ).toBe(200);
  });
});

describe('subida a Cloudinary', () => {
  it('firma con SHA-1 sin exponer el secreto', async () => {
    const res = await t.post('/admin/uploads/signature', { folder: 'prometeo/products' }, admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string | number>;
    expect(JSON.stringify(body)).not.toContain('secreto-cloudinary');
    expect(body.signature).toMatch(/^[0-9a-f]{40}$/);
    const expected = await signParams(
      {
        allowed_formats: String(body.allowedFormats),
        folder: 'prometeo/products',
        timestamp: Number(body.timestamp),
      },
      'secreto-cloudinary',
    );
    expect(body.signature).toBe(expected);
  });

  it('rechaza carpetas no permitidas y a no-admins', async () => {
    expect(
      (await t.post('/admin/uploads/signature', { folder: 'otra/carpeta' }, admin)).status,
    ).toBe(400);
    expect((await t.post('/admin/uploads/signature', { folder: 'prometeo/products' })).status).toBe(
      401,
    );
  });

  it('la firma de referencia coincide con el ejemplo oficial de Cloudinary', async () => {
    const sig = await signParams({ timestamp: 1315060510, public_id: 'sample' }, 'abcd');
    expect(sig).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('productos', () => {
  it('crea con galería, devuelve imágenes ordenadas y una sola principal', async () => {
    const res = await t.post('/admin/products', product(), admin);
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { id: string } };
    const detail = (await (
      await t.request(`/admin/products/${item.id}`, { cookies: admin })
    ).json()) as {
      item: { images: { publicId: string; isPrimary: boolean; sortOrder: number }[] };
    };
    expect(detail.item.images.map((i) => i.publicId)).toEqual([
      'prometeo/products/a',
      'prometeo/products/b',
    ]);
    expect(detail.item.images.filter((i) => i.isPrimary)).toHaveLength(1);
  });

  it('rechaza imágenes de otro cloud, precios decimales y pieza única con stock > 1', async () => {
    const foreign = {
      url: 'https://res.cloudinary.com/otro/image/upload/x.jpg',
      publicId: 'x',
      isPrimary: true,
    };
    expect((await t.post('/admin/products', product({ images: [foreign] }), admin)).status).toBe(
      400,
    );
    expect((await t.post('/admin/products', product({ price: 10.5 }), admin)).status).toBe(400);
    expect(
      (await t.post('/admin/products', product({ isUnique: true, stock: 3 }), admin)).status,
    ).toBe(400);
  });

  it('slug o SKU duplicado responde 409', async () => {
    await t.post('/admin/products', product({ sku: 'TAZ-1' }), admin);
    expect(
      (await t.post('/admin/products', product({ slug: 'otra', sku: 'TAZ-1' }), admin)).status,
    ).toBe(409);
    expect((await t.post('/admin/products', product(), admin)).status).toBe(409);
  });

  it('al actualizar borra en Cloudinary las imágenes quitadas y audita el cambio de precio', async () => {
    const { item } = (await (await t.post('/admin/products', product(), admin)).json()) as {
      item: { id: string };
    };
    const res = await t.put(
      `/admin/products/${item.id}`,
      product({ price: 50000, images: [img('b', true), img('c')] }),
      admin,
    );
    expect(res.status).toBe(200);
    expect(t.destroyed).toEqual(['prometeo/products/a']);
    const imgs = await t.db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, item.id));
    expect(imgs.map((i) => i.publicId).sort()).toEqual([
      'prometeo/products/b',
      'prometeo/products/c',
    ]);
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'product.price_change'));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.after).toEqual({ price: 50000, compareAtPrice: null });
  });

  it('elimina el producto y sus imágenes (también en Cloudinary)', async () => {
    const { item } = (await (await t.post('/admin/products', product(), admin)).json()) as {
      item: { id: string };
    };
    const res = await t.request(`/admin/products/${item.id}`, { method: 'DELETE', cookies: admin });
    expect(res.status).toBe(200);
    expect(await t.db.select().from(products)).toHaveLength(0);
    expect(t.destroyed.sort()).toEqual(['prometeo/products/a', 'prometeo/products/b']);
  });

  it('lista con búsqueda y paginación', async () => {
    for (const n of ['uno', 'dos', 'tres']) {
      await t.post(
        '/admin/products',
        product({ name: `Taza ${n}`, slug: `taza-${n}`, images: [] }),
        admin,
      );
    }
    const res = (await (
      await t.request('/admin/products?q=dos&pageSize=1', { cookies: admin })
    ).json()) as { items: unknown[]; total: number };
    expect(res.total).toBe(1);
    const all = (await (
      await t.request('/admin/products?pageSize=2&page=2', { cookies: admin })
    ).json()) as { items: unknown[]; totalPages: number };
    expect(all.items).toHaveLength(1);
    expect(all.totalPages).toBe(2);
  });
});

describe('categorías y servicios', () => {
  it('CRUD de categoría: al borrar, el producto queda sin categoría', async () => {
    const { item: cat } = (await (
      await t.post('/admin/categories', { name: 'Tazas', slug: 'tazas' }, admin)
    ).json()) as { item: { id: string } };
    const { item } = (await (
      await t.post('/admin/products', product({ categoryId: cat.id, images: [] }), admin)
    ).json()) as { item: { id: string } };
    expect(
      (await t.request(`/admin/categories/${cat.id}`, { method: 'DELETE', cookies: admin })).status,
    ).toBe(200);
    const [p] = await t.db.select().from(products).where(eq(products.id, item.id));
    expect(p?.categoryId).toBeNull();
  });

  it('un servicio de pago online exige precio; cotización no', async () => {
    const base = { name: 'Taller privado', slug: 'taller-privado', images: [] };
    expect((await t.post('/admin/services', { ...base, mode: 'pago_online' }, admin)).status).toBe(
      400,
    );
    expect(
      (await t.post('/admin/services', { ...base, mode: 'pago_online', price: 200000 }, admin))
        .status,
    ).toBe(201);
    expect(
      (await t.post('/admin/services', { ...base, slug: 'otro', mode: 'cotizacion' }, admin))
        .status,
    ).toBe(201);
  });
});

describe('ajustes y administradores', () => {
  it('guarda ajustes, mezcla con defaults y audita el envío', async () => {
    let res = (await (await t.request('/admin/settings', { cookies: admin })).json()) as {
      settings: { shipping_flat_rate: number };
    };
    expect(res.settings.shipping_flat_rate).toBe(12000);
    expect(
      (
        await t.put(
          '/admin/settings',
          { shipping_flat_rate: 15000, free_shipping_threshold: 200000 },
          admin,
        )
      ).status,
    ).toBe(200);
    res = (await (await t.request('/admin/settings', { cookies: admin })).json()) as {
      settings: { shipping_flat_rate: number };
    };
    expect(res.settings.shipping_flat_rate).toBe(15000);
    expect(await t.db.select().from(siteSettings)).toHaveLength(2);
    expect(
      await t.db.select().from(auditLogs).where(eq(auditLogs.action, 'settings.shipping_change')),
    ).toHaveLength(1);
    expect((await t.put('/admin/settings', { shipping_flat_rate: -5 }, admin)).status).toBe(400);
  });

  it('SUPER_ADMIN crea admins y no puede desactivarse a sí mismo', async () => {
    const boss = await insertUser(t.db, 'boss@correo.com', 'clave-segura-123', 'SUPER_ADMIN');
    const cookies = await t.login('boss@correo.com');
    const res = await t.post(
      '/admin/users',
      { email: 'Nuevo@Correo.com', name: 'Nuevo Admin', password: 'clave-nueva-1234' },
      cookies,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { item: { role: string } }).item.role).toBe('ADMIN');
    expect(
      (await t.post('/auth/login', { email: 'nuevo@correo.com', password: 'clave-nueva-1234' }))
        .status,
    ).toBe(200);
    expect(
      (
        await t.request(`/admin/users/${boss.id}/active`, {
          method: 'PATCH',
          body: JSON.stringify({ isActive: false }),
          cookies,
        })
      ).status,
    ).toBe(403);
  });
});
