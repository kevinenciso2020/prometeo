import { Hono } from 'hono';
import { and, asc, eq, ilike, sql, type SQL } from 'drizzle-orm';
import { serviceImages, services } from '@prometeo/db';
import { idParamSchema, listQuerySchema, serviceSchema } from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { pageInfo } from '../../lib/pagination';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';
import { assertCloudinaryImages, serviceImageStore, syncImages } from '../../services/images';

export const servicesRoutes = new Hono<AppEnv>();

const notFound = () => new AuthError(404, 'NOT_FOUND', 'Servicio no encontrado');

servicesRoutes.get('/', validate('query', listQuerySchema), async (c) => {
  const db = c.get('db');
  const { q, status, page, pageSize } = c.req.valid('query');
  const filters: SQL[] = [];
  if (q) filters.push(ilike(services.name, `%${q.replace(/[%_\\]/g, '\\$&')}%`));
  if (status) filters.push(eq(services.status, status));
  const where = filters.length ? and(...filters) : undefined;
  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(services)
    .where(where);
  const rows = await db
    .select()
    .from(services)
    .where(where)
    .orderBy(asc(services.sortOrder), asc(services.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return c.json({ items: rows, ...pageInfo(page, pageSize, countRow?.n ?? 0) });
});

servicesRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [row] = await db.select().from(services).where(eq(services.id, id)).limit(1);
  if (!row) throw notFound();
  const images = await db
    .select()
    .from(serviceImages)
    .where(eq(serviceImages.serviceId, id))
    .orderBy(asc(serviceImages.sortOrder));
  return c.json({ item: { ...row, images } });
});

servicesRoutes.post('/', validate('json', serviceSchema), async (c) => {
  const db = c.get('db');
  const { images, ...input } = c.req.valid('json');
  assertCloudinaryImages(images, c.env.CLOUDINARY_CLOUD_NAME);
  const [row] = await db.insert(services).values(input).returning();
  if (!row) throw new Error('No se pudo crear el servicio');
  await syncImages(db, serviceImageStore, row.id, images);
  return c.json({ item: row }, 201);
});

servicesRoutes.put(
  '/:id',
  validate('param', idParamSchema),
  validate('json', serviceSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const { images, ...input } = c.req.valid('json');
    assertCloudinaryImages(images, c.env.CLOUDINARY_CLOUD_NAME);
    const [before] = await db.select().from(services).where(eq(services.id, id)).limit(1);
    if (!before) throw notFound();
    const [row] = await db.update(services).set(input).where(eq(services.id, id)).returning();
    const removed = await syncImages(db, serviceImageStore, id, images);
    await Promise.allSettled(removed.map((p) => c.get('cloudinary').destroy(p)));
    if (before.price !== input.price) {
      await writeAudit(db, {
        actorId: c.get('user')?.id ?? null,
        action: 'service.price_change',
        entityType: 'service',
        entityId: id,
        before: { price: before.price },
        after: { price: input.price },
        ip: c.req.header('cf-connecting-ip'),
      });
    }
    return c.json({ item: row });
  },
);

servicesRoutes.delete('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [before] = await db.select().from(services).where(eq(services.id, id)).limit(1);
  if (!before) throw notFound();
  const imgs = await db
    .select({ publicId: serviceImages.publicId })
    .from(serviceImages)
    .where(eq(serviceImages.serviceId, id));
  try {
    await db.delete(services).where(eq(services.id, id));
  } catch {
    throw new AuthError(
      400,
      'IN_USE',
      'Este servicio tiene pedidos asociados. Archívalo en lugar de eliminarlo',
    );
  }
  await Promise.allSettled(imgs.map((i) => c.get('cloudinary').destroy(i.publicId)));
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'service.delete',
    entityType: 'service',
    entityId: id,
    before: { name: before.name },
  });
  return c.json({ ok: true });
});
