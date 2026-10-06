import { settingsPatchSchema, settingsSchema, timeZoneSchema } from "@hearloom/shared";
import { oc } from "@orpc/contract";
import { z } from "zod";

const ok = z.object({ ok: z.literal(true) });
const range = z.object({ from: z.date(), to: z.date() });

export const phoneSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  model: z.string().nullable(),
  osVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  pushEnabled: z.boolean(),
  hasPushToken: z.boolean(),
  apnsEnv: z.enum(["sandbox", "production"]).nullable(),
  lastSeenAt: z.date().nullable(),
  online: z.boolean(),
});

export const wearableSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  model: z.string().nullable(),
  firmware: z.string().nullable(),
  batteryLevel: z.number().nullable(),
  lastSeenAt: z.date().nullable(),
});

export const streamStatusSchema = z.object({
  id: z.uuid(),
  phoneId: z.uuid().nullable(),
  wearableName: z.string().nullable(),
  codec: z.number(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  lastFrameAt: z.date().nullable(),
  ackedSeq: z.number(),
  framesReceived: z.number(),
  live: z.boolean(),
});

export const liveStatusSchema = z.object({
  phones: z.array(phoneSchema),
  wearables: z.array(wearableSchema),
  streams: z.array(streamStatusSchema),
  serverTime: z.date(),
});

export const audioChunkSchema = z.object({
  id: z.uuid(),
  streamId: z.uuid(),
  startAt: z.date(),
  endAt: z.date(),
  durationMs: z.number(),
  byteSize: z.number(),
  url: z.string(),
});

export const bookmarkSchema = z.object({
  id: z.uuid(),
  at: z.date(),
  source: z.enum(["button", "app", "web"]),
  note: z.string().nullable(),
});

export const deviceEventSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  at: z.date(),
});

export const utteranceSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid().nullable(),
  startAt: z.date(),
  endAt: z.date(),
  speakerKey: z.string().nullable(),
  personId: z.uuid().nullable(),
  personName: z.string().nullable(),
  isWearer: z.boolean().nullable(),
  text: z.string(),
  lang: z.string().nullable(),
  source: z.enum(["live", "refine"]),
});

export const soundEventSchema = z.object({
  id: z.uuid(),
  startAt: z.date(),
  endAt: z.date(),
  label: z.string(),
  kind: z.enum(["point", "state"]),
  confidence: z.number(),
});

