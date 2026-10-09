import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { AudioFrame } from "@hearloom/shared";
import { FakeWs, settle } from "./asr/fake-ws";
import { type LiveDeps, STALL_CAP_MS, StreamProcessor, type Vad } from "./processor";
import { SpeakerClusters } from "./speakers";
import type { HeardUtterance } from "./voice/assembler";
import type { AudioSource } from "./voice/detector";

const T0 = 1_800_000_000_000;
const FRAME_MS = 20;

/**
 * Speech detection from a script: speech in [start, end] ms (after T0), "detected" 250 ms in, and
 * ending 600 ms after it stops (like Silero with its minimum durations).
 */
function scriptedVad(speech: [number, number][]) {
  return (runStartAt: number): Vad => {
    let pos = runStartAt;
    const done = new Set<number>();
    const segment = (i: number, until: number) => {
      const from = T0 + speech[i]![0];
      const to = Math.min(T0 + speech[i]![1], until);
      return {
        start: Math.round((from - runStartAt) * 16),
        samples: new Float32Array(Math.round((to - from) * 16)),
      };
    };
    return {
      accept(samples) {
        pos += samples.length / 16;
        const segments = [];
        for (const [i, [a, b]] of speech.entries()) {
          if (done.has(i) || T0 + a < runStartAt || T0 + b + 600 > pos) continue;
          done.add(i);
          segments.push(segment(i, pos));
        }
        const speaking = speech.some(([a, b]) => T0 + a + 250 <= pos && pos < T0 + b + 600);
        return { segments, speaking };
      },
      flush() {
        const out = [];
        for (const [i, [a]] of speech.entries()) {
          if (done.has(i) || T0 + a < runStartAt || T0 + a >= pos) continue;
          done.add(i);
          out.push(segment(i, pos));
        }
        return out;
      },
    };
  };
}

/** Frames covering [fromMs, toMs) after T0 (empty payloads: concealed as silence). */
function frames(fromMs: number, toMs: number): AudioFrame[] {
  const out: AudioFrame[] = [];
  for (let t = fromMs; t < toMs; t += FRAME_MS)
    out.push({ seq: t / FRAME_MS, at: T0 + t, data: new Uint8Array([0]) });
  return out;
}

const tok = (text: string, s: number, e: number) => ({
  text,
  start_ms: s,
  end_ms: e,
  is_final: true,
  speaker: "1",
});

function setup(speech: [number, number][], o: { failInsert?: boolean } = {}) {
  const heard: HeardUtterance[] = [];
  const health: boolean[] = [];
  const logs: string[] = [];
  const inserted: unknown[] = [];
  const deps = {
    db: {
      insert: () => ({
        values: async (row: unknown) => {
          if (o.failInsert) throw new Error("db down");
          inserted.push(row);
        },
      }),
    },
    modelsDir: "",
    tagger: null,
    embedder: null,
    speakers: null,
    blocks: {
      place: async () => ({ chainId: "c1", blockId: "b1", clusters: new SpeakerClusters() }),
      hold: () => {},
      release: () => {},
    },
    episodes: { speech: () => {} },
    soniox: { apiKey: "k", model: "stt-rt-v5", asyncModel: "stt-async-v5", languageHints: ["en"] },
    voice: {
      heard: async (_userId: string, u: HeardUtterance) => {
        heard.push(u);
      },
      partial: async () => {},
    },
    terms: async () => [],
    invalidate: () => {},
    asrHealth: (_userId: string, streamId: string, ok: boolean) => {
      expect(streamId).toBe("st1");
      health.push(ok);
    },
    vad: scriptedVad(speech),
    log: (m: string) => logs.push(m),
  } as unknown as LiveDeps;
  const p = new StreamProcessor(
    { id: "st1", userId: "u1", codec: 0, sampleRate: 16000, frameMs: FRAME_MS },
    deps,
  );
  const internals = p as unknown as {
    voiceSource: Required<AudioSource>;
    queue: Promise<void>;
    backlog: { segments: { startAt: number; endAt: number }[] } | null;
    backlogPending: unknown[];
  };
  /**
   * Frames [fromMs, toMs) are processed at T0 + toMs (+ lagMs), having been received then (or at
   * T0 + receivedMs).
   */
  const feed = async (fromMs: number, toMs: number, lagMs = 0, receivedMs?: number) => {
    setSystemTime(new Date(T0 + toMs + lagMs));
    await p.push(frames(fromMs, toMs), receivedMs === undefined ? undefined : T0 + receivedMs);
  };
  const at = (ms: number) => {
    setSystemTime(new Date(T0 + ms));
    return p.tick(T0 + ms);
  };
  return {
    p,
    heard,
    health,
    logs,
    inserted,
    feed,
    at,
    source: internals.voiceSource,
    idle: () => internals.queue,
    backlog: () => internals.backlog?.segments.map((s) => [s.startAt - T0, s.endAt - T0]) ?? [],
    pending: () => internals.backlogPending.length,
    ws: (i = -1) => FakeWs.instances.at(i)!,
  };
}

