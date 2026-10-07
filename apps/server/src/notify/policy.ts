import type { Settings } from "@hearloom/shared";

export type InterruptionLevel = "passive" | "active" | "time-sensitive";

/*
 * Hearloom only sends system alerts (capture health, the test button). Policy never holds one: it
 * may refuse it (alerts turned off) or deliver it silently during quiet hours.
 */

export type PolicyDecision =
  | { action: "send"; level: InterruptionLevel; quietedBy: "quiet_hours" | null }
  | { action: "refuse"; reason: "disabled" };

/** Minutes since local midnight in `timeZone`. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Is `now` inside the quiet window? Handles windows that cross midnight. */
export function inQuietHours(now: Date, settings: Settings): boolean {
  const q = settings.quietHours;
  if (!q.enabled) return false;
  const cur = localMinutes(now, settings.timezone);
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export function decide(settings: Settings, level: InterruptionLevel, now: Date): PolicyDecision {
  if (!settings.notifications.enabled) return { action: "refuse", reason: "disabled" };
  // Only a time-sensitive alert (the test button) rings through quiet hours.
  if (level === "active" && inQuietHours(now, settings)) {
    return { action: "send", level: "passive", quietedBy: "quiet_hours" };
  }
  return { action: "send", level, quietedBy: null };
}
