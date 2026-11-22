import { siteSettings, type Db } from '@prometeo/db';
import { DEFAULT_SETTINGS } from '@prometeo/shared';

export type LoadedSettings = typeof DEFAULT_SETTINGS & Record<string, unknown>;

/** Ajustes del sitio mezclados con los valores por defecto. */
export async function loadSettings(db: Db): Promise<LoadedSettings> {
  const rows = await db.select().from(siteSettings);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) merged[r.key] = r.value;
  return merged as LoadedSettings;
}