let restore: () => void;
const realFetch = globalThis.fetch;
beforeEach(() => {
  restore = FakeWs.install();
  // Backlog sent to Soniox async on dispose: refused at once.
  globalThis.fetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
});
afterEach(() => {
  restore();
  globalThis.fetch = realFetch;
  setSystemTime();
});

describe("StreamProcessor: opening a live session", () => {
  test("speech wholly inside one catch-up batch still reaches Soniox, from its start", async () => {
    // "Hey Adri." starts at the end of one batch (not detected yet) and ends within the next,
    // which ends in quiet.
    const t = setup([[1900, 2400]]);
    await t.feed(0, 2000);
    expect(FakeWs.instances).toHaveLength(0);
    await t.feed(2000, 4000);
    expect(FakeWs.instances).toHaveLength(1);
    await settle();
    // Lead-in from 500 ms before the speech started (1400), then the batch.
    expect(t.ws().audioMs).toBe(2600);
    await t.p.dispose();
  });
});

describe("StreamProcessor: Soniox outage", () => {
  test("quick retry; what wasn't transcribed live goes async; the command is cut off", async () => {
    const t = setup([[0, 3000]]);
    await t.feed(0, 1000);
    await settle();
    const first = t.ws();
    first.message({
      tokens: [tok("Hey", 100, 300), tok(" Adri,", 300, 500), tok(" set", 500, 600)],
      final_audio_proc_ms: 600,
    });
    first.drop();
    await t.idle();
    // The words it had come out, cut off: never a whole command.
    expect(t.heard).toEqual([expect.objectContaining({ text: "Hey Adri, set", cutOff: true })]);
    // So is any command the user was in the middle of.
    expect(t.source.cutBefore()).toBe(T0 + 1000);
    expect(t.logs.some((l) => l.includes("retrying in 1 s"))).toBe(true);
    // One drop isn't an outage yet.
    expect(t.health).toEqual([]);

    // Within the retry wait: no session; its speech goes async (and that is an outage).
    await t.feed(1000, 1500);
    expect(FakeWs.instances).toHaveLength(1);
    expect(t.source.cutBefore()).toBe(T0 + 1500);
    expect(t.health).toEqual([false]);
    // Then a new session, without re-sending what went async.
    await t.feed(1500, 2500);
    expect(FakeWs.instances).toHaveLength(2);
    await settle();
    expect(t.ws().audioMs).toBe(1000);
    // The speech ends: its part from the wait joins the failed session's untranscribed tail.
    await t.feed(2500, 4000);
    expect(t.backlog()).toEqual([
      [600, 1000],
      [1000, 1500],
    ]);
    // The stream goes away: it isn't down anymore.
    await t.p.dispose();
    expect(t.health).toEqual([false, true]);
  });

  test("the backoff only starts over after a session lasted; health from the 2nd failure", async () => {
    const t = setup([
      [0, 300],
      [4000, 100_000],
    ]);
    await t.feed(0, 1000);
    await settle();
    t.ws().message({ tokens: [] });
    t.ws().drop(); // in a pause: nothing cut, nothing reported
    await t.feed(1000, 2000);
    expect(t.source.cutBefore()).toBe(0);
    expect(t.health).toEqual([]);
    // Speech again: a new session, which answers and is killed at once.
    await t.feed(2000, 4500);
    expect(FakeWs.instances).toHaveLength(2);
    await settle();
    t.ws().message({ tokens: [] });
    t.ws().drop();
    await t.idle();
    expect(t.logs.some((l) => l.includes("retrying in 2 s"))).toBe(true);
    expect(t.health).toEqual([false]);
    await t.feed(4500, 7000);
    expect(FakeWs.instances).toHaveLength(3);
    await settle();
    t.ws().message({ tokens: [] });
    // It has worked for 30 s: transcription is up again.
    await t.at(37_500);
    expect(t.health).toEqual([false, true]);
    await t.p.dispose();
  });

  test("speech starting during the retry wait goes async from its (padded) onset", async () => {
    const t = setup([
      [0, 300],
      [1700, 3000],
    ]);
    await t.feed(0, 1000);
    await settle();
    t.ws().drop();
    await t.feed(1000, 1800);
    await t.feed(1800, 1960); // speech detected, still waiting to retry
    expect(FakeWs.instances).toHaveLength(1);
    await t.feed(1960, 4000); // a new session takes over; the speech ends
    expect(FakeWs.instances).toHaveLength(2);
    await settle();
    expect(t.ws().audioMs).toBe(2040);
    expect(t.backlog()).toEqual([
      [0, 800], // the failed session's (up to the end of its speech + 0.5 s)
      [1700, 1960], // from the onset, not just from when it was detected
    ]);
    await t.p.dispose();
  });

  test("live and async both down: the live path keeps going, nothing is rescued", async () => {
    let calls = 0;
    // Async refuses (as if down): the first rescued batch fails.
    globalThis.fetch = (async () => {
      calls++;
      return new Response("down", { status: 401 });
    }) as unknown as typeof fetch;
    const t = setup([
      [0, 3000],
      [20_000, 23_000],
    ]);
    await t.feed(0, 1000);
    await settle();
    t.ws().drop();
    await t.feed(1000, 3600);
    await t.at(14_000); // the rescued batch goes to async, which fails
    await settle();
    expect(calls).toBe(1);
    // Live fails again mid-speech: nothing more is rescued while async is down.
    await t.feed(19_000, 21_000);
    await settle();
    t.ws().drop();
    await t.feed(21_000, 24_000);
    expect(t.backlog()).toEqual([]);
    expect(t.logs.some((l) => l.includes("both failing"))).toBe(true);
    await t.p.dispose();
  });

  test("a hung async request never holds up the live pipeline", async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    const t = setup([
      [0, 3000],
      [20_000, 30_000],
    ]);
    await t.feed(0, 1000);
    await settle();
    t.ws().drop();
    await t.feed(1000, 3600);
    await t.at(14_000); // rescued batch in flight, forever
    // More rescued speech: queued behind it, not waited for.
    await t.feed(19_000, 21_000);
    await settle();
    t.ws().drop();
    await t.feed(21_000, 30_000);
    await t.at(41_000);
    expect(t.pending()).toBe(1);
    // Frames keep being processed, sessions keep being opened.
    const done = await Promise.race([
      t.feed(41_000, 42_000).then(() => "processed"),
      Bun.sleep(500).then(() => "blocked"),
    ]);
    expect(done).toBe("processed");
    expect(t.source.heardUntil()).toBe(T0 + 42_000);
  });
});

