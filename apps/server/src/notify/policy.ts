import type { NotificationSource, Settings } from "@hearloom/shared";

export type InterruptionLevel = "passive" | "active" | "time-sensitive";
export type DeliverWhen = "now" | "after_conversation";

export interface PolicyInput {
  settings: Settings;
  source: NotificationSource;
  interruptionLevel: InterruptionLevel;
  deliverWhen: DeliverWhen;
  now: Date;
  /** Non-system notifications sent in the last hour. */
  sentLastHour: number;
  inConversation: boolean;
}

export type PolicyDecision =
  | { action: "send" }
  | { action: "hold"; until: Date | null; reason: "quiet_hours" | "in_conversation" }
  | { action: "suppress"; reason: "source_disabled" | "rate_limited" };

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

/** The next moment local time equals `hhmm` (minute precision). */
export function nextLocalTime(now: Date, timeZone: string, hhmm: string): Date {
  const cur = localMinutes(now, timeZone);
  let delta = (toMinutes(hhmm) - cur + 1440) % 1440;
  if (delta === 0) delta = 1440;
  const base = new Date(now);
  base.setUTCSeconds(0, 0);
  return new Date(base.getTime() + delta * 60_000);
}

export function decide(input: PolicyInput): PolicyDecision {
  const { settings, source } = input;
  if (!settings.notifications.sources[source])
    return { action: "suppress", reason: "source_disabled" };
  if (source !== "system" && input.sentLastHour >= settings.notifications.maxPerHour) {
    return { action: "suppress", reason: "rate_limited" };
  }
  if (input.interruptionLevel !== "time-sensitive" && inQuietHours(input.now, settings)) {
    return {
      action: "hold",
      until: nextLocalTime(input.now, settings.timezone, settings.quietHours.end),
      reason: "quiet_hours",
    };
  }
  if (input.deliverWhen === "after_conversation" && input.inConversation) {
    return { action: "hold", until: null, reason: "in_conversation" };
  }
  return { action: "send" };
}
