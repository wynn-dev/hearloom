import { MSG_AUDIO } from "@hearloom/shared";

/**
 * Message order on an ingest socket. Control messages run one at a time, in order. A slot's hello,
 * audio and bye run in order on that slot's own lane; a hello also waits for the control messages
 * before it (it binds the phone). So audio never races ahead of its hello and a slot is bound again
 * only once its previous stream's audio and bye are done, while a phone uploading old streams on
 * other slots (each batch waits for disk and the database; a bye muxes and uploads the last chunk)
 * holds up neither the live stream nor pings.
 */
export interface Lanes {
  /** Control messages. */
  queue: Promise<void>;
  /** Per slot: its last hello, audio batch or bye. */
  slotQueues: Map<number, Promise<void>>;
}

type Kind = "audio" | "hello" | "bye";

/** The slot a message is ordered with, if any (audio, hello, bye). */
export function slotOf(message: string | Uint8Array): { slot: number; kind: Kind } | null {
  if (typeof message !== "string") {
    return message[0] === MSG_AUDIO && message.length > 1
      ? { slot: message[1]!, kind: "audio" }
      : null;
  }
  try {
    const m = JSON.parse(message) as { t?: unknown; slot?: unknown };
    if ((m?.t === "hello" || m?.t === "bye") && Number.isInteger(m.slot))
      return { slot: m.slot as number, kind: m.t };
  } catch {
    // Handled (and reported) by the message handler.
  }
  return null;
}

/** Queue `run` (which must not reject) behind what it has to wait for. */
export function schedule(
  lanes: Lanes,
  message: string | Uint8Array,
  run: () => Promise<void>,
): void {
  const lane = slotOf(message);
  if (!lane) {
    lanes.queue = lanes.queue.then(run);
    return;
  }
  const prev = lanes.slotQueues.get(lane.slot);
  // Audio or a bye before its slot's first hello on this socket: behind the control messages so far.
  const after = lane.kind === "hello" ? Promise.all([lanes.queue, prev]) : (prev ?? lanes.queue);
  lanes.slotQueues.set(lane.slot, after.then(run));
}

/** Run `fn` after everything queued so far. */
export function afterAll(lanes: Lanes, fn: () => void): void {
  lanes.queue = Promise.all([lanes.queue, ...lanes.slotQueues.values()]).then(fn);
}