describe("StreamProcessor: backlog to live", () => {
  test("speech crossing the flip isn't sent to both async and live", async () => {
    const t = setup([[1900, 2400]]);
    // Uploaded 40 s late: backlog.
    await t.feed(0, 2000, 40_000);
    // The next audio arrived promptly (but is processed late): live again between utterances.
    await t.feed(2000, 4000, 38_500, 4500);
    expect(FakeWs.instances).toHaveLength(1);
    await settle();
    // Not the lead-in from 1400: up to 2000 went async.
    expect(t.ws().audioMs).toBe(2000);
    expect(t.backlog()).toEqual([[1900, 2000]]);
    await t.p.dispose();
  });

  test("after a session rotation, no lead-in already sent", async () => {
    const H4 = 4 * 3600_000;
    const t = setup([[0, H4 + 60_000]]);
    await t.feed(0, 1000);
    // Four hours of speech later (only its last bit fed: the session is what's old).
    await t.feed(H4, H4 + 2000);
    await settle();
    expect(FakeWs.instances).toHaveLength(1);
    expect(t.ws(0).sent.at(-1)).toBe("");
    await t.feed(H4 + 2000, H4 + 3000);
    expect(FakeWs.instances).toHaveLength(2);
    await settle();
    expect(t.ws().audioMs).toBe(1000);
    await t.p.dispose();
  });
});

