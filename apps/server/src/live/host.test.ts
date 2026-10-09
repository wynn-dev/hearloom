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

function frames(seq: number, n: number): AudioFrame[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: seq + i,
    at: 1_760_000_000_000 + (seq + i) * 20,
    data: new Uint8Array([0xb8]),
  }));
}

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
    host.start(true);
    host.push(meta, frames(0, 3), 1000); // still loading models
    children[0]!.ready();
    host.push(meta, frames(3, 3), 2000);
    expect(children[0]!.frames.map((m) => m.t === "frames" && m.receivedAt)).toEqual([1000, 2000]);

    children[0]!.die(1); // crashed
    host.push(meta, frames(6, 3), 3000);
    host.push(meta, frames(9, 3), 4000);
    await Bun.sleep(20); // restart backoff
    expect(children).toHaveLength(2);
    expect(children[1]!.frames).toHaveLength(0);
    children[1]!.ready();
    const resent = children[1]!.frames;
    expect(resent.map((m) => m.t === "frames" && m.receivedAt)).toEqual([3000, 4000]);
    expect(resent.map((m) => m.t === "frames" && m.frames[0]!.seq)).toEqual([6, 9]);
    await host.stop();
  });

  test("holds a bounded amount, dropping the oldest", () => {
    const { host, children } = setup();
    host.start(true);
    for (let i = 0; i < 40; i++) host.push(meta, frames(i * 1000, 1000), i);
    children[0]!.ready();
    const sent = children[0]!.frames;
    expect(sent).toHaveLength(30);
    expect(sent[0]!.t === "frames" && sent[0]!.receivedAt).toBe(10);
  });

  test("not restarted during shutdown, even if it dies before being told to stop", async () => {
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
