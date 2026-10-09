import {
  FEATURE_HAPTIC_SEQ,
  type HapticPattern,
  type PhoneConfig,
  type ServerMessage,
} from "@hearloom/shared";
import type { ServerWebSocket } from "bun";
import type { StreamWriter } from "./stream-writer";

export interface IngestSocketData {
  kind: "ingest";
  userId: string;
  /** The session the socket authenticated with (closed when it is revoked). */
  sessionId: string;
  phoneId: string | null;
  slots: Map<number, StreamWriter>;
  /** Serializes control messages for this socket (see Lanes). */
  queue: Promise<void>;
  /** Serializes each slot's audio, hello and bye (see Lanes). */
  slotQueues: Map<number, Promise<void>>;
  /** Set when the socket closes; queued work after that must not register it again. */
  closed: boolean;
  /** What the app build on this socket can do (`presence`/`hello` `features`); none if unsaid. */
  features?: ReadonlySet<string>;
}

/** Live phone connections, used to push notifications/haptics down the ingest socket. */
const byPhone = new Map<string, Set<ServerWebSocket<IngestSocketData>>>();

export function registerPhoneSocket(phoneId: string, ws: ServerWebSocket<IngestSocketData>): void {
  const set = byPhone.get(phoneId) ?? new Set();
  set.add(ws);
  byPhone.set(phoneId, set);
}

export function unregisterPhoneSocket(ws: ServerWebSocket<IngestSocketData>): void {
  const phoneId = ws.data.phoneId;
  if (!phoneId) return;
  const set = byPhone.get(phoneId);
  set?.delete(ws);
  if (set && set.size === 0) byPhone.delete(phoneId);
}

/** The features a `presence`/`hello` advertised; a message without the field leaves them as they are. */
export function setSocketFeatures(
  ws: ServerWebSocket<IngestSocketData>,
  features: string[] | undefined,
): void {
  if (features) ws.data.features = new Set(features);
}

export function isPhoneOnline(phoneId: string): boolean {
  return (byPhone.get(phoneId)?.size ?? 0) > 0;
}

/** The newest connection of each of the user's online phones. */
function userSockets(userId: string): ServerWebSocket<IngestSocketData>[] {
  const out: ServerWebSocket<IngestSocketData>[] = [];
  for (const set of byPhone.values()) {
    const ws = [...set].at(-1);
    if (ws?.data.userId === userId) out.push(ws);
  }
  return out;
}

/** Send to the newest connection of each of the user's online phones; how many were sent to. */
export function sendToUserPhones(userId: string, msg: ServerMessage): number {
  const text = JSON.stringify(msg);
  let sent = 0;
  for (const ws of userSockets(userId)) if (ws.send(text) !== 0) sent++;
  return sent;
}

/** Send to the phone's newest connection. Returns false if the phone is offline. */
export function sendToPhone(phoneId: string, msg: ServerMessage): boolean {
  const set = byPhone.get(phoneId);
  if (!set || set.size === 0) return false;
  const ws = [...set].at(-1)!;
  return ws.send(JSON.stringify(msg)) !== 0;
}

export function sendConfigToUser(userId: string, config: PhoneConfig): void {
  for (const set of byPhone.values()) {
    for (const ws of set) {
      if (ws.data.userId === userId) ws.send(JSON.stringify({ t: "config", config }));
    }
  }
}

// ---- pendant buzz cues ------------------------------------------------------------------------

/** How long a phone may still play a `haptic_seq` after receiving it (unless the cue says less). */
export const HAPTIC_SEQ_TTL_MS = 20_000;
/** An ack later than the ttl plus this is reported missing. */
const ACK_GRACE_MS = 5_000;

/** `haptic_seq` sent and not yet acked (by id), each to one phone. */
const awaitingAck = new Map<string, { phoneId: string; label: string; timer: Timer }>();

/**
 * Buzz the pendants of the user's online phones with a cue of pulses `intervalMs` apart (start to
 * start). A phone whose newest connection has the `haptic_seq` feature gets the whole cue in one
 * message and plays it itself; older builds get one `haptic` per pulse, timed here (they buzz
 * medium for any pattern they don't know, so they never get anything new). `ttlMs`: how late the
 * phone may still play it (it holds a cue back to keep it apart from the previous one). Resolves
 * once the last legacy pulse is sent; returns how many phones it was sent to.
 */
export async function buzzUserPhones(
  userId: string,
  pulses: HapticPattern[],
  intervalMs: number,
  { ttlMs = HAPTIC_SEQ_TTL_MS, label = "cue" }: { ttlMs?: number; label?: string } = {},
): Promise<number> {
  const sockets = userSockets(userId);
  let reached = 0;
  const legacy: ServerWebSocket<IngestSocketData>[] = [];
  for (const ws of sockets) {
    if (!ws.data.features?.has(FEATURE_HAPTIC_SEQ)) {
      legacy.push(ws);
      continue;
    }
    const id = crypto.randomUUID();
    const msg: ServerMessage = {
      t: "haptic_seq",
      id,
      pulses,
      intervalMs,
      ttlMs,
    };
    if (ws.send(JSON.stringify(msg)) === 0) continue;
    reached++;
    const phoneId = ws.data.phoneId ?? "?";
    const timer = setTimeout(() => {
      if (!awaitingAck.delete(id)) return;
      console.warn(`[haptics] phone ${phoneId} never acked ${label} ${id}`);
    }, ttlMs + ACK_GRACE_MS);
    timer.unref();
    awaitingAck.set(id, { phoneId, label, timer });
  }
  for (const [i, pattern] of pulses.entries()) {
    if (legacy.length === 0) break;
    if (i > 0) await Bun.sleep(intervalMs);
    const text = JSON.stringify({ t: "haptic", pattern } satisfies ServerMessage);
    let sent = 0;
    for (const ws of legacy) if (ws.send(text) !== 0) sent++;
    if (i === 0) reached += sent;
  }
  return reached;
}

/** The phone's answer to a `haptic_seq`. */
export function onHapticAck(
  phoneId: string | null,
  ack: { id: string; played: boolean; reason?: string },
): void {
  const entry = awaitingAck.get(ack.id);
  // Unknown (sent before a restart) or someone else's: nothing to do.
  if (!entry || entry.phoneId !== phoneId) return;
  clearTimeout(entry.timer);
  awaitingAck.delete(ack.id);
  if (!ack.played)
    console.warn(
      `[haptics] phone ${phoneId} didn't play ${entry.label} ${ack.id}: ${ack.reason ?? "no reason given"}`,
    );
}
