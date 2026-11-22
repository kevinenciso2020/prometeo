import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { siteSettings } from '@prometeo/db';
import { DEFAULT_SETTINGS, settingsSchema } from '@prometeo/shared';
import type { AppEnv } from '../../env';
import { writeAudit } from '../../lib/audit';
import { validate } from '../../lib/validate';

export const settingsRoutes = new Hono<AppEnv>();

async function loadSettings(c: { get: (k: 'db') => AppEnv['Variables']['db'] }) {
  const rows = await c.get('db').select().from(siteSettings);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) merged[r.key] = r.value;
  return merged;
}

settingsRoutes.get('/', async (c) => c.json({ settings: await loadSettings(c) }));

settingsRoutes.put('/', validate('json', settingsSchema), async (c) => {
  const db = c.get('db');
  const before = await loadSettings(c);
  const input = c.req.valid('json');
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    await db
      .insert(siteSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: sql`now()` } });
  }
  if ('shipping_flat_rate' in input || 'free_shipping_threshold' in input) {
    await writeAudit(db, {
      actorId: c.get('user')?.id ?? null,
      action: 'settings.shipping_change',
      entityType: 'settings',
      before: { rate: before.shipping_flat_rate, threshold: before.free_shipping_threshold },
      after: {
        rate: input.shipping_flat_rate ?? before.shipping_flat_rate,
        threshold: input.free_shipping_threshold ?? before.free_shipping_threshold,
      },
    });
  }
  return c.json({ settings: await loadSettings(c) });
});
