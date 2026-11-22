import { Hono } from 'hono';
import { and, asc, eq, ilike, sql, type SQL } from 'drizzle-orm';
import { courseEditions, courseImages, courses } from '@prometeo/db';
import { courseSchema, idParamSchema, listQuerySchema } from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { pageInfo } from '../../lib/pagination';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';
import { assertCloudinaryImages, courseImageStore, syncImages } from '../../services/images';

export const coursesRoutes = new Hono<AppEnv>();
const notFound = () => new AuthError(404, 'NOT_FOUND', 'Curso no encontrado');

coursesRoutes.get('/', validate('query', listQuerySchema), async (c) => {
  const db = c.get('db');
  const { q, status, page, pageSize } = c.req.valid('query');
  const filters: SQL[] = [];
  if (q) filters.push(ilike(courses.name, `%${q.replace(/[%_\\]/g, '\\$&')}%`));
  if (status) filters.push(eq(courses.status, status));
  const where = filters.length ? and(...filters) : undefined;
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(courses)
    .where(where);
  const rows = await db
    .select({
      id: courses.id,
      name: courses.name,
      slug: courses.slug,
      level: courses.level,
      status: courses.status,
      editions: sql<number>`(select count(*)::int from course_editions ce where ce.course_id = "courses"."id")`,
    })
    .from(courses)
    .where(where)
    .orderBy(asc(courses.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return c.json({ items: rows, ...pageInfo(page, pageSize, count?.n ?? 0) });
});

coursesRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [row] = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
  if (!row) throw notFound();
  const images = await db
    .select()
    .from(courseImages)
    .where(eq(courseImages.courseId, id))
    .orderBy(asc(courseImages.sortOrder));
  return c.json({ item: { ...row, images } });
});

coursesRoutes.post('/', validate('json', courseSchema), async (c) => {
  const db = c.get('db');
  const { images, ...input } = c.req.valid('json');
  assertCloudinaryImages(images, c.env.CLOUDINARY_CLOUD_NAME);
  const [row] = await db.insert(courses).values(input).returning();
  if (!row) throw new Error('No se pudo crear el curso');
  await syncImages(db, courseImageStore, row.id, images);
  return c.json({ item: row }, 201);
});

coursesRoutes.put(
  '/:id',
  validate('param', idParamSchema),
  validate('json', courseSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const { images, ...input } = c.req.valid('json');
    assertCloudinaryImages(images, c.env.CLOUDINARY_CLOUD_NAME);
    const [before] = await db
      .select({ id: courses.id })
      .from(courses)
      .where(eq(courses.id, id))
      .limit(1);
    if (!before) throw notFound();
    const [row] = await db.update(courses).set(input).where(eq(courses.id, id)).returning();
    const removed = await syncImages(db, courseImageStore, id, images);
    await Promise.allSettled(removed.map((p) => c.get('cloudinary').destroy(p)));
    return c.json({ item: row });
  },
);

coursesRoutes.delete('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [before] = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
  if (!before) throw notFound();
  const [ed] = await db
    .select({ id: courseEditions.id })
    .from(courseEditions)
    .where(eq(courseEditions.courseId, id))
    .limit(1);
  if (ed)
    throw new AuthError(
      400,
      'IN_USE',
      'El curso tiene ediciones. Archívalo en lugar de eliminarlo',
    );
  const imgs = await db
    .select({ publicId: courseImages.publicId })
    .from(courseImages)
    .where(eq(courseImages.courseId, id));
  await db.delete(courses).where(eq(courses.id, id));
  await Promise.allSettled(imgs.map((i) => c.get('cloudinary').destroy(i.publicId)));
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'course.delete',
    entityType: 'course',
    entityId: id,
    before: { name: before.name },
  });
  return c.json({ ok: true });
});
