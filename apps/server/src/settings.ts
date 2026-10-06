import { schema } from "@hearloom/db";
import {
  mergeSettings,
  type PhoneConfig,
  resolveSettings,
  type Settings,
  type SettingsPatch,
} from "@hearloom/shared";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { sendConfigToUser } from "./ingest/phones";
import { invalidate } from "./realtime";

const cache = new Map<string, Settings>();

export async function getSettings(userId: string): Promise<Settings> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const [row] = await db
    .select({ settings: schema.userSettings.settings })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  const settings = resolveSettings(row?.settings);
  cache.set(userId, settings);
  return settings;
}

export async function updateSettings(userId: string, patch: SettingsPatch): Promise<Settings> {
  const next = mergeSettings(await getSettings(userId), patch);
  await db
    .insert(schema.userSettings)
    .values({ userId, settings: next })
    .onConflictDoUpdate({ target: schema.userSettings.userId, set: { settings: next } });
  cache.set(userId, next);
  sendConfigToUser(userId, phoneConfig(next));
  invalidate(userId, ["settings"]);
  return next;
}

export function phoneConfig(s: Settings): PhoneConfig {
  return { button: s.button, pendantHaptic: s.notifications.pendantHaptic };
}
