import { join } from "node:path";
import { schema } from "@hearloom/db";
import {
  type ClientMessage,
  decodeAudioBatch,
  INGEST_PROTOCOL_VERSION,
  MSG_AUDIO,
  parseClientMessage,
  type ServerMessage,
  SUPPORTED_CODECS,
  type WearableInfo,
} from "@hearloom/shared";
import type { ServerWebSocket } from "bun";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { updateLiveState } from "../live/state";
import { onBattery, onPhoneSocket, onWearableConnection } from "../notify/alerts";
import { onSocketAck, recordFeedback } from "../notify/gateway";
import { invalidate } from "../realtime";
import { getSettings, phoneConfig } from "../settings";
import { type IngestSocketData, registerPhoneSocket, unregisterPhoneSocket } from "./phones";
import { dbChunkSink } from "./sink";
import { type StreamMeta, StreamWriter } from "./stream-writer";

type Ws = ServerWebSocket<IngestSocketData>;
const { captureStreams, deviceEvents, phones, wearables, bookmarks, notifications } = schema;

export const SPOOL_DIR = join(env.DATA_DIR, "spool");

/** Open writers, shared across reconnects. A writer is dropped once idle and unattached. */
const writers = new Map<string, StreamWriter>();
const attached = new Map<string, Set<Ws>>();

/** Hook for the live pipeline: receives every newly stored batch of frames. */
let frameListener:
  | ((meta: StreamMeta, frames: import("@hearloom/shared").AudioFrame[]) => void)
  | null = null;
export function setFrameListener(fn: typeof frameListener): void {
  frameListener = fn;
}

