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

export const buttonActionSchema = z.enum(["none", "bookmark", "mute"]);
export type ButtonAction = z.infer<typeof buttonActionSchema>;

/*
 * Each section is defined twice from the same field validators: with defaults (stored settings) and
 * without (patches). Zod fills `.default()` values even inside `.partial()`, so a patch built from
 * the defaulted schema would silently reset every field the client didn't send.
 */
/** System alerts arrive silently (no sound or buzz) in this window; only the test notification rings. */
const quietHoursFields = { enabled: z.boolean(), start: hhmm, end: hhmm };
const notificationsFields = {
  /** System alerts (pendant disconnected, low battery, test). Off: they're recorded, not sent. */
  enabled: z.boolean(),
  /** Vibrate the pendant for time-sensitive notifications over the live connection. */
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

/** Where Hearloom POSTs events for the agent (e.g. a Hermes webhook route), and the signing secret. */
const agentFields = {
  webhookUrl: z.union([z.url(), z.literal("")]),
  /** Standard Webhooks key: `whsec_<base64>`, or any other string (used as raw bytes). */
  webhookSecret: z.string().max(256),
};

/** `whsec_` secrets are base64 keys; receivers such as Hermes refuse ones that don't decode. */
export function isValidWebhookSecret(secret: string): boolean {
  if (!secret.startsWith("whsec_")) return true;
  const key = secret.slice("whsec_".length);
  return key.length > 0 && key.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(key);
}

/** "Hey <agent>" voice commands (see docs/voice-commands.md). */
const wakeWord = z.string().trim().min(2).max(40);
const voiceFields = {
  /** shadow = detect and log, but don't send to the agent. */
  mode: z.enum(["off", "shadow", "on"]),
  names: z.array(wakeWord).min(1).max(3),
  /** Spellings the recognizer produces for the name in the user's voice (learned, editable). */
  aliases: z.array(wakeWord).max(20),
  /** Spellings that caused false triggers: never matched loosely again. */
  blocked: z.array(wakeWord).max(20),
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
      enabled: notificationsFields.enabled.default(true),
      pendantHaptic: notificationsFields.pendantHaptic.default(true),
    })
    .prefault({}),
  button: z
    .object({
      tap: buttonFields.tap.default("bookmark"),
      doubleTap: buttonFields.doubleTap.default("mute"),
      hold: buttonFields.hold.default("none"),
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
    })
    .prefault({}),
  voice: z
    .object({
      mode: voiceFields.mode.default("off"),
      names: voiceFields.names.default(["Hermes"]),
      aliases: voiceFields.aliases.default([]),
      blocked: voiceFields.blocked.default([]),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * Settings as the API returns them: the webhook secret is write-only. Clients learn only whether one
 * is set and its last characters (long secrets only); the full secret is returned once, when the
 * server generates it, and stays on the server for signing.
 */
export const publicSettingsSchema = settingsSchema.extend({
  agent: z.object({
    webhookUrl: agentFields.webhookUrl,
    webhookSecretSet: z.boolean(),
    /** The last 4 characters, to tell secrets apart; null when unset or too short to hint at. */
    webhookSecretHint: z.string().nullable(),
  }),
});
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

/** Secrets shorter than this get no hint: 4 characters would give away too much of them. */
const HINT_MIN_LENGTH = 16;

export function publicSettings(s: Settings): PublicSettings {
  const { webhookUrl, webhookSecret } = s.agent;
  return {
    ...s,
    agent: {
      webhookUrl,
      webhookSecretSet: webhookSecret !== "",
      webhookSecretHint: webhookSecret.length >= HINT_MIN_LENGTH ? webhookSecret.slice(-4) : null,
    },
  };
}

/** Partial update: any section may be given partially; the server deep-merges. No defaults here. */
export const settingsPatchSchema = z.object({
  timezone: timeZoneSchema.optional(),
  quietHours: z.object(quietHoursFields).partial().optional(),
  notifications: z.object(notificationsFields).partial().optional(),
  button: z.object(buttonFields).partial().optional(),
  alerts: z.object(alertsFields).partial().optional(),
  agent: z
    .object({
      ...agentFields,
      // Checked on save only: a stored secret that fails this must not reset all settings.
      webhookSecret: agentFields.webhookSecret.refine(
        isValidWebhookSecret,
        "a whsec_ secret must be followed by base64",
      ),
    })
    .partial()
    .optional(),
  voice: z.object(voiceFields).partial().optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export function resolveSettings(stored: unknown): Settings {
  const parsed = settingsSchema.safeParse(upgrade(stored ?? {}));
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

type Stored = {
  notifications?: { enabled?: unknown; sources?: { system?: unknown } };
  button?: Record<string, unknown>;
};

/**
 * Settings stored before agent notifications were removed: the pendant's "acknowledge notification"
 * action becomes "none", and the system-alerts switch moves from `sources.system` to `enabled`.
 * (Unknown keys such as `maxPerHour` or `agent.events` are dropped by the schema.)
 */
function upgrade(stored: unknown): unknown {
  const s = stored as Stored;
  const button = s.button
    ? Object.fromEntries(
        Object.entries(s.button).map(([k, v]) => [k, v === "ack_nudge" ? "none" : v]),
      )
    : undefined;
  const system = s.notifications?.sources?.system;
  const notifications =
    s.notifications && s.notifications.enabled === undefined && typeof system === "boolean"
      ? { ...s.notifications, enabled: system }
      : s.notifications;
  return { ...s, button, notifications };
}

/**
 * Learned spellings belong to the agent's name: when a patch renames it, the aliases and blocked
 * spellings start over (unless the patch sets them too).
 */
export function voiceRenameReset(current: Settings, patch: SettingsPatch): SettingsPatch {
  const next = patch.voice?.names?.[0];
  const key = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  if (next === undefined || key(next) === key(current.voice.names[0] ?? "")) return patch;
  return {
    ...patch,
    voice: {
      ...patch.voice,
      aliases: patch.voice?.aliases ?? [],
      blocked: patch.voice?.blocked ?? [],
    },
  };
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return settingsSchema.parse({
    ...current,
    ...(patch.timezone ? { timezone: patch.timezone } : {}),
    quietHours: { ...current.quietHours, ...patch.quietHours },
    notifications: { ...current.notifications, ...patch.notifications },
    button: { ...current.button, ...patch.button },
    alerts: { ...current.alerts, ...patch.alerts },
    agent: { ...current.agent, ...patch.agent },
    voice: { ...current.voice, ...patch.voice },
  });
}
