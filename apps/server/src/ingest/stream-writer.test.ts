import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioFrame } from "@hearloom/shared";
import {
  type ChunkSink,
  type FinishedChunk,
  recoverSpool,
  SeqGapError,
  type StreamMeta,
  StreamWriter,
} from "./stream-writer";

const meta: StreamMeta = {
  id: "0199b0f4-0000-7000-8000-000000000001",
  userId: "u1",
  codec: 21,
  sampleRate: 16000,
  frameMs: 20,
};

function frame(seq: number, at: number): AudioFrame {
  const data = new Uint8Array(40);
  data[0] = 0xb8;
  data[1] = seq & 0xff;
  return { seq, at, data };
}

function run(startSeq: number, startAt: number, n: number): AudioFrame[] {
  return Array.from({ length: n }, (_, i) => frame(startSeq + i, startAt + i * 20));
}

class MemorySink implements ChunkSink {
  chunks: FinishedChunk[] = [];
  acked = -1;
  async saveChunk(_m: StreamMeta, c: FinishedChunk) {
    this.chunks.push(c);
  }
  async saveProgress(_m: StreamMeta, p: { ackedSeq: number }) {
    this.acked = Math.max(this.acked, p.ackedSeq);
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hearloom-spool-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const opts = () => ({ spoolDir: dir, maxChunkMs: 10_000, gapMs: 2000, idleMs: 60_000 });

describe("StreamWriter", () => {
  test("acks the highest stored seq and ignores resent frames", async () => {
    const sink = new MemorySink();
    const w = new StreamWriter(meta, -1, sink, opts());
    const t0 = 1_760_000_000_000;
    expect(await w.append(run(0, t0, 50))).toBe(49);
    // Phone resends overlapping frames after a reconnect.
    expect(await w.append(run(40, t0 + 40 * 20, 20))).toBe(59);
    await w.flush();
    w.dispose();
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]!.frameCount).toBe(60);
    expect(sink.chunks[0]!.durationMs).toBe(60 * 20);
    expect(sink.acked).toBe(59);
  });

  test("refuses a batch that skips frames, so the ack never covers a hole", async () => {
    const sink = new MemorySink();
    const w = new StreamWriter(meta, -1, sink, opts());
    const t0 = 1_760_000_000_000;
    expect(await w.append(run(0, t0, 10))).toBe(9);
    // Frames 10..19 were lost in transit; 20.. must not be stored or acked.
    await expect(w.append(run(20, t0 + 400, 10))).rejects.toBeInstanceOf(SeqGapError);
    expect(w.ackedSeq).toBe(9);
    // The phone resends from the ack and everything lines up again.
    expect(await w.append(run(10, t0 + 200, 20))).toBe(29);
    await w.flush();
  });

  test("splits chunks on long silences and at the max length", async () => {
    const sink = new MemorySink();
    const w = new StreamWriter(meta, -1, sink, opts());
    const t0 = 1_760_000_000_000;
    await w.append(run(0, t0, 100)); // 2 s
    await w.append(run(100, t0 + 2000 + 15_000, 600)); // after 15 s of mic sleep; 12 s long
    await w.flush();
    w.dispose();
    const durations = sink.chunks.map((c) => c.durationMs);
    expect(durations).toEqual([2000, 10_000, 2000]);
    expect(sink.chunks[1]!.startAt.getTime()).toBe(t0 + 17_000);
  });

  test("fills short gaps (lost BLE packets) to keep wall-clock timing", async () => {
    const sink = new MemorySink();
    const w = new StreamWriter(meta, -1, sink, opts());
    const t0 = 1_760_000_000_000;
    const frames = [...run(0, t0, 10), ...run(10, t0 + 10 * 20 + 5 * 20, 10)]; // 5 frames lost
    await w.append(frames);
    await w.flush();
    w.dispose();
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]!.frameCount).toBe(20);
    expect(sink.chunks[0]!.durationMs).toBe(25 * 20);
    expect(sink.chunks[0]!.endAt.getTime() - sink.chunks[0]!.startAt.getTime()).toBe(500);
  });

  test("recovers spooled frames after a crash", async () => {
    const crashed = new MemorySink();
    const w = new StreamWriter(meta, -1, crashed, opts());
    const t0 = 1_760_000_000_000;
    await w.append(run(0, t0, 75));
    w.dispose(); // simulate crash: never flushed
    expect(crashed.chunks).toHaveLength(0);

    const sink = new MemorySink();
    const recovered = await recoverSpool(dir, sink);
    expect(recovered.get(meta.id)).toBe(74);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]!.frameCount).toBe(75);
    expect(await readdir(dir)).toHaveLength(0);
  });
});

describe("recoverSpool", () => {
  test("parks unreadable spool files instead of failing startup", async () => {
    const spool = join(dir, "spool");
    await mkdir(join(spool, "bad-stream"), { recursive: true });
    await writeFile(join(spool, "bad-stream", "0.json"), ""); // torn meta write
    await writeFile(join(spool, "bad-stream", "0.spool"), new Uint8Array(10));
    const recovered = await recoverSpool(spool, new MemorySink());
    expect(recovered.size).toBe(0);
    expect((await readdir(join(dir, "spool-failed", "bad-stream"))).sort()).toEqual([
      "0.json",
      "0.spool",
    ]);
  });
});
