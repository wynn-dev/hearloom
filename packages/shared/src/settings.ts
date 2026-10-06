import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

export const buttonActionSchema = z.enum(["none", "bookmark", "mute", "ack_nudge"]);
export type ButtonAction = z.infer<typeof buttonActionSchema>;

export const notificationSourceSchema = z.enum(["system", "rule", "agent"]);
export type NotificationSource = z.infer<typeof notificationSourceSchema>;

const quietHours = z.object({
  enabled: z.boolean().default(true),
  start: hhmm.default("22:30"),
  end: hhmm.default("07:30"),
});

const notifications = z.object({
  /** Cap for non-system notifications in any rolling hour. */
  maxPerHour: z.number().int().min(0).max(60).default(4),
  sources: z
    .object({
      system: z.boolean().default(true),
      rule: z.boolean().default(true),
      agent: z.boolean().default(true),
    })
    .prefault({}),
  /** Vibrate the pendant when a nudge arrives over the live connection. */
  pendantHaptic: z.boolean().default(true),
});

const button = z.object({
  tap: buttonActionSchema.default("bookmark"),
  doubleTap: buttonActionSchema.default("mute"),
  hold: buttonActionSchema.default("ack_nudge"),
});

const alerts = z.object({
  /** Notify when no audio has arrived for this many minutes after a pendant was streaming. */
  disconnectedAfterMin: z.number().int().min(1).max(240).default(10),
  lowBatteryPercent: z.number().int().min(0).max(100).default(15),
});

export const settingsSchema = z.object({
  /** IANA zone used for quiet hours and day boundaries. Set from the phone on first login. */
  timezone: z.string().default("UTC"),
  quietHours: quietHours.prefault({}),
  notifications: notifications.prefault({}),
  button: button.prefault({}),
  alerts: alerts.prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Partial update: any section may be given partially; the server deep-merges. */
export const settingsPatchSchema = z.object({
  timezone: z.string().min(1).optional(),
  quietHours: quietHours.partial().optional(),
  notifications: notifications
    .extend({ sources: notifications.shape.sources.unwrap().partial() })
    .partial()
    .optional(),
  button: button.partial().optional(),
  alerts: alerts.partial().optional(),
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
  });
}