export const conversationSchema = z.object({
  id: z.uuid(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  status: z.enum(["open", "closed", "refining", "refined"]),
  languages: z.array(z.string()),
  speakerCount: z.number(),
  title: z.string().nullable(),
});

export const timelineSchema = z.object({
  conversations: z.array(conversationSchema),
  utterances: z.array(utteranceSchema),
  soundEvents: z.array(soundEventSchema),
  bookmarks: z.array(bookmarkSchema),
  deviceEvents: z.array(deviceEventSchema),
  chunks: z.array(audioChunkSchema),
});

export const notificationSchema = z.object({
  id: z.uuid(),
  source: z.enum(["system", "rule", "agent"]),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  deepLink: z.string().nullable(),
  interruptionLevel: z.enum(["passive", "active", "time-sensitive"]),
  status: z.enum(["pending", "held", "sent", "delivered", "failed", "suppressed"]),
  statusReason: z.string().nullable(),
  createdAt: z.date(),
  sentAt: z.date().nullable(),
  deliveredAt: z.date().nullable(),
  openedAt: z.date().nullable(),
  feedback: z.enum(["useful", "not_useful", "snoozed"]).nullable(),
  replyText: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const personSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isSelf: z.boolean(),
  voiceprints: z.number(),
  utterances: z.number(),
  lastHeardAt: z.date().nullable(),
});

export const contract = {
  me: {
    get: oc.output(
      z.object({
        user: z.object({
          id: z.string(),
          name: z.string(),
          email: z.string(),
          role: z.string().nullable(),
        }),
        settings: settingsSchema,
      }),
    ),
  },
  settings: {
    get: oc.output(settingsSchema),
    update: oc.input(settingsPatchSchema).output(settingsSchema),
  },
  phones: {
    register: oc
      .input(
        z.object({
          id: z.uuid().optional(),
          name: z.string().min(1).max(120),
          model: z.string().max(120).optional(),
          osVersion: z.string().max(40).optional(),
          appVersion: z.string().max(40).optional(),
          bundleId: z.string().max(200).optional(),
          timezone: timeZoneSchema.optional(),
        }),
      )
      .output(z.object({ phoneId: z.uuid() })),
    setPushToken: oc
      .input(
        z.object({
          phoneId: z.uuid(),
          apnsToken: z
            .string()
            .regex(/^[0-9a-f]{64,200}$/i)
            .nullable(),
          apnsEnv: z.enum(["sandbox", "production"]),
        }),
      )
      .output(ok),
    list: oc.output(z.array(phoneSchema)),
    remove: oc.input(z.object({ id: z.uuid() })).output(ok),
    /** The app is signing out: end its open capture streams and stop pushing to it. */
    signOut: oc.input(z.object({ id: z.uuid() })).output(ok),
  },
  wearables: {
    list: oc.output(z.array(wearableSchema)),
  },
  status: {
    live: oc.output(liveStatusSchema),
  },
  timeline: {
    range: oc.input(range).output(timelineSchema),
  },
  people: {
    list: oc.output(z.array(personSchema)),
    save: oc
      .input(
        z.object({
          id: z.uuid().optional(),
          name: z.string().trim().min(1).max(120),
          isSelf: z.boolean().optional(),
        }),
      )
      .output(personSchema),
    remove: oc.input(z.object({ id: z.uuid() })).output(ok),
    /**
     * "This is me" / "This is <name>": learn a voiceprint from an utterance's audio and attribute
     * the utterance. Give exactly one of personId, newPersonName or asSelf.
     */
    enroll: oc
      .input(
        z.object({
          utteranceId: z.uuid(),
          personId: z.uuid().optional(),
          newPersonName: z.string().trim().min(1).max(120).optional(),
          asSelf: z.boolean().optional(),
        }),
      )
      .output(z.object({ personId: z.uuid(), sampleSeconds: z.number() })),
  },
  bookmarks: {
    create: oc
      .input(z.object({ at: z.date().optional(), note: z.string().max(500).optional() }))
      .output(bookmarkSchema),
  },
  notifications: {
    list: oc
      .input(
        z.object({
          limit: z.number().int().min(1).max(200).default(50),
          before: z.date().optional(),
        }),
      )
      .output(z.array(notificationSchema)),
    feedback: oc
      .input(
        z.object({
          id: z.uuid(),
          action: z.enum(["opened", "useful", "not_useful", "snoozed", "reply"]),
          replyText: z.string().max(2000).optional(),
        }),
      )
      .output(ok),
    sendTest: oc
      .input(
        z.object({
          title: z.string().max(120).optional(),
          body: z.string().max(500).optional(),
          haptic: z.boolean().optional(),
        }),
      )
      .output(z.object({ id: z.uuid(), status: notificationSchema.shape.status })),
  },
};

export type Contract = typeof contract;
export type Phone = z.infer<typeof phoneSchema>;
export type Wearable = z.infer<typeof wearableSchema>;
export type LiveStatus = z.infer<typeof liveStatusSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export type NotificationItem = z.infer<typeof notificationSchema>;
export type AudioChunk = z.infer<typeof audioChunkSchema>;
export type Person = z.infer<typeof personSchema>;

/** Realtime events pushed to console/app sockets (`/realtime`). Clients refetch on these. */
export type RealtimeEvent =
  | {
      t: "invalidate";
      keys: Array<"status" | "timeline" | "notifications" | "phones" | "settings" | "people">;
    }
  | { t: "hello"; serverTime: number };
