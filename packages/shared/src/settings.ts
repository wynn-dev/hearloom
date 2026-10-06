import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** IANA zone name that this runtime can format (an invalid zone would break quiet hours). */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "unknown time zone");

export const buttonActionSchema = z.enum(["none", "bookmark", "mute", "ack_nudge"]);
export type ButtonAction = z.infer<typeof buttonActionSchema>;

export const notificationSourceSchema = z.enum(["system", "rule", "agent"]);
export type NotificationSource = z.infer<typeof notificationSourceSchema>;

/*
 * Each section is defined twice from the same field validators: with defaults (stored settings) and
 * without (patches). Zod fills `.default()` values even inside `.partial()`, so a patch built from
 * the defaulted schema would silently reset every field the client didn't send.
 */
const quietHoursFields = { enabled: z.boolean(), start: hhmm, end: hhmm };
const sourcesFields = { system: z.boolean(), rule: z.boolean(), agent: z.boolean() };
const notificationsFields = {
  /** Cap for non-system notifications in any rolling hour. */
  maxPerHour: z.number().int().min(0).max(60),
  /** Vibrate the pendant when a nudge arrives over the live connection. */
  pendantHaptic: z.boolean(),
};
const buttonFields = {
  tap: buttonActionSchema,
  doubleTap: buttonActionSchema,
  hold: buttonActionSchema,
};
const alertsFields = {
  /** Notify when no audio has arrived for this many minutes after a pendant was streaming. */
  disconnectedAfterMin: z.number().int().min(1).max(240),
  lowBatteryPercent: z.number().int().min(0).max(100),
};

/** Outbound events to an agent (e.g. Hermes) — HMAC-signed webhooks. */
const agentFields = {
  webhookUrl: z.union([z.url(), z.literal("")]),
  webhookSecret: z.string().max(256),
};
const agentEventsFields = {
  conversationEnded: z.boolean(),
  conversationRefined: z.boolean(),
  bookmark: z.boolean(),
};

export const settingsSchema = z.object({
  /** IANA zone used for quiet hours and day boundaries. Set from the phone on first login. */
  timezone: timeZoneSchema.default("UTC"),
  quietHours: z
    .object({
      enabled: quietHoursFields.enabled.default(true),
      start: quietHoursFields.start.default("22:30"),
      end: quietHoursFields.end.default("07:30"),
    })
    .prefault({}),
  notifications: z
    .object({
      maxPerHour: notificationsFields.maxPerHour.default(4),
      sources: z
        .object({
          system: sourcesFields.system.default(true),
          rule: sourcesFields.rule.default(true),
          agent: sourcesFields.agent.default(true),
        })
        .prefault({}),
      pendantHaptic: notificationsFields.pendantHaptic.default(true),
    })
    .prefault({}),
  button: z
    .object({
      tap: buttonFields.tap.default("bookmark"),
      doubleTap: buttonFields.doubleTap.default("mute"),
      hold: buttonFields.hold.default("ack_nudge"),
    })
    .prefault({}),
  alerts: z
    .object({
      disconnectedAfterMin: alertsFields.disconnectedAfterMin.default(10),
      lowBatteryPercent: alertsFields.lowBatteryPercent.default(15),
    })
    .prefault({}),
  agent: z
    .object({
      webhookUrl: agentFields.webhookUrl.default(""),
      webhookSecret: agentFields.webhookSecret.default(""),
      events: z
        .object({
          conversationEnded: agentEventsFields.conversationEnded.default(true),
          conversationRefined: agentEventsFields.conversationRefined.default(true),
          bookmark: agentEventsFields.bookmark.default(true),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Partial update: any section may be given partially; the server deep-merges. No defaults here. */
export const settingsPatchSchema = z.object({
  timezone: timeZoneSchema.optional(),
  quietHours: z.object(quietHoursFields).partial().optional(),
  notifications: z
    .object({ ...notificationsFields, sources: z.object(sourcesFields).partial() })
    .partial()
    .optional(),
  button: z.object(buttonFields).partial().optional(),
  alerts: z.object(alertsFields).partial().optional(),
  agent: z
    .object({ ...agentFields, events: z.object(agentEventsFields).partial() })
    .partial()
    .optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export function resolveSettings(stored: unknown): Settings {
  const parsed = settingsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return settingsSchema.parse({
    ...current,
    ...(patch.timezone ? { timezone: patch.timezone } : {}),
    quietHours: { ...current.quietHours, ...patch.quietHours },
    notifications: {
      ...current.notifications,
      ...patch.notifications,
      sources: { ...current.notifications.sources, ...patch.notifications?.sources },
    },
    button: { ...current.button, ...patch.button },
    alerts: { ...current.alerts, ...patch.alerts },
    agent: {
      ...current.agent,
      ...patch.agent,
      events: { ...current.agent.events, ...patch.agent?.events },
    },
  });
}
