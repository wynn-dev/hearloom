import { describe, expect, test } from "bun:test";
import { encodeAudioBatch } from "@hearloom/shared";
import { afterAll, type Lanes, schedule, slotOf } from "./lanes";

const audio = (slot: number) =>
  encodeAudioBatch(slot, [{ seq: 0, at: 1_760_000_000_000, data: new Uint8Array([0xb8]) }]);
const hello = (slot: number) => JSON.stringify({ t: "hello", slot });
const bye = (slot: number) => JSON.stringify({ t: "bye", slot, endedAt: 0 });
const ping = JSON.stringify({ t: "ping", at: 0 });

/** A handler that finishes when the test says so. */
function gate() {
  let open!: () => void;
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, done };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function lanes(): Lanes {
  return { queue: Promise.resolve(), slotQueues: new Map() };
}

describe("ingest lanes", () => {
  test("tells which slot a message belongs to", () => {
    expect(slotOf(audio(3))).toEqual({ slot: 3, kind: "audio" });
    expect(slotOf(hello(2))).toEqual({ slot: 2, kind: "hello" });
    expect(slotOf(bye(2))).toEqual({ slot: 2, kind: "bye" });
    expect(slotOf(ping)).toBeNull();
    expect(slotOf("not json")).toBeNull();
    expect(slotOf(new Uint8Array([0x7f, 1]))).toBeNull();
  });

  test("the live stream's audio doesn't wait for an old stream's slow batch", async () => {
    const l = lanes();
    const log: string[] = [];
    schedule(l, hello(0), async () => void log.push("hello 0"));
    schedule(l, hello(1), async () => void log.push("hello 1"));
    const slow = gate();
    schedule(l, audio(1), async () => {
      await slow.done; // backlog batch stuck on disk/DB
      log.push("backlog");
    });
    schedule(l, audio(0), async () => void log.push("live"));
    schedule(l, ping, async () => void log.push("ping"));
    await tick();
    expect(log.sort()).toEqual(["hello 0", "hello 1", "live", "ping"]);
    slow.open();
    await tick();
    expect(log.at(-1)).toBe("backlog");
  });

  test("a slot's audio waits for its hello; its bye waits for its audio", async () => {
    const l = lanes();
    const log: string[] = [];
    const slowHello = gate();
    schedule(l, hello(0), async () => {
      await slowHello.done; // awaiting the database
      log.push("hello");
    });
    schedule(l, audio(0), async () => void log.push("audio 1"));
    const slowAudio = gate();
    schedule(l, audio(0), async () => {
      await slowAudio.done;
      log.push("audio 2");
    });
    schedule(l, bye(0), async () => void log.push("bye"));
    await tick();
    expect(log).toEqual([]);
    slowHello.open();
    await tick();
    expect(log).toEqual(["hello", "audio 1"]);
    slowAudio.open();
    await tick();
    expect(log).toEqual(["hello", "audio 1", "audio 2", "bye"]);
  });

  test("an old stream's slow bye holds up neither a new live stream nor pings", async () => {
    const l = lanes();
    const log: string[] = [];
    schedule(l, hello(1), async () => void log.push("hello 1"));
    schedule(l, audio(1), async () => void log.push("backlog"));
    const slowBye = gate();
    schedule(l, bye(1), async () => {
      await slowBye.done; // muxing and uploading the last chunk
      log.push("bye 1");
    });
    schedule(l, hello(1), async () => void log.push("hello 1 again")); // the next old stream
    schedule(l, ping, async () => void log.push("ping"));
    schedule(l, hello(0), async () => void log.push("hello 0"));
    schedule(l, audio(0), async () => void log.push("live"));
    await tick();
    expect(log.sort()).toEqual(["backlog", "hello 0", "hello 1", "live", "ping"]);
    slowBye.open();
    await tick();
    expect(log.slice(-2)).toEqual(["bye 1", "hello 1 again"]);
  });

  test("closing runs after everything queued", async () => {
    const l = lanes();
    const log: string[] = [];
    schedule(l, hello(0), async () => void log.push("hello"));
    const slow = gate();
    schedule(l, audio(0), async () => {
      await slow.done;
      log.push("audio");
    });
    afterAll(l, () => void log.push("closed"));
    await tick();
    expect(log).toEqual(["hello"]);
    slow.open();
    await tick();
    expect(log).toEqual(["hello", "audio", "closed"]);
  });
});
