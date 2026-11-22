import { Hono } from 'hono';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { productImages, products } from '@prometeo/db';
import { idParamSchema, listQuerySchema, productSchema } from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { pageInfo } from '../../lib/pagination';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';
import { assertCloudinaryImages, productImageStore, syncImages } from '../../services/images';

export const productsRoutes = new Hono<AppEnv>();

const notFound = () => new AuthError(404, 'NOT_FOUND', 'Producto no encontrado');

productsRoutes.get('/', validate('query', listQuerySchema), async (c) => {
  const db = c.get('db');
  const { q, status, categoryId, page, pageSize } = c.req.valid('query');
  const filters: SQL[] = [];
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const cond = or(ilike(products.name, like), ilike(products.sku, like));
    if (cond) filters.push(cond);
  }
  if (status) filters.push(eq(products.status, status));
  if (categoryId) filters.push(eq(products.categoryId, categoryId));
  const where = filters.length ? and(...filters) : undefined;

  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(where);
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      price: products.price,
      stock: products.stock,
      sku: products.sku,
      status: products.status,
      isFeatured: products.isFeatured,
      isUnique: products.isUnique,
      categoryId: products.categoryId,
      thumb: sql<
        string | null
      >`(select url from ${productImages} pi where pi.product_id = ${products.id} order by pi.is_primary desc, pi.sort_order asc limit 1)`,
    })
    .from(products)
    .where(where)
    .orderBy(desc(products.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return c.json({ items: rows, ...pageInfo(page, pageSize, countRow?.n ?? 0) });
});

productsRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!row) throw notFound();
  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, id))
    .orderBy(asc(productImages.sortOrder));
  return c.json({ item: { ...row, images } });
});

productsRoutes.post('/', validate('json', productSchema), async (c) => {
  const db = c.get('db');
  const { images, ...input } = c.req.valid('json');
  assertCloudinaryImages(images, c.env.CLOUDINARY_CLOUD_NAME);
  const [row] = await db.insert(products).values(input).returning();
  if (!row) throw new Error('No se pudo crear el producto');
  await syncImages(db, productImageStore, row.id, images);
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'product.create',
    entityType: 'product',
    entityId: row.id,
    after: { name: row.name, price: row.price },
  });
  return c.json({ item: row }, 201);
});

productsRoutes.put(
  '/:id',
  validate('param', idParamSchema),
  validate('json', productSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const { images, ...input } = c.req.valid('json');
    assertCloudinaryImages(images, c.env.CLOUDINARY_CLOUD_NAME);
    const [before] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!before) throw notFound();

    const [row] = await db.update(products).set(input).where(eq(products.id, id)).returning();
    const removed = await syncImages(db, productImageStore, id, images);
    await Promise.allSettled(removed.map((p) => c.get('cloudinary').destroy(p)));

    if (before.price !== input.price || before.compareAtPrice !== input.compareAtPrice) {
      await writeAudit(db, {
        actorId: c.get('user')?.id ?? null,
        action: 'product.price_change',
        entityType: 'product',
        entityId: id,
        before: { price: before.price, compareAtPrice: before.compareAtPrice },
        after: { price: input.price, compareAtPrice: input.compareAtPrice },
        ip: c.req.header('cf-connecting-ip'),
      });
    }
    return c.json({ item: row });
  },
);

productsRoutes.delete('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [before] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!before) throw notFound();
  const imgs = await db
    .select({ publicId: productImages.publicId })
    .from(productImages)
    .where(eq(productImages.productId, id));
  try {
    await db.delete(products).where(eq(products.id, id));
  } catch {
    throw new AuthError(
      400,
      'IN_USE',
      'Este producto tiene pedidos asociados. Archívalo en lugar de eliminarlo',
    );
  }
  await Promise.allSettled(imgs.map((i) => c.get('cloudinary').destroy(i.publicId)));
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'product.delete',
    entityType: 'product',
    entityId: id,
    before: { name: before.name },
  });
  return c.json({ ok: true });
});
