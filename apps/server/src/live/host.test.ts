import { describe, expect, test } from "bun:test";
import type { AudioFrame } from "@hearloom/shared";
import type { StreamMeta } from "../ingest/stream-writer";
import { LivePipelineHost, type PipelineChild, type SpawnPipeline } from "./host";
import type { ChildMessage, HostMessage } from "./ipc";

const meta: StreamMeta = {
  id: "0199b0f4-0000-7000-8000-000000000001",
  userId: "u1",
  codec: 21,
  sampleRate: 16000,
  frameMs: 20,
};

const backlogMeta: StreamMeta = { ...meta, id: "0199b0f4-0000-7000-8000-000000000009" };

/** `n` frames from `seq`, the first captured at `t0`. */
function frames(seq: number, n: number, t0 = 1_760_000_000_000): AudioFrame[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: seq + i,
    at: t0 + i * 20,
    data: new Uint8Array([0xb8]),
  }));
}

const receivedAts = (child: FakeChild) => child.frames.map((m) => m.t === "frames" && m.receivedAt);
const firstSeqs = (child: FakeChild) =>
  child.frames.map((m) => m.t === "frames" && `${m.stream.id.slice(-1)}:${m.frames[0]!.seq}`);

class FakeChild implements PipelineChild {
  sent: HostMessage[] = [];
  killed: string[] = [];
  private exit!: (code: number | null) => void;
  readonly exited: Promise<unknown>;
  constructor(
    private readonly handlers: {
      onMessage(msg: ChildMessage): void;
      onExit(code: number | null): void;
    },
  ) {
    this.exited = new Promise((resolve) => {
      this.exit = (code) => {
        handlers.onExit(code);
        resolve(code);
      };
    });
  }
  send(msg: HostMessage): void {
    this.sent.push(msg);
  }
  kill(signal: string): void {
    this.killed.push(signal);
    this.die(null);
  }
  ready(): void {
    this.handlers.onMessage({ t: "ready" });
  }
  die(code: number | null): void {
    this.exit(code);
  }
  get frames() {
    return this.sent.filter((m) => m.t === "frames");
  }
}

function setup() {
  const children: FakeChild[] = [];
  const spawn: SpawnPipeline = (handlers) => {
    const child = new FakeChild(handlers);
    children.push(child);
    return child;
  };
  const host = new LivePipelineHost(spawn, 5);
  return { host, children };
}

describe("LivePipelineHost", () => {
  test("sends frames with the time the server received them", () => {
    const { host, children } = setup();
    host.start(true);
    children[0]!.ready();
    host.push(meta, frames(0, 3), 1234);
    expect(children[0]!.frames).toMatchObject([{ t: "frames", receivedAt: 1234 }]);
  });

  test("holds frames that arrive while the child is starting or restarting", async () => {
    const { host, children } = setup();
    const now = Date.now();
    host.start(true);
    host.push(meta, frames(0, 3, now - 1000), now - 500); // still loading models
    children[0]!.ready();
    host.push(meta, frames(3, 3, now - 400), now);
    expect(receivedAts(children[0]!)).toEqual([now - 500, now]);

    children[0]!.die(1); // crashed
    host.push(meta, frames(6, 3, now), now + 1);
    host.push(meta, frames(9, 3, now + 60), now + 2);
    await Bun.sleep(20); // restart backoff
    expect(children).toHaveLength(2);
    expect(children[1]!.frames).toHaveLength(0);
    children[1]!.ready();
    // Held briefly: still live (judged from when they arrived).
    expect(receivedAts(children[1]!)).toEqual([now + 1, now + 2]);
    expect(firstSeqs(children[1]!)).toEqual(["1:6", "1:9"]);
    await host.stop();
  });

  test("frames held too long to count as live are sent as received now (backlog)", () => {
    const { host, children } = setup();
    const now = Date.now();
    host.start(true);
    host.push(meta, frames(0, 3, now - 40_000), now - 39_500); // the child took 40 s to come back
    host.push(meta, frames(3, 3, now - 2_000), now - 1_500);
    children[0]!.ready();
    const [stale, recent] = receivedAts(children[0]!) as number[];
    expect(stale).toBeGreaterThanOrEqual(now);
    expect(recent).toBe(now - 1_500);
  });

  test("holds a bounded amount, dropping the oldest audio (backlog) first", () => {
    const { host, children } = setup();
    const now = Date.now();
    host.start(true);
    // An old stream uploading interleaved with the live one, 40 000 frames in all.
    for (let i = 0; i < 20; i++) {
      host.push(backlogMeta, frames(i * 1000, 1000, now - 3_600_000 + i * 20_000), now);
      host.push(meta, frames(i * 1000, 1000, now - 400_000 + i * 20_000), now);
    }
    children[0]!.ready();
    const sent = firstSeqs(children[0]!) as string[];
    expect(sent).toHaveLength(30);
    // All of the live stream's frames survive; the oldest 10 backlog batches went.
    expect(sent.filter((s) => s.startsWith("1:"))).toHaveLength(20);
    expect(sent.filter((s) => s.startsWith("9:"))[0]).toBe("9:10000");
  });

  test("not restarted when it dies during shutdown (it got the signal too)", async () => {
    const { host, children } = setup();
    host.start(true);
    children[0]!.ready();
    host.beginShutdown();
    children[0]!.die(null); // got the Ctrl-C itself
    host.push(meta, frames(0, 3), 1000);
    await Bun.sleep(20);
    expect(children).toHaveLength(1);
    await host.stop();
    expect(children).toHaveLength(1);
  });

  test("keeps sending frames to a running child during shutdown, until it is stopped", async () => {
    const { host, children } = setup();
    host.start(true);
    children[0]!.ready();
    host.beginShutdown(); // SIGTERM: the server flushes for a few seconds first
    host.push(meta, frames(0, 3), Date.now());
    expect(children[0]!.frames).toHaveLength(1);
    await host.stop();
    host.push(meta, frames(3, 3), Date.now());
    expect(children[0]!.frames).toHaveLength(1);
  });

  test("a restart already scheduled is cancelled by the shutdown", async () => {
    const { host, children } = setup();
    host.start(true);
    children[0]!.die(1);
    await host.stop();
    await Bun.sleep(20);
    expect(children).toHaveLength(1);
  });

  test("holds nothing when the pipeline is off or can't start", () => {
    const off = setup();
    off.host.start(false);
    off.host.push(meta, frames(0, 3), 1000);
    expect(off.children).toHaveLength(0);

    const { host, children } = setup();
    host.start(true);
    children[0]!.die(2); // misconfigured: not restarted
    host.push(meta, frames(0, 3), 1000);
    expect(children).toHaveLength(1);
    expect(host.running).toBe(false);
  });
});
