import { type SQL, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

const id = () => uuid().primaryKey().default(sql`uuidv7()`);
const owner = () =>
  text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });
const ts = () => timestamp({ withTimezone: true, mode: "date" });
const createdAt = () => ts().notNull().defaultNow();

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/** An Omi pendant as seen from one phone (iOS peripheral ids are per-phone). */
export const wearables = pgTable(
  "wearables",
  {
    id: id(),
    userId: owner(),
    peripheralId: text().notNull(),
    name: text().notNull(),
    model: text(),
    firmware: text(),
    hardwareRev: text(),
    serial: text(),
    codec: smallint(),
    batteryLevel: smallint(),
    lastSeenAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.userId, t.peripheralId)],
);

/** A phone running the Hearloom app. Doubles as the push-notification target. */
export const phones = pgTable(
  "phones",
  {
    id: id(),
    userId: owner(),
    name: text().notNull(),
    platform: text().$type<"ios">().notNull().default("ios"),
    model: text(),
    osVersion: text(),
    appVersion: text(),
    bundleId: text(),
    apnsToken: text(),
    apnsEnv: text().$type<"sandbox" | "production">(),
    pushEnabled: boolean().notNull().default(true),
    lastSeenAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.apnsToken)],
);

/**
 * One continuous capture session (a phone streaming one pendant). The phone mints the id
 * and numbers every Opus frame from 0, so resends after reconnects are idempotent.
 */
export const captureStreams = pgTable(
  "capture_streams",
  {
    id: uuid().primaryKey(),
    userId: owner(),
    /** Removing a phone must not delete what it recorded. */
    phoneId: uuid().references(() => phones.id, { onDelete: "set null" }),
    wearableId: uuid().references(() => wearables.id, { onDelete: "set null" }),
    codec: smallint().notNull(),
    sampleRate: integer().notNull(),
    frameMs: smallint().notNull(),
    startedAt: ts().notNull(),
    endedAt: ts(),
    /** Highest seq such that every frame 0..ackedSeq is durably stored. -1 = none. */
    ackedSeq: bigint({ mode: "number" }).notNull().default(-1),
    lastFrameAt: ts(),
    framesReceived: bigint({ mode: "number" }).notNull().default(0),
    bytesReceived: bigint({ mode: "number" }).notNull().default(0),
  },
  (t) => [index().on(t.userId, t.startedAt)],
);

/** A finalized block of audio (Ogg Opus, no re-encoding) in object storage. */
export const audioChunks = pgTable(
  "audio_chunks",
  {
    id: id(),
    userId: owner(),
    streamId: uuid()
      .notNull()
      .references(() => captureStreams.id, { onDelete: "cascade" }),
    seqStart: bigint({ mode: "number" }).notNull(),
    seqEnd: bigint({ mode: "number" }).notNull(),
    startAt: ts().notNull(),
    endAt: ts().notNull(),
    frameCount: integer().notNull(),
    durationMs: integer().notNull(),
    codec: smallint().notNull(),
    container: text().$type<"ogg">().notNull().default("ogg"),
    storageKey: text().notNull(),
    byteSize: integer().notNull(),
    sha256: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.streamId, t.seqStart), index().on(t.userId, t.startAt)],
);

/** Pendant/phone events: battery, button presses, (dis)connects. */
export const deviceEvents = pgTable(
  "device_events",
  {
    id: id(),
    userId: owner(),
    phoneId: uuid().references(() => phones.id, { onDelete: "set null" }),
    wearableId: uuid().references(() => wearables.id, { onDelete: "set null" }),
    kind: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    at: ts().notNull(),
  },
  (t) => [index().on(t.userId, t.at)],
);

export const people = pgTable(
  "people",
  {
    id: id(),
    userId: owner(),
    name: text().notNull(),
    isSelf: boolean().notNull().default(false),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("people_one_self_per_user").on(t.userId).where(sql`${t.isSelf}`)],
);

export const voiceprints = pgTable(
  "voiceprints",
  {
    id: id(),
    userId: owner(),
    personId: uuid()
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** The utterance it was learned from (re-attributing that utterance replaces it). */
    utteranceId: uuid().references(() => utterances.id, { onDelete: "set null" }),
    model: text().notNull(),
    embedding: real().array().notNull(),
    sampleSeconds: real().notNull(),
    source: text().$type<"enrollment" | "confirmed">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.personId)],
);

/** A voice the refine pass found in a block: later blocks of the chain match against it. */
export interface BlockSpeaker {
  /** Speaker key ("S3"), shared by every block of the chain. */
  key: string;
  personId: string | null;
  isSelf: boolean | null;
  /** Voice embedding of the cluster (SPEAKER_MODEL_ID). */
  centroid: number[];
  /** Seconds of speech it was learned from. */
  seconds: number;
}

