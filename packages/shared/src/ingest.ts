/**
 * Hearloom ingest protocol v1 — phone <-> server over one WebSocket (`/ingest`).
 * Spec: docs/protocol.md. Binary messages carry audio; text messages are JSON control.
 *
 * Audio batch (binary, little-endian):
 *   u8  type = 0x01
 *   u8  slot            (client-chosen stream slot, bound by a prior "hello")
 *   u64 firstSeq        (seq of the first frame; frames are numbered 0.. per stream)
 *   u64 baseTimeMs      (unix ms capture time of the first frame)
 *   u16 count
 *   count x { u32 offsetMs (since baseTimeMs), u16 len, u8[len] opusFrame }
 *
 * Frames in a batch have consecutive seqs. The server acks the highest seq for which
 * every frame 0..seq is durably stored; the phone deletes journaled frames <= ack.
 */

import { z } from "zod";
import type { ButtonAction } from "./settings";

export const INGEST_PROTOCOL_VERSION = 1;
export const MSG_AUDIO = 0x01;
const AUDIO_HEADER = 1 + 1 + 8 + 8 + 2;
const FRAME_HEADER = 4 + 2;
export const MAX_FRAMES_PER_BATCH = 1000;
/** Plausible capture times (2017–2100), so a corrupt batch can't produce invalid dates. */
const MIN_TIME_MS = 1_500_000_000_000;
const MAX_TIME_MS = 4_100_000_000_000;

export interface AudioFrame {
  seq: number;
  /** unix ms */
  at: number;
  data: Uint8Array;
}

export interface AudioBatch {
  slot: number;
  frames: AudioFrame[];
}

export function encodeAudioBatch(slot: number, frames: AudioFrame[]): Uint8Array {
  if (frames.length === 0) throw new Error("empty batch");
  if (frames.length > MAX_FRAMES_PER_BATCH) throw new Error("batch too large");
  const first = frames[0]!;
  const size = frames.reduce((n, f) => n + FRAME_HEADER + f.data.length, AUDIO_HEADER);
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  view.setUint8(0, MSG_AUDIO);
  view.setUint8(1, slot);
  view.setBigUint64(2, BigInt(first.seq), true);
  view.setBigUint64(10, BigInt(first.at), true);
  view.setUint16(18, frames.length, true);
  let o = AUDIO_HEADER;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.seq !== first.seq + i) throw new Error("frames must have consecutive seqs");
    const offset = f.at - first.at;
    if (offset < 0 || offset > 0xffffffff) throw new Error("frame time out of range");
    if (f.data.length > 0xffff) throw new Error("frame too large");
    view.setUint32(o, offset, true);
    view.setUint16(o + 4, f.data.length, true);
    buf.set(f.data, o + FRAME_HEADER);
    o += FRAME_HEADER + f.data.length;
  }
  return buf;
}

export function decodeAudioBatch(input: ArrayBuffer | Uint8Array): AudioBatch {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (buf.length < AUDIO_HEADER) throw new Error("short audio batch");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint8(0) !== MSG_AUDIO) throw new Error("not an audio batch");
  const slot = view.getUint8(1);
  const firstSeq = Number(view.getBigUint64(2, true));
  const base = Number(view.getBigUint64(10, true));
  const count = view.getUint16(18, true);
  if (count === 0 || count > MAX_FRAMES_PER_BATCH) throw new Error("bad frame count");
  if (firstSeq > Number.MAX_SAFE_INTEGER - count) throw new Error("seq out of range");
  if (base < MIN_TIME_MS || base > MAX_TIME_MS) throw new Error("capture time out of range");
  const frames: AudioFrame[] = [];
  let o = AUDIO_HEADER;
  for (let i = 0; i < count; i++) {
    if (o + FRAME_HEADER > buf.length) throw new Error("truncated frame header");
    const offset = view.getUint32(o, true);
    const len = view.getUint16(o + 4, true);
    o += FRAME_HEADER;
    if (base + offset > MAX_TIME_MS) throw new Error("capture time out of range");
    if (o + len > buf.length) throw new Error("truncated frame");
    frames.push({ seq: firstSeq + i, at: base + offset, data: buf.slice(o, o + len) });
    o += len;
  }
  if (o !== buf.length) throw new Error("trailing bytes in audio batch");
  return { slot, frames };
}

// ---- JSON control messages -------------------------------------------------------------

export const wearableInfoSchema = z.object({
  peripheralId: z.string().min(1).max(128),
  name: z.string().max(128),
  model: z.string().max(128).optional(),
  firmware: z.string().max(64).optional(),
  hardwareRev: z.string().max(64).optional(),
  serial: z.string().max(128).optional(),
  battery: z.number().int().min(0).max(100).optional(),
});
export type WearableInfo = z.infer<typeof wearableInfoSchema>;

const unixMs = z.number().int().nonnegative();

export const clientMessageSchema = z.discriminatedUnion("t", [
  /** Register the phone on this socket (notifications, config) without opening a stream. */
  z.object({ t: z.literal("presence"), v: z.number().int(), phoneId: z.uuid() }),
  z.object({
    t: z.literal("hello"),
    v: z.number().int(),
    slot: z.number().int().min(0).max(255),
    phoneId: z.uuid(),
    stream: z.object({
      id: z.uuid(),
      codec: z.number().int(),
      sampleRate: z.number().int().positive(),
      frameMs: z.number().int().positive(),
      startedAt: unixMs,
    }),
    wearable: wearableInfoSchema.optional(),
  }),
  z.object({ t: z.literal("bye"), slot: z.number().int().min(0).max(255), endedAt: unixMs }),
  z.object({
    t: z.literal("wearable"),
    wearable: wearableInfoSchema,
    connected: z.boolean(),
    at: unixMs,
  }),
  z.object({
    t: z.literal("event"),
    // `ack_nudge`: sent by app builds from before agent notifications were removed; ignored.
    kind: z.enum(["battery", "charging", "button", "bookmark", "muted", "unmuted", "ack_nudge"]),
    value: z.union([z.number(), z.string(), z.boolean()]).optional(),
    peripheralId: z.string().optional(),
    at: unixMs,
  }),
  z.object({ t: z.literal("notify_ack"), id: z.uuid() }),
  z.object({ t: z.literal("ping"), at: unixMs }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type HapticPattern = "short" | "medium" | "long";

/** Settings the phone needs locally (button actions must work offline). */
export interface PhoneConfig {
  button: { tap: ButtonAction; doubleTap: ButtonAction; hold: ButtonAction };
  pendantHaptic: boolean;
}

export type ServerMessage =
  | {
      t: "welcome";
      slot: number;
      streamId: string;
      ackedSeq: number;
      serverTime: number;
      config: PhoneConfig;
    }
  | { t: "ready"; serverTime: number; config: PhoneConfig }
  | { t: "config"; config: PhoneConfig }
  | { t: "ack"; slot: number; seq: number }
  | {
      t: "notify";
      id: string;
      title: string;
      body: string;
      category: string;
      deepLink?: string;
      interruptionLevel: "passive" | "active" | "time-sensitive";
      haptic?: HapticPattern;
    }
  | { t: "haptic"; pattern: HapticPattern }
  /** `slot` is set when the error concerns one stream; the rest of the socket keeps working. */
  | { t: "error"; code: string; message: string; fatal?: boolean; slot?: number }
  | { t: "pong"; at: number; serverTime: number };

export function parseClientMessage(text: string): ClientMessage {
  return clientMessageSchema.parse(JSON.parse(text));
}