describe("StreamProcessor: stalls", () => {
  test("frames stop mid-speech: not quiet, not finalized, until the cap; then cut off", async () => {
    const t = setup([[0, 20_000]]);
    await t.feed(0, 1000);
    await settle();
    const ws = t.ws();
    await t.at(4500); // the run ends (no frames for 3.5 s)
    await settle();
    expect(ws.controls.some((c) => c.type === "finalize")).toBe(false);
    expect(t.source.stall()).toBe("waiting");
    expect(t.source.heardUntil()).toBe(T0 + 1000);

    await t.at(1000 + STALL_CAP_MS + 500);
    await settle();
    expect(ws.controls.filter((c) => c.type === "finalize")).toHaveLength(1);
    expect(t.source.stall()).toBe("cut");
    expect(t.source.heardUntil()).toBe(Number.POSITIVE_INFINITY);
    // What Soniox finalizes now is cut off.
    ws.message({ tokens: [tok("Set", 100, 300), tok(" a", 300, 400), tok("<fin>", 400, 400)] });
    await t.idle();
    expect(t.heard).toEqual([expect.objectContaining({ text: "Set a", cutOff: true })]);
    await t.p.dispose();
  });

  test("frames resume where they stopped: the recognizer carries on", async () => {
    const t = setup([[0, 20_000]]);
    await t.feed(0, 1000);
    await t.at(4500);
    await t.feed(1000, 2000, 4000); // buffered frames arrive late, contiguous
    await settle();
    expect(t.ws().controls.some((c) => c.type === "finalize")).toBe(false);
    expect(t.source.stall()).toBeNull();
    await t.p.dispose();
  });

  test("frames resume after a gap: what was being said is cut off", async () => {
    const t = setup([[0, 20_000]]);
    await t.feed(0, 1000);
    await t.at(4500);
    await t.feed(5000, 6000);
    await settle();
    expect(t.ws().controls.filter((c) => c.type === "finalize")).toHaveLength(1);
    await t.p.dispose();
  });

  test("speech had ended (mic going to sleep): finalized at once, quiet", async () => {
    const t = setup([[0, 300]]);
    await t.feed(0, 2000);
    await settle();
    await t.at(5500);
    await settle();
    expect(t.ws().controls.filter((c) => c.type === "finalize")).toHaveLength(1);
    expect(t.source.stall()).toBeNull();
    expect(t.source.heardUntil()).toBe(Number.POSITIVE_INFINITY);
    await t.p.dispose();
  });
});

describe("StreamProcessor: storing utterances", () => {
  test("a failed write doesn't keep an utterance from the voice detector", async () => {
    const t = setup([[0, 1500]], { failInsert: true });
    await t.feed(0, 1000);
    await settle();
    t.ws().message({
      tokens: [tok("Hey", 100, 300), tok(" Adri.", 300, 700), tok("<end>", 700, 700)],
    });
    await t.idle();
    expect(t.heard.map((u) => u.text)).toEqual(["Hey Adri."]);
    expect(t.logs.some((l) => l.includes("db down"))).toBe(true);
    await t.p.dispose();
  });
});
