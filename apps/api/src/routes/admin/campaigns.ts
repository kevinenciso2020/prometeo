import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  campaignEvents,
  campaigns,
  categories,
  courseEditions,
  coupons,
  courses,
  products,
} from '@prometeo/db';
import {
  campaignSchema,
  idParamSchema,
  isCloudinaryUrl,
  type CampaignInput,
} from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { bogotaDay } from '../../lib/dates';
import { validate } from '../../lib/validate';
import { AuthError } from '../../services/auth.service';

export const campaignsRoutes = new Hono<AppEnv>();
const notFound = () => new AuthError(404, 'NOT_FOUND', 'Campaña no encontrada');

const metricsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

type Totals = { impressions: number; clicks: number };
async function loadMetrics(c: { get: (k: 'db') => AppEnv['Variables']['db'] }, days: number) {
  const db = c.get('db');
  const since = bogotaDay(new Date(Date.now() - days * 86_400_000));
  const rows = await db
    .select({
      id: campaignEvents.campaignId,
      type: campaignEvents.type,
      n: sql<number>`sum(${campaignEvents.count})::int`,
    })
    .from(campaignEvents)
    .where(gte(campaignEvents.day, since))
    .groupBy(campaignEvents.campaignId, campaignEvents.type);
  const all = await db
    .select({
      id: campaignEvents.campaignId,
      type: campaignEvents.type,
      n: sql<number>`sum(${campaignEvents.count})::int`,
    })
    .from(campaignEvents)
    .groupBy(campaignEvents.campaignId, campaignEvents.type);
  const fold = (list: typeof rows) => {
    const m = new Map<string, Totals>();
    for (const r of list) {
      const t = m.get(r.id) ?? { impressions: 0, clicks: 0 };
      if (r.type === 'impression') t.impressions += r.n;
      else t.clicks += r.n;
      m.set(r.id, t);
    }
    return m;
  };
  return { recent: fold(rows), total: fold(all) };
}

const ctr = (t: Totals | undefined) =>
  t && t.impressions > 0 ? Math.round((t.clicks / t.impressions) * 1000) / 10 : 0;

campaignsRoutes.get('/', validate('query', metricsQuery), async (c) => {
  const db = c.get('db');
  const { days } = c.req.valid('query');
  const rows = await db.select().from(campaigns).orderBy(desc(campaigns.startsAt)).limit(300);
  const m = await loadMetrics(c, days);
  const now = Date.now();
  return c.json({
    days,
    items: rows.map((r) => {
      const recent = m.recent.get(r.id) ?? { impressions: 0, clicks: 0 };
      const total = m.total.get(r.id) ?? { impressions: 0, clicks: 0 };
      const live = r.isActive && r.startsAt.getTime() <= now && now < r.endsAt.getTime();
      return {
        ...r,
        live,
        recent: { ...recent, ctr: ctr(recent) },
        total: { ...total, ctr: ctr(total) },
      };
    }),
  });
});

/** Resumen para el dashboard: totales del periodo y mejores campañas por clics. */
campaignsRoutes.get('/metrics', validate('query', metricsQuery), async (c) => {
  const db = c.get('db');
  const { days } = c.req.valid('query');
  const m = await loadMetrics(c, days);
  const names = await db
    .select({ id: campaigns.id, name: campaigns.name, placement: campaigns.placement })
    .from(campaigns);
  const top = names
    .map((n) => ({ ...n, ...(m.recent.get(n.id) ?? { impressions: 0, clicks: 0 }) }))
    .map((n) => ({ ...n, ctr: ctr(n) }))
    .filter((n) => n.impressions > 0 || n.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 5);
  const sum = [...m.recent.values()].reduce(
    (t, x) => ({ impressions: t.impressions + x.impressions, clicks: t.clicks + x.clicks }),
    { impressions: 0, clicks: 0 },
  );
  const [active] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.isActive, true),
        sql`${campaigns.startsAt} <= now()`,
        sql`${campaigns.endsAt} > now()`,
      ),
    );
  return c.json({ days, ...sum, ctr: ctr(sum), activeCampaigns: active?.n ?? 0, top });
});

campaignsRoutes.get('/:id', validate('param', idParamSchema), async (c) => {
  const [row] = await c
    .get('db')
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, c.req.valid('param').id))
    .limit(1);
  if (!row) throw notFound();
  return c.json({ item: row });
});

async function validateRefs(
  c: { get: (k: 'db') => AppEnv['Variables']['db']; env: AppEnv['Bindings'] },
  input: CampaignInput,
): Promise<void> {
  const cloud = c.env.CLOUDINARY_CLOUD_NAME;
  for (const url of [input.imageDesktopUrl, input.imageMobileUrl]) {
    if (url && !isCloudinaryUrl(url, cloud))
      throw new AuthError(
        400,
        'INVALID_IMAGE',
        'Las imágenes deben provenir de tu cuenta de Cloudinary',
      );
  }
  const db = c.get('db');
  if (input.targetType && input.targetId) {
    const table = {
      producto: products,
      curso: courses,
      edicion: courseEditions,
      categoria: categories,
    }[input.targetType];
    const [t] = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, input.targetId))
      .limit(1);
    if (!t) throw new AuthError(400, 'INVALID_TARGET', 'El elemento promocionado no existe');
  }
  if (input.couponId) {
    const [k] = await db
      .select({ id: coupons.id })
      .from(coupons)
      .where(eq(coupons.id, input.couponId))
      .limit(1);
    if (!k) throw new AuthError(400, 'INVALID_COUPON', 'El cupón vinculado no existe');
  }
}

const values = (i: CampaignInput) => ({
  ...i,
  startsAt: new Date(i.startsAt),
  endsAt: new Date(i.endsAt),
});

campaignsRoutes.post('/', validate('json', campaignSchema), async (c) => {
  const db = c.get('db');
  const input = c.req.valid('json');
  await validateRefs(c, input);
  const [row] = await db.insert(campaigns).values(values(input)).returning();
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'campaign.create',
    entityType: 'campaign',
    entityId: row?.id,
    after: { name: row?.name, placement: row?.placement },
  });
  return c.json({ item: row }, 201);
});

campaignsRoutes.put(
  '/:id',
  validate('param', idParamSchema),
  validate('json', campaignSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const [before] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!before) throw notFound();
    await validateRefs(c, input);
    const [row] = await db
      .update(campaigns)
      .set(values(input))
      .where(eq(campaigns.id, id))
      .returning();
    // Imágenes reemplazadas: se borran también en Cloudinary.
    const drops = [
      [before.imageDesktopPublicId, input.imageDesktopPublicId],
      [before.imageMobilePublicId, input.imageMobilePublicId],
    ].flatMap(([old, next]) => (old && old !== next ? [old] : []));
    await Promise.allSettled(drops.map((p) => c.get('cloudinary').destroy(p)));
    return c.json({ item: row });
  },
);

campaignsRoutes.delete('/:id', validate('param', idParamSchema), async (c) => {
  const db = c.get('db');
  const { id } = c.req.valid('param');
  const [before] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!before) throw notFound();
  await db.delete(campaigns).where(eq(campaigns.id, id));
  await Promise.allSettled(
    [before.imageDesktopPublicId, before.imageMobilePublicId].flatMap((p) =>
      p ? [c.get('cloudinary').destroy(p)] : [],
    ),
  );
  await writeAudit(db, {
    actorId: c.get('user')?.id ?? null,
    action: 'campaign.delete',
    entityType: 'campaign',
    entityId: id,
    before: { name: before.name },
  });
  return c.json({ ok: true });
});
