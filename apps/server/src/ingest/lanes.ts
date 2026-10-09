import { MSG_AUDIO } from "@hearloom/shared";

/**
 * Message order on an ingest socket. Control messages run one at a time, in order. Audio for a
 * slot waits only for that slot's earlier audio and its hello: a phone uploading old streams on
 * other slots (each batch waits for disk and the database) doesn't hold up the live stream.
 * `hello`/`bye` for a slot wait for both, so audio never races ahead of its hello and a stream's
 * audio is stored before its bye.
 */
export interface Lanes {
  /** Control messages. */
  queue: Promise<void>;
  /** Per slot: its last audio batch, hello or bye. */
  slotQueues: Map<number, Promise<void>>;
}

/** The slot a message is ordered with, if any (audio, hello, bye). */
export function slotOf(message: string | Uint8Array): { slot: number; audio: boolean } | null {
  if (typeof message !== "string") {
    return message[0] === MSG_AUDIO && message.length > 1
      ? { slot: message[1]!, audio: true }
      : null;
  }
  try {
    const m = JSON.parse(message) as { t?: unknown; slot?: unknown };
    if ((m?.t === "hello" || m?.t === "bye") && Number.isInteger(m.slot))
      return { slot: m.slot as number, audio: false };
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
  if (lane.audio) {
    // Before its slot's first hello on this socket, behind the control messages so far.
    lanes.slotQueues.set(lane.slot, (prev ?? lanes.queue).then(run));
    return;
  }
  const next = Promise.all([lanes.queue, prev]).then(run);
  lanes.queue = next;
  lanes.slotQueues.set(lane.slot, next);
}

/** Run `fn` after everything queued so far. */
export function afterAll(lanes: Lanes, fn: () => void): void {
  lanes.queue = Promise.all([lanes.queue, ...lanes.slotQueues.values()]).then(fn);
}
