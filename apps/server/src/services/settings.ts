import { globalSettingsSchema, type GlobalSettings } from '@shipyard/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

const KEY = 'global';

export function getSettings(): GlobalSettings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  return globalSettingsSchema.parse(row?.value ?? {});
}

/** Merge a partial update over the stored settings, then validate the whole. */
export function updateSettings(patch: Record<string, unknown>): GlobalSettings {
  const next = globalSettingsSchema.parse({ ...getSettings(), ...patch });
  db.insert(settings)
    .values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next } })
    .run();
  return next;
}
