import {
  editSourceSchema,
  episodeKindSchema,
  settingsPatchSchema,
  settingsSchema,
  timeZoneSchema,
} from "@hearloom/shared";
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
  startAt: z.date(),
  endAt: z.date(),
  speakerKey: z.string().nullable(),
  personId: z.uuid().nullable(),
  personName: z.string().nullable(),
  isWearer: z.boolean().nullable(),
  text: z.string(),
  lang: z.string().nullable(),
  source: z.enum(["live", "refine"]),
  /** A voice from a TV or radio (it also speaks in a media episode of this stretch of speech). */
  mediaVoice: z.boolean(),
});

export const soundEventSchema = z.object({
  id: z.uuid(),
  startAt: z.date(),
  endAt: z.date(),
  label: z.string(),
  kind: z.enum(["point", "state"]),
  confidence: z.number(),
});

/** What was happening: utterances belong to the episode whose [startedAt, endedAt) holds their start. */
export const episodeSchema = z.object({
  id: z.uuid(),
  startedAt: z.date(),
  /** null: still going on. */
  endedAt: z.date().nullable(),
  kind: episodeKindSchema,
  kindSource: editSourceSchema,
  boundarySource: editSourceSchema,
  title: z.string().nullable(),
  summary: z.string().nullable(),
  /** Ended, and its speakers have been refined. */
  refined: z.boolean(),
  /** People and unnamed voices heard (in the requested range). */
  speakerCount: z.number(),
  languages: z.array(z.string()),
});

const knownKind = episodeKindSchema.exclude(["unknown"]);

export const timelineSchema = z.object({
  episodes: z.array(episodeSchema),
  utterances: z.array(utteranceSchema),
  soundEvents: z.array(soundEventSchema),
  bookmarks: z.array(bookmarkSchema),
  deviceEvents: z.array(deviceEventSchema),
  chunks: z.array(audioChunkSchema),
});

export const notificationSchema = z.object({
  id: z.uuid(),
  /** `agent`: older rows, from before agent notifications were removed. */
  source: z.enum(["system", "agent"]),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  deepLink: z.string().nullable(),
  interruptionLevel: z.enum(["passive", "active", "time-sensitive"]),
  status: z.enum(["pending", "sent", "delivered", "failed", "suppressed"]),
  statusReason: z.string().nullable(),
  createdAt: z.date(),
  sentAt: z.date().nullable(),
  deliveredAt: z.date().nullable(),
  openedAt: z.date().nullable(),
});

export const personSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isSelf: z.boolean(),
  voiceprints: z.number(),
  utterances: z.number(),
  lastHeardAt: z.date().nullable(),
});

export const apiTokenSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
});

export const voiceCommandSchema = z.object({
  id: z.uuid(),
  spokenAt: z.date(),
  endedAt: z.date(),
  wakeName: z.string(),
  heardAs: z.string(),
  nameScore: z.number(),
  transcript: z.string(),
  command: z.string(),
  speakerScore: z.number().nullable(),
  status: z.enum(["pending", "sent", "failed", "expired", "shadow", "ignored", "test"]),
  reason: z.string().nullable(),
  attempts: z.number(),
  httpStatus: z.number().nullable(),
  /** Spoken (end) to accepted by the agent, ms. */
  latencyMs: z.number().nullable(),
  feedback: z.enum(["confirmed", "false_trigger", "missed"]).nullable(),
});

export const teachResultSchema = z.object({
  kind: z.enum(["sample", "test"]),
  index: z.number(),
  phrase: z.string(),
  source: z.enum(["pendant", "browser"]),
  text: z.string(),
  ok: z.boolean(),
  heardAs: z.string().nullable(),
  nameScore: z.number(),
  wouldMatch: z.boolean(),
  speakerScore: z.number().nullable(),
  seconds: z.number(),
  voiceprintId: z.string().nullable(),
  wouldTrigger: z.boolean(),
  error: z.string().optional(),
});

