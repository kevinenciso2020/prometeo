import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { categories } from '@prometeo/db';
import { categorySchema, idParamSchema, isCloudinaryUrl } from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';

export const categoriesRoutes = new Hono<AppEnv>();

const notFound = () => new AuthError(404, 'NOT_FOUND', 'Categoría no encontrada');

categoriesRoutes.get('/', async (c) => {
  const rows = await c
    .get('db')
    .select()
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  return c.json({ items: rows });
});

categoriesRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const [row] = await c
    .get('db')
    .select()
    .from(categories)
    .where(eq(categories.id, c.req.valid('param').id))
    .limit(1);
  if (!row) throw notFound();
  return c.json({ item: row });
});

function checkImage(url: string | null, cloudName: string) {
  if (url && !isCloudinaryUrl(url, cloudName)) {
    throw new AuthError(400, 'INVALID_IMAGE', 'La imagen debe provenir de tu cuenta de Cloudinary');
  }
}

categoriesRoutes.post('/', validate('json', categorySchema), async (c) => {
  const input = c.req.valid('json');
  checkImage(input.imageUrl, c.env.CLOUDINARY_CLOUD_NAME);
  const [row] = await c.get('db').insert(categories).values(input).returning();
  return c.json({ item: row }, 201);
});

categoriesRoutes.put(
  '/:id',
  validate('param', idParamSchema),
  validate('json', categorySchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    checkImage(input.imageUrl, c.env.CLOUDINARY_CLOUD_NAME);
    const [before] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
    if (!before) throw notFound();
    const [row] = await db.update(categories).set(input).where(eq(categories.id, id)).returning();
    if (before.imagePublicId && before.imagePublicId !== input.imagePublicId) {
      await c.get('cloudinary').destroy(before.imagePublicId);
    }
    return c.json({ item: row });
  },
);

categoriesRoutes.delete('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [before] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  if (!before) throw notFound();
  await db.delete(categories).where(eq(categories.id, id)); // los productos quedan sin categoría
  if (before.imagePublicId) await c.get('cloudinary').destroy(before.imagePublicId);
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'category.delete',
    entityType: 'category',
    entityId: id,
    before: { name: before.name },
  });
  return c.json({ ok: true });
});
