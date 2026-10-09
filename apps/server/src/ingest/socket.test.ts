import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAudioBatch, type ServerMessage } from "@hearloom/shared";
import type { ServerWebSocket } from "bun";
import type { IngestSocketData } from "./phones";
import { ingestHandlers } from "./socket";
import { type ChunkSink, type StreamMeta, StreamWriter } from "./stream-writer";

const meta: StreamMeta = {
  id: "0199b0f4-0000-7000-8000-000000000002",
  userId: "u1",
  codec: 21,
  sampleRate: 16000,
  frameMs: 20,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hearloom-socket-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeSocket() {
  const sent: ServerMessage[] = [];
  const ws = {
    data: {
      kind: "ingest",
      userId: meta.userId,
      sessionId: "s1",
      phoneId: null,
    } as IngestSocketData,
    send: (text: string) => {
      sent.push(JSON.parse(text));
      return text.length;
    },
    close: () => {},
  } as unknown as ServerWebSocket<IngestSocketData>;
  ingestHandlers.open(ws);
  return { ws, sent };
}

const batch = (slot: number, seq: number) =>
  Buffer.from(
    encodeAudioBatch(
      slot,
      Array.from({ length: 5 }, (_, i) => ({
        seq: seq + i,
        at: 1_760_000_000_000 + (seq + i) * 20,
        data: new Uint8Array([0xb8, i]),
      })),
    ),
  );

describe("ingest socket", () => {
  test("a batch that couldn't be stored gets an error for its slot, then the resend is acked", async () => {
    let failing = true;
    const sink: ChunkSink = {
      saveChunk: async () => {},
      saveProgress: async () => {
        if (failing) throw new Error("connection terminated");
      },
    };
    const writer = new StreamWriter(meta, -1, sink, {
      spoolDir: dir,
      maxChunkMs: 60_000,
      gapMs: 2000,
      idleMs: 60_000,
    });
    const { ws, sent } = fakeSocket();
    ws.data.slots.set(3, writer); // as bound by a hello

    ingestHandlers.message(ws, batch(3, 0));
    await ws.data.slotQueues.get(3);
    expect(sent).toEqual([
      { t: "error", code: "store_failed", message: "connection terminated", fatal: false, slot: 3 },
    ]);

    failing = false;
    ingestHandlers.message(ws, batch(3, 0)); // the phone resends from its ack
    await ws.data.slotQueues.get(3);
    expect(sent.at(-1)).toEqual({ t: "ack", slot: 3, seq: 4 });
    await writer.flush();
    writer.dispose();
  });
});
