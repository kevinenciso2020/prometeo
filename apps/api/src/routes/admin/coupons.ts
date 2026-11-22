import { Hono } from 'hono';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { categories, couponRedemptions, coupons, courses, products, services } from '@prometeo/db';
import { couponSchema, idParamSchema, type CouponInput } from '@prometeo/shared';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';
import { redemptionCounts } from '../../services/discounts';

export const couponsRoutes = new Hono<AppEnv>();
const notFound = () => new AuthError(404, 'NOT_FOUND', 'Cupón no encontrado');

const listSchema = z.object({
  kind: z.enum(['codigo', 'automatico']).optional(),
  active: z.enum(['true', 'false']).optional(),
});

couponsRoutes.get('/', validate('query', listSchema), async (c) => {
  const db = c.get('db');
  const { kind, active } = c.req.valid('query');
  const filters: SQL[] = [];
  if (kind) filters.push(eq(coupons.isAutomatic, kind === 'automatico'));
  if (active) filters.push(eq(coupons.isActive, active === 'true'));
  const rows = await db
    .select()
    .from(coupons)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(coupons.createdAt))
    .limit(300);
  const counts = await redemptionCounts(
    db,
    rows.map((r) => r.id),
  );
  return c.json({ items: rows.map((r) => ({ ...r, uses: counts.get(r.id) ?? 0 })) });
});

couponsRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const [row] = await db
    .select()
    .from(coupons)
    .where(eq(coupons.id, c.req.valid('param').id))
    .limit(1);
  if (!row) throw notFound();
  const counts = await redemptionCounts(db, [row.id]);
  return c.json({ item: { ...row, uses: counts.get(row.id) ?? 0 } });
});

/** Verifica que los ids referenciados (categorías o ítems) existan. */
async function assertTargets(
  c: { get: (k: 'db') => AppEnv['Variables']['db'] },
  input: CouponInput,
): Promise<void> {
  if (input.appliesTo !== 'categorias' && input.appliesTo !== 'items') return;
  const db = c.get('db');
  const ids = [...new Set(input.targetIds)];
  let found = 0;
  if (input.appliesTo === 'categorias') {
    found = (
      await db.select({ id: categories.id }).from(categories).where(inArray(categories.id, ids))
    ).length;
  } else {
    const [p, s, k] = await Promise.all([
      db.select({ id: products.id }).from(products).where(inArray(products.id, ids)),
      db.select({ id: services.id }).from(services).where(inArray(services.id, ids)),
      db.select({ id: courses.id }).from(courses).where(inArray(courses.id, ids)),
    ]);
    found = new Set([...p, ...s, ...k].map((r) => r.id)).size;
  }
  if (found !== ids.length)
    throw new AuthError(400, 'INVALID_TARGETS', 'Algunos elementos seleccionados ya no existen');
}

function values(input: CouponInput) {
  return {
    ...input,
    value: input.type === 'envio_gratis' ? 0 : input.value,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    targetIds:
      input.appliesTo === 'categorias' || input.appliesTo === 'items'
        ? [...new Set(input.targetIds)]
        : [],
  };
}

couponsRoutes.post('/', validate('json', couponSchema), async (c) => {
  const db = c.get('db');
  const input = c.req.valid('json');
  await assertTargets(c, input);
  const [row] = await db.insert(coupons).values(values(input)).returning();
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'coupon.create',
    entityType: 'coupon',
    entityId: row?.id,
    after: { code: row?.code, type: row?.type, value: row?.value },
  });
  return c.json({ item: row }, 201);
});

couponsRoutes.put(
  '/:id',
  validate('param', idParamSchema),
  validate('json', couponSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const [before] = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
    if (!before) throw notFound();
    await assertTargets(c, input);
    const [row] = await db.update(coupons).set(values(input)).where(eq(coupons.id, id)).returning();
    await writeAudit(db, {
      actorId: c.get('user')?.id ?? null,
      action: 'coupon.update',
      entityType: 'coupon',
      entityId: id,
      before: {
        code: before.code,
        type: before.type,
        value: before.value,
        isActive: before.isActive,
      },
      after: { code: row?.code, type: row?.type, value: row?.value, isActive: row?.isActive },
    });
    return c.json({ item: row });
  },
);

couponsRoutes.delete('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [before] = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
  if (!before) throw notFound();
  const [used] = await db
    .select({ id: couponRedemptions.id })
    .from(couponRedemptions)
    .where(eq(couponRedemptions.couponId, id))
    .limit(1);
  if (used)
    throw new AuthError(
      400,
      'IN_USE',
      'El cupón ya fue usado. Desactívalo en lugar de eliminarlo para conservar el historial',
    );
  await db.delete(coupons).where(eq(coupons.id, id));
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'coupon.delete',
    entityType: 'coupon',
    entityId: id,
    before: { code: before.code },
  });
  return c.json({ ok: true });
});
