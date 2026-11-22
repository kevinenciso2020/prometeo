import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
  campaignEventSchema,
  campaignMatchesPath,
  idParamSchema,
  publicCampaignsQuerySchema,
} from '@prometeo/shared';
import type { AppEnv } from '../env';
import { bogotaDay } from '../lib/dates';
import { validate } from '../lib/validate';
import { rateLimit } from '../middleware/rate-limit';

export const publicCampaignRoutes = new Hono<AppEnv>();

/**
 * Campañas activas y dentro de su rango de fechas (se compara contra "ahora" en UTC; las fechas
 * se guardan con zona, y el admin las ingresa en hora de Colombia, America/Bogota).
 */
publicCampaignRoutes.get('/campaigns', validate('query', publicCampaignsQuerySchema), async (c) => {
  const db = c.get('db');
  const { path, placement } = c.req.valid('query');
  const rows = await db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.isActive, true),
        sql`${campaigns.startsAt} <= now()`,
        sql`${campaigns.endsAt} > now()`,
        placement ? eq(campaigns.placement, placement) : undefined,
      ),
    )
    .orderBy(desc(campaigns.priority), desc(campaigns.startsAt));
  const visible = rows.filter((r) => campaignMatchesPath(r.pages, path));

  // Destinos derivados del elemento promocionado y código del cupón vinculado.
  const ids = (t: string) =>
    visible.filter((r) => r.targetType === t && r.targetId).map((r) => r.targetId as string);
  const [prod, course, edition, cat, cps] = await Promise.all([
    ids('producto').length
      ? db
          .select({ id: products.id, slug: products.slug })
          .from(products)
          .where(inArray(products.id, ids('producto')))
      : [],
    ids('curso').length
      ? db
          .select({ id: courses.id, slug: courses.slug })
          .from(courses)
          .where(inArray(courses.id, ids('curso')))
      : [],
    ids('edicion').length
      ? db
          .select({ id: courseEditions.id, slug: courses.slug })
          .from(courseEditions)
          .innerJoin(courses, eq(courses.id, courseEditions.courseId))
          .where(inArray(courseEditions.id, ids('edicion')))
      : [],
    ids('categoria').length
      ? db
          .select({ id: categories.id, slug: categories.slug })
          .from(categories)
          .where(inArray(categories.id, ids('categoria')))
      : [],
    visible.some((r) => r.couponId)
      ? db
          .select({ id: coupons.id, code: coupons.code })
          .from(coupons)
          .where(
            and(
              inArray(
                coupons.id,
                visible.flatMap((r) => (r.couponId ? [r.couponId] : [])),
              ),
              eq(coupons.isActive, true),
            ),
          )
      : [],
  ]);
  const slug = (list: { id: string; slug: string }[], id: string | null) =>
    list.find((x) => x.id === id)?.slug;
  const derived = (r: (typeof visible)[number]): string | null => {
    if (r.targetType === 'producto')
      return slug(prod, r.targetId) ? `/producto/${slug(prod, r.targetId)}` : null;
    if (r.targetType === 'curso' || r.targetType === 'edicion') {
      const s = slug(r.targetType === 'curso' ? course : edition, r.targetId);
      return s ? `/cursos/${s}` : null;
    }
    if (r.targetType === 'categoria')
      return slug(cat, r.targetId) ? `/tienda?category=${slug(cat, r.targetId)}` : null;
    return null;
  };

  c.header('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=120');
  return c.json({
    items: visible.map((r) => ({
      id: r.id,
      placement: r.placement,
      title: r.title,
      text: r.text,
      ctaText: r.ctaText,
      ctaUrl: r.ctaUrl ?? derived(r),
      imageDesktop: r.imageDesktopUrl,
      imageMobile: r.imageMobileUrl,
      popupFrequencyHours: r.popupFrequencyHours,
      priority: r.priority,
      couponCode: cps.find((k) => k.id === r.couponId)?.code ?? null,
    })),
  });
});

/**
 * Impresiones y clics: contadores diarios agregados, sin cookies ni identificadores personales.
 * Protegido por rate limit por IP y solo cuenta campañas vigentes.
 */
publicCampaignRoutes.post(
  '/campaigns/:id/events',
  rateLimit('RL_TRACK', 'campaign'),
  validate('param', idParamSchema),
  validate('json', campaignEventSchema),
  async (c) => {
    const db = c.get('db');
    const { id } = c.req.valid('param');
    const { type } = c.req.valid('json');
    const [live] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, id),
          eq(campaigns.isActive, true),
          sql`${campaigns.startsAt} <= now()`,
          sql`${campaigns.endsAt} > now()`,
        ),
      )
      .limit(1);
    if (live) {
      await db
        .insert(campaignEvents)
        .values({ campaignId: id, type, day: bogotaDay(new Date()), count: 1 })
        .onConflictDoUpdate({
          target: [campaignEvents.campaignId, campaignEvents.type, campaignEvents.day],
          set: { count: sql`${campaignEvents.count} + 1` },
        });
    }
    return c.body(null, 204);
  },
);
