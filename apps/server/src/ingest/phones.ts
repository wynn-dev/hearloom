import type { PhoneConfig, ServerMessage } from "@hearloom/shared";
import type { ServerWebSocket } from "bun";
import type { StreamWriter } from "./stream-writer";

export interface IngestSocketData {
  kind: "ingest";
  userId: string;
  /** The session the socket authenticated with (closed when it is revoked). */
  sessionId: string;
  phoneId: string | null;
  slots: Map<number, StreamWriter>;
  /** Serializes message handling for this socket. */
  queue: Promise<void>;
  /** Set when the socket closes; queued work after that must not register it again. */
  closed: boolean;
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

export function isPhoneOnline(phoneId: string): boolean {
  return (byPhone.get(phoneId)?.size ?? 0) > 0;
}

/** Send to the newest connection of each of the user's online phones; how many were sent to. */
export function sendToUserPhones(userId: string, msg: ServerMessage): number {
  const text = JSON.stringify(msg);
  let sent = 0;
  for (const set of byPhone.values()) {
    const ws = [...set].at(-1);
    if (ws?.data.userId === userId && ws.send(text) !== 0) sent++;
  }
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
