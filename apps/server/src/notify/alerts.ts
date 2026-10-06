import { schema } from "@hearloom/db";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { isPhoneOnline } from "../ingest/phones";
import { getSettings } from "../settings";
import { notify } from "./gateway";

/**
 * System alerts about capture health. Only fires while a capture stream is still open
 * (the user didn't stop recording on purpose), so taking the pendant off at night after
 * stopping capture doesn't nag.
 */

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lowBatteryAlerted = new Set<string>();

function arm(key: string, ms: number, fn: () => Promise<void>): void {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void fn().catch((err) => console.error("[alerts]", key, err));
    }, ms),
  );
}

function disarm(key: string): void {
  clearTimeout(timers.get(key));
  timers.delete(key);
}

async function hasOpenStream(userId: string, phoneId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.captureStreams.id })
    .from(schema.captureStreams)
    .where(
      and(
        eq(schema.captureStreams.userId, userId),
        eq(schema.captureStreams.phoneId, phoneId),
        isNull(schema.captureStreams.endedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function onWearableConnection(
  userId: string,
  phoneId: string,
  peripheralId: string,
  connected: boolean,
): Promise<void> {
  const key = `wearable:${userId}:${peripheralId}`;
  if (connected) return disarm(key);
  const { alerts } = await getSettings(userId);
  arm(key, alerts.disconnectedAfterMin * 60_000, async () => {
    if (!(await hasOpenStream(userId, phoneId))) return;
    await notify({
      userId,
      source: "system",
      category: "capture",
      title: "Pendant disconnected",
      body: `Hearloom hasn't heard your pendant for ${alerts.disconnectedAfterMin} minutes. Check that it's charged and nearby.`,
      collapseKey: "pendant-disconnected",
      deepLink: "/",
    });
  });
}

export async function onPhoneSocket(
  userId: string,
  phoneId: string,
  online: boolean,
): Promise<void> {
  const key = `phone:${phoneId}`;
  if (online) return disarm(key);
  const { alerts } = await getSettings(userId);
  arm(key, alerts.disconnectedAfterMin * 60_000, async () => {
    if (isPhoneOnline(phoneId) || !(await hasOpenStream(userId, phoneId))) return;
    await notify({
      userId,
      source: "system",
      category: "capture",
      title: "Hearloom can't reach your phone",
      body: "Recording may have stopped. Open Hearloom to resume — audio captured offline will upload automatically.",
      collapseKey: "phone-offline",
      deepLink: "/",
    });
  });
}

export async function onBattery(
  userId: string,
  peripheralId: string,
  level: number,
  charging: boolean,
): Promise<void> {
  const { alerts } = await getSettings(userId);
  const key = `${userId}:${peripheralId}`;
  if (charging || level > alerts.lowBatteryPercent + 5) {
    lowBatteryAlerted.delete(key);
    return;
  }
  if (level <= alerts.lowBatteryPercent && !lowBatteryAlerted.has(key)) {
    lowBatteryAlerted.add(key);
    await notify({
      userId,
      source: "system",
      category: "battery",
      title: `Pendant battery at ${level}%`,
      body: "Charge it soon to keep recording.",
      collapseKey: "pendant-battery",
      interruptionLevel: "passive",
      deepLink: "/",
    });
  }
}