export const voiceStatusSchema = z.object({
  profile: z.object({
    voiceprints: z.number(),
    voiceSeconds: z.number(),
    samples: z.number(),
    consistency: z.number().nullable(),
    nameRecognition: z.number().nullable(),
    threshold: z.number(),
    thresholdLearned: z.boolean(),
    progress: z.number(),
    canEnable: z.boolean(),
    minPrintSeconds: z.number(),
  }),
  teach: z
    .object({
      sessionId: z.string(),
      kind: z.enum(["sample", "test"]),
      index: z.number(),
      phrase: z.string(),
      taken: z.number(),
      results: z.array(teachResultSchema),
      expiresAt: z.number(),
    })
    .nullable(),
  /** A pendant is streaming right now (teach through it). */
  pendantLive: z.boolean(),
  pipelineRunning: z.boolean(),
  webhookConfigured: z.boolean(),
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
  episodes: {
    /** Rename, describe or re-classify (null clears a title or summary). */
    update: oc
      .input(
        z.object({
          id: z.uuid(),
          title: z.string().max(200).nullable().optional(),
          summary: z.string().max(4000).nullable().optional(),
          kind: knownKind.optional(),
        }),
      )
      .output(ok),
    /** Split an ended episode in two at `at`. */
    split: oc.input(z.object({ id: z.uuid(), at: z.date() })).output(ok),
    /** Merge an ended episode with the one right after it. */
    merge: oc.input(z.object({ ids: z.tuple([z.uuid(), z.uuid()]) })).output(ok),
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
  agent: {
    tokens: {
      list: oc.output(z.array(apiTokenSchema)),
      /** A full-access token, returned once; only its hash is stored. */
      create: oc
        .input(z.object({ name: z.string().trim().min(1).max(80) }))
        .output(z.object({ token: z.string(), info: apiTokenSchema })),
      revoke: oc.input(z.object({ id: z.uuid() })).output(ok),
    },
  },
  voice: {
    status: oc.output(voiceStatusSchema),
    commands: oc
      .input(
        z.object({
          limit: z.number().int().min(1).max(200).default(50),
          before: z.date().optional(),
        }),
      )
      .output(z.array(voiceCommandSchema)),
    /** It was me / wasn't me / should have fired. Confirmed and missed ones are learned from. */
    feedback: oc
      .input(
        z.object({
          id: z.uuid(),
          feedback: voiceCommandSchema.shape.feedback,
        }),
      )
      .output(z.object({ learned: z.boolean(), note: z.string().nullable() })),
    /** Send a signed `voice.command` with `test: true` to the agent webhook. */
    test: oc.output(
      z.object({
        status: z.enum(["sent", "failed", "expired"]),
        reason: z.string().nullable(),
        httpStatus: z.number().nullable(),
      }),
    ),
    teach: {
      /** sample = learn from each phrase; test = say the wake phrase, see if it would fire. */
      start: oc.input(z.object({ kind: z.enum(["sample", "test"]) })).output(ok),
      /** With `sessionId`, only that session (the page that started it went away). */
      stop: oc.input(z.object({ sessionId: z.string().optional() })).output(ok),
      skip: oc.output(ok),
      /** A phrase recorded with the browser mic: base64 of 16 kHz mono PCM16 (little endian). */
      upload: oc
        .input(
          z.object({
            sessionId: z.string(),
            pcm: z.string().max(16_000 * 2 * 15 * 1.4),
          }),
        )
        .output(ok),
    },
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
    /** The user tapped a notification on the phone. */
    opened: oc.input(z.object({ id: z.uuid() })).output(ok),
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
export type Episode = z.infer<typeof episodeSchema>;
export type NotificationItem = z.infer<typeof notificationSchema>;
export type AudioChunk = z.infer<typeof audioChunkSchema>;
export type Person = z.infer<typeof personSchema>;
export type ApiToken = z.infer<typeof apiTokenSchema>;
export type VoiceCommand = z.infer<typeof voiceCommandSchema>;
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;
export type TeachResultItem = z.infer<typeof teachResultSchema>;

/** Realtime events pushed to console/app sockets (`/realtime`). Clients refetch on these. */
export type RealtimeEvent =
  | {
      t: "invalidate";
      keys: Array<
        "status" | "timeline" | "notifications" | "phones" | "settings" | "people" | "voice"
      >;
    }
  | { t: "hello"; serverTime: number };