function send(ws: Ws, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function fail(ws: Ws, code: string, message: string, fatal = false): void {
  send(ws, { t: "error", code, message, fatal });
  if (fatal) ws.close(1008, code);
}

function getWriter(meta: StreamMeta, ackedSeq: number): StreamWriter {
  let w = writers.get(meta.id);
  if (!w) {
    w = new StreamWriter(meta, ackedSeq, dbChunkSink, {
      spoolDir: SPOOL_DIR,
      maxChunkMs: env.CHUNK_MAX_SEC * 1000,
      gapMs: env.CHUNK_GAP_MS,
      idleMs: env.CHUNK_IDLE_MS,
    });
    const writer = w;
    writer.onFrames = (m, frames) => frameListener?.(m, frames);
    writer.onIdle = () => {
      if ((attached.get(meta.id)?.size ?? 0) === 0 && writers.get(meta.id) === writer) {
        writers.delete(meta.id);
        writer.dispose();
      }
    };
    writers.set(meta.id, w);
  }
  return w;
}

async function upsertWearable(userId: string, info: WearableInfo): Promise<string> {
  const [row] = await db
    .insert(wearables)
    .values({
      userId,
      peripheralId: info.peripheralId,
      name: info.name,
      model: info.model ?? null,
      firmware: info.firmware ?? null,
      hardwareRev: info.hardwareRev ?? null,
      serial: info.serial ?? null,
      batteryLevel: info.battery ?? null,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [wearables.userId, wearables.peripheralId],
      set: {
        name: info.name,
        ...(info.model ? { model: info.model } : {}),
        ...(info.firmware ? { firmware: info.firmware } : {}),
        ...(info.hardwareRev ? { hardwareRev: info.hardwareRev } : {}),
        ...(info.serial ? { serial: info.serial } : {}),
        ...(info.battery !== undefined ? { batteryLevel: info.battery } : {}),
        lastSeenAt: new Date(),
      },
    })
    .returning({ id: wearables.id });
  return row!.id;
}

async function wearableIdFor(userId: string, peripheralId?: string): Promise<string | null> {
  if (!peripheralId) return null;
  const [row] = await db
    .select({ id: wearables.id })
    .from(wearables)
    .where(and(eq(wearables.userId, userId), eq(wearables.peripheralId, peripheralId)));
  return row?.id ?? null;
}

async function deviceEvent(
  ws: Ws,
  kind: string,
  at: number,
  payload: Record<string, unknown>,
  wearableId: string | null,
): Promise<void> {
  await db.insert(deviceEvents).values({
    userId: ws.data.userId,
    phoneId: ws.data.phoneId,
    wearableId,
    kind,
    payload,
    at: new Date(at),
  });
}

async function onHello(ws: Ws, msg: Extract<ClientMessage, { t: "hello" }>): Promise<void> {
  const { userId } = ws.data;
  if (msg.v !== INGEST_PROTOCOL_VERSION) {
    return fail(ws, "protocol_version", `server speaks v${INGEST_PROTOCOL_VERSION}`, true);
  }
  if (!SUPPORTED_CODECS.has(msg.stream.codec)) {
    return fail(ws, "codec", `codec ${msg.stream.codec} not supported`, true);
  }
  const [phone] = await db
    .select({ id: phones.id })
    .from(phones)
    .where(and(eq(phones.id, msg.phoneId), eq(phones.userId, userId)));
  if (!phone) return fail(ws, "unknown_phone", "register this phone first", true);

  if (ws.data.phoneId !== msg.phoneId) {
    unregisterPhoneSocket(ws);
    ws.data.phoneId = msg.phoneId;
    registerPhoneSocket(msg.phoneId, ws);
    void onPhoneSocket(userId, msg.phoneId, true);
  }
  await db.update(phones).set({ lastSeenAt: new Date() }).where(eq(phones.id, msg.phoneId));

  const wearableId = msg.wearable ? await upsertWearable(userId, msg.wearable) : null;
  await db
    .insert(captureStreams)
    .values({
      id: msg.stream.id,
      userId,
      phoneId: msg.phoneId,
      wearableId,
      codec: msg.stream.codec,
      sampleRate: msg.stream.sampleRate,
      frameMs: msg.stream.frameMs,
      startedAt: new Date(msg.stream.startedAt),
    })
    .onConflictDoNothing({ target: captureStreams.id });
  const [stream] = await db
    .select()
    .from(captureStreams)
    .where(eq(captureStreams.id, msg.stream.id));
  if (!stream || stream.userId !== userId)
    return fail(ws, "stream", "stream belongs to another user", true);

  const meta: StreamMeta = {
    id: stream.id,
    userId,
    codec: stream.codec,
    sampleRate: stream.sampleRate,
    frameMs: stream.frameMs,
  };
  const writer = getWriter(meta, stream.ackedSeq);
  const prev = ws.data.slots.get(msg.slot);
  if (prev && prev !== writer) attached.get(prev.meta.id)?.delete(ws);
  ws.data.slots.set(msg.slot, writer);
  const refs = attached.get(stream.id) ?? new Set<Ws>();
  refs.add(ws);
  attached.set(stream.id, refs);

  updateLiveState(userId, { wearableConnected: true });
  const settings = await getSettings(userId);
  send(ws, {
    t: "welcome",
    slot: msg.slot,
    streamId: stream.id,
    ackedSeq: writer.ackedSeq,
    serverTime: Date.now(),
    config: phoneConfig(settings),
  });
  invalidate(userId, ["status"]);
}

async function onAudio(ws: Ws, data: Uint8Array): Promise<void> {
  const batch = decodeAudioBatch(data);
  const writer = ws.data.slots.get(batch.slot);
  if (!writer) return fail(ws, "slot", `slot ${batch.slot} has no stream (send hello first)`);
  const ack = await writer.append(batch.frames);
  send(ws, { t: "ack", slot: batch.slot, seq: ack });
  updateLiveState(ws.data.userId, { lastAudioAt: Date.now() });
}

async function onBye(ws: Ws, slot: number, endedAt: number): Promise<void> {
  const writer = ws.data.slots.get(slot);
  if (!writer) return;
  ws.data.slots.delete(slot);
  attached.get(writer.meta.id)?.delete(ws);
  await writer.flush();
  await db
    .update(captureStreams)
    .set({ endedAt: new Date(endedAt) })
    .where(eq(captureStreams.id, writer.meta.id));
  invalidate(ws.data.userId, ["status"]);
}

async function onControl(ws: Ws, msg: ClientMessage): Promise<void> {
  const { userId } = ws.data;
  switch (msg.t) {
    case "hello":
      return onHello(ws, msg);
    case "bye":
      return onBye(ws, msg.slot, msg.endedAt);
    case "ping":
      return send(ws, { t: "pong", at: msg.at, serverTime: Date.now() });
    case "notify_ack":
      if (ws.data.phoneId) onSocketAck(msg.id, ws.data.phoneId);
      return;
    case "wearable": {
      const wearableId = await upsertWearable(userId, msg.wearable);
      await deviceEvent(
        ws,
        msg.connected ? "wearable_connected" : "wearable_disconnected",
        msg.at,
        { name: msg.wearable.name, battery: msg.wearable.battery ?? null },
        wearableId,
      );
      updateLiveState(userId, { wearableConnected: msg.connected });
      if (ws.data.phoneId) {
        void onWearableConnection(
          userId,
          ws.data.phoneId,
          msg.wearable.peripheralId,
          msg.connected,
        );
      }
      invalidate(userId, ["status", "timeline"]);
      return;
    }
    case "event": {
      const wearableId = await wearableIdFor(userId, msg.peripheralId);
      await deviceEvent(ws, msg.kind, msg.at, { value: msg.value ?? null }, wearableId);
      if (msg.kind === "battery" && typeof msg.value === "number" && wearableId) {
        await db
          .update(wearables)
          .set({ batteryLevel: msg.value, lastSeenAt: new Date() })
          .where(eq(wearables.id, wearableId));
        if (msg.peripheralId) void onBattery(userId, msg.peripheralId, msg.value, false);
      } else if (msg.kind === "charging" && msg.value === true && msg.peripheralId) {
        void onBattery(userId, msg.peripheralId, 100, true);
      } else if (msg.kind === "bookmark") {
        await db.insert(bookmarks).values({ userId, at: new Date(msg.at), source: "button" });
      } else if (msg.kind === "muted" || msg.kind === "unmuted") {
        updateLiveState(userId, { muted: msg.kind === "muted" });
      } else if (msg.kind === "ack_nudge") {
        await acknowledgeLatestNudge(userId);
      }
      invalidate(userId, ["status", "timeline"]);
      return;
    }
  }
}

/** Pendant long-press: mark the most recent nudge (last 30 min) as opened. */
async function acknowledgeLatestNudge(userId: string): Promise<void> {
  const [latest] = await db
    .select({ id: notifications.id, sentAt: notifications.sentAt })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.source, "agent")))
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  if (latest?.sentAt && Date.now() - latest.sentAt.getTime() < 30 * 60_000) {
    await recordFeedback(userId, latest.id, "opened");
  }
}