/**
 * A bounded stretch of speech: the unit the refine pass works on. Blocks close after silence or,
 * in long continuous speech (a lecture, an evening of TV), at a pause once they are long enough
 * (see live/blocks.ts). Blocks of continuous speech share a chain, which scopes speaker keys; the
 * chain id is the id of its conversation.
 */
export const blocks = pgTable(
  "blocks",
  {
    id: id(),
    userId: owner(),
    chainId: uuid().notNull(),
    startedAt: ts().notNull(),
    endedAt: ts(),
    status: text().$type<"open" | "closed" | "refining" | "refined">().notNull().default("open"),
    speakers: jsonb().$type<BlockSpeaker[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.userId, t.startedAt), index().on(t.chainId)],
);

/** Continuous speech (no 2 minutes of silence): a chain of blocks. */
export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    userId: owner(),
    startedAt: ts().notNull(),
    endedAt: ts(),
    status: text().$type<"open" | "closed" | "refining" | "refined">().notNull().default("open"),
    languages: text().array().notNull().default(sql`'{}'::text[]`),
    speakerCount: smallint().notNull().default(0),
    title: text(),
    createdAt: createdAt(),
    updatedAt: ts()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.userId, t.startedAt)],
);

export const utterances = pgTable(
  "utterances",
  {
    id: id(),
    userId: owner(),
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    blockId: uuid().references(() => blocks.id, { onDelete: "set null" }),
    streamId: uuid().references(() => captureStreams.id, { onDelete: "set null" }),
    startAt: ts().notNull(),
    endAt: ts().notNull(),
    /** Provider/cluster speaker label before identification, e.g. "live:2". */
    speakerKey: text(),
    personId: uuid().references(() => people.id, { onDelete: "set null" }),
    isWearer: boolean(),
    text: text().notNull(),
    lang: text(),
    confidence: real(),
    source: text().$type<"live" | "refine">().notNull(),
    provider: text().notNull(),
    model: text(),
    revision: integer().notNull().default(0),
    supersededAt: ts(),
    search: tsvector().generatedAlwaysAs(
      (): SQL =>
        sql`(case when ${utterances.lang} = 'nl' then to_tsvector('dutch', ${utterances.text}) else to_tsvector('english', ${utterances.text}) end) || to_tsvector('simple', ${utterances.text})`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.userId, t.startAt),
    index().on(t.conversationId),
    index().on(t.blockId),
    index("utterances_search_idx").using("gin", t.search),
  ],
);

export const soundEvents = pgTable(
  "sound_events",
  {
    id: id(),
    userId: owner(),
    streamId: uuid().references(() => captureStreams.id, { onDelete: "set null" }),
    startAt: ts().notNull(),
    endAt: ts().notNull(),
    label: text().notNull(),
    kind: text().$type<"point" | "state">().notNull(),
    confidence: real().notNull(),
    audiosetLabels: text().array().notNull().default(sql`'{}'::text[]`),
    source: text().notNull(),
    model: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.startAt)],
);

export const captions = pgTable(
  "captions",
  {
    id: id(),
    userId: owner(),
    startAt: ts().notNull(),
    endAt: ts().notNull(),
    text: text().notNull(),
    model: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.startAt)],
);

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: id(),
    userId: owner(),
    at: ts().notNull(),
    source: text().$type<"button" | "app" | "web">().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.at)],
);

/** Every notification Hearloom sends (system alerts, rules, and later the agent). */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: owner(),
    source: text().$type<"system" | "agent">().notNull(),
    category: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    deepLink: text(),
    interruptionLevel: text()
      .$type<"passive" | "active" | "time-sensitive">()
      .notNull()
      .default("active"),
    collapseKey: text(),
    threadId: text(),
    deliverWhen: text().$type<"now" | "after_conversation">().notNull().default("now"),
    scheduledFor: ts(),
    haptic: boolean().notNull().default(false),
    status: text()
      .$type<"pending" | "held" | "sent" | "delivered" | "failed" | "suppressed">()
      .notNull()
      .default("pending"),
    statusReason: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    sentAt: ts(),
    deliveredAt: ts(),
    openedAt: ts(),
    feedback: text().$type<"useful" | "not_useful" | "snoozed">(),
    replyText: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.createdAt), index().on(t.status, t.scheduledFor)],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: id(),
    notificationId: uuid()
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    phoneId: uuid()
      .notNull()
      .references(() => phones.id, { onDelete: "cascade" }),
    channel: text().$type<"socket" | "apns">().notNull(),
    status: text().$type<"sent" | "acked" | "failed">().notNull(),
    apnsId: text(),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.notificationId)],
);

export const userSettings = pgTable("user_settings", {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Tokens for agents (e.g. a Hermes agent over MCP). Only a SHA-256 hash is stored. */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    userId: owner(),
    name: text().notNull(),
    /** First characters of the token, for recognizing it in the console. */
    prefix: text().notNull(),
    tokenHash: text().notNull(),
    scopes: text().array().$type<Array<"read" | "notify">>().notNull(),
    lastUsedAt: ts(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.tokenHash), index().on(t.userId)],
);
