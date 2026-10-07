import type { NotificationSource, Settings } from "@hearloom/shared";

export type InterruptionLevel = "passive" | "active" | "time-sensitive";

/*
 * Hearloom never holds a notification for a better moment: the agent picks the moment (it can read
 * get_current_context), and a held message goes stale. Policy may only lower the volume, delivering
 * silently, or refuse outright past a hard ceiling.
 */

/** Non-system notifications past this many in any rolling hour are refused (runaway or prompt-injected agent). */
export const HARD_LIMIT_PER_HOUR = 30;

export type QuietReason = "quiet_hours" | "in_conversation" | "hourly_limit";

export interface PolicyInput {
  settings: Settings;
  source: NotificationSource;
  /** The level the sender asked for. */
  level: InterruptionLevel;
  now: Date;
  /** Non-system notifications sent in the last hour. */
  sentLastHour: number;
  /** Of those, how many were sent at the `active` level (with sound). */
  audibleLastHour: number;
  inConversation: boolean;
}

export type PolicyDecision =
  | { action: "send"; level: InterruptionLevel; quietedBy: QuietReason | null }
  | { action: "refuse"; reason: "source_disabled" | "hard_limit" };

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

function quietReason(input: PolicyInput): QuietReason | null {
  const { settings, source, level } = input;
  if (level === "passive") return null;
  // Nothing from the agent breaks quiet hours. Only a time-sensitive system alert (the test button) does.
  if (inQuietHours(input.now, settings) && !(source === "system" && level === "time-sensitive")) {
    return "quiet_hours";
  }
  // Outside quiet hours, system alerts and time-sensitive notifications always ring.
  if (source === "system" || level === "time-sensitive") return null;
  if (input.inConversation) return "in_conversation";
  if (input.audibleLastHour >= settings.notifications.maxPerHour) return "hourly_limit";
  return null;
}

export function decide(input: PolicyInput): PolicyDecision {
  if (!input.settings.notifications.sources[input.source]) {
    return { action: "refuse", reason: "source_disabled" };
  }
  if (input.source !== "system" && input.sentLastHour >= HARD_LIMIT_PER_HOUR) {
    return { action: "refuse", reason: "hard_limit" };
  }
  const quietedBy = quietReason(input);
  return { action: "send", level: quietedBy ? "passive" : input.level, quietedBy };
}