async function handleMessage(ws: Ws, message: string | Buffer): Promise<void> {
  if (ws.data.closed) return;
  try {
    if (typeof message === "string") {
      await onControl(ws, parseClientMessage(message));
    } else if (message[0] === MSG_AUDIO) {
      await onAudio(ws, new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
    } else {
      fail(ws, "bad_message", "unknown binary message type");
    }
  } catch (err) {
    console.error("[ingest]", err);
    fail(ws, "bad_message", err instanceof Error ? err.message : String(err));
  }
}

export const ingestHandlers = {
  open(ws: Ws): void {
    ws.data.slots = new Map();
    ws.data.queue = Promise.resolve();
    ws.data.closed = false;
  },
  message(ws: Ws, message: string | Buffer): void {
    // Handle one message at a time per socket so audio never races ahead of its hello.
    ws.data.queue = ws.data.queue.then(() => handleMessage(ws, message));
  },
  close(ws: Ws): void {
    ws.data.closed = true;
    // Run after any in-flight message (e.g. a hello still awaiting the DB), so nothing registers
    // this socket again once it's gone.
    ws.data.queue = ws.data.queue.then(() => {
      for (const writer of ws.data.slots.values()) attached.get(writer.meta.id)?.delete(ws);
      ws.data.slots.clear();
      const phoneId = ws.data.phoneId;
      unregisterPhoneSocket(ws);
      if (phoneId) {
        void db.update(phones).set({ lastSeenAt: new Date() }).where(eq(phones.id, phoneId));
        void onPhoneSocket(ws.data.userId, phoneId, false);
        invalidate(ws.data.userId, ["status", "phones"]);
      }
    });
  },
};

/** Flush every open chunk (graceful shutdown). */
export async function flushAllWriters(): Promise<void> {
  await Promise.all([...writers.values()].map((w) => w.flush()));
  for (const w of writers.values()) w.dispose();
}
