import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { FakeWs, settle } from "./fake-ws";
import { KEEPALIVE_IDLE_MS, SonioxSession } from "./soniox";
import type { Utterance } from "./types";

const T0 = 1_800_000_000_000;
const tok = (text: string, s: number, e: number, is_final = true) => ({
  text,
  start_ms: s,
  end_ms: e,
  is_final,
  speaker: "1",
});

let restore: () => void;
beforeEach(() => {
  restore = FakeWs.install();
});
afterEach(() => {
  restore();
  setSystemTime();
});

async function open() {
  const utterances: Utterance[] = [];
  const errors: string[] = [];
  let responses = 0;
  const session = new SonioxSession(
    { apiKey: "k", model: "stt-rt-v5", languageHints: ["en"] },
    (u) => utterances.push(u),
    (m) => errors.push(m),
    undefined,
    () => responses++,
  );
  await settle();
  const ws = FakeWs.instances.at(-1)!;
  return { session, ws, utterances, errors, responses: () => responses };
}

describe("SonioxSession", () => {
  test("a dropped connection: final words come out cut off, the rest is reported untranscribed", async () => {
    const s = await open();
    s.session.send(new Int16Array(16 * 3000), T0); // 3 s
    await settle();
    s.ws.message({
      tokens: [
        tok("Hey", 100, 300),
        tok(" Adri,", 300, 600),
        tok(" set", 700, 900),
        tok(" a", 900, 1000),
      ],
      final_audio_proc_ms: 1000,
      total_audio_proc_ms: 2500,
    });
    expect(s.responses()).toBe(1);
    expect(s.session.responded).toBe(true);
    s.ws.drop();
    expect(s.utterances).toEqual([
      expect.objectContaining({ text: "Hey Adri, set a", cutOff: true }),
    ]);
    expect(s.errors).toEqual(["soniox connection closed unexpectedly"]);
    expect(s.session.failed).toBe(true);
    expect(s.session.untranscribed()).toEqual([{ from: T0 + 1000, to: T0 + 3000 }]);
  });

  test("an error message: same", async () => {
    const s = await open();
    s.session.send(new Int16Array(16 * 2000), T0);
    await settle();
    s.ws.message({ tokens: [tok("Hey", 100, 300)], final_audio_proc_ms: 300 });
    s.ws.message({ error_code: 503, error_message: "overloaded" });
    await settle();
    expect(s.utterances.map((u) => [u.text, u.cutOff])).toEqual([["Hey", true]]);
    expect(s.errors).toEqual(["soniox 503: overloaded"]);
  });

  test("never connected: everything sent is untranscribed", async () => {
    const s = await open();
    s.session.send(new Int16Array(16 * 1000), T0);
    s.ws.drop();
    expect(s.session.untranscribed()).toEqual([{ from: T0, to: T0 + 1000 }]);
    expect(s.responses()).toBe(0);
  });

  test("a normal close: the last utterance is whole", async () => {
    const s = await open();
    s.session.send(new Int16Array(16 * 1000), T0);
    await settle();
    s.ws.message({ tokens: [tok("Hello", 100, 400)], final_audio_proc_ms: 400 });
    await s.session.close();
    expect(s.session.finished).toBe(true);
    expect(s.utterances.map((u) => [u.text, u.cutOff])).toEqual([["Hello", undefined]]);
    expect(s.errors).toEqual([]);
  });

  test("finalize(cutOff): the utterance it ends is cut off", async () => {
    const s = await open();
    s.session.send(new Int16Array(16 * 2000), T0);
    s.session.finalize(true);
    await settle();
    expect(s.ws.controls.at(-1)).toEqual({ type: "finalize" });
    s.ws.message({
      tokens: [tok("Hey", 100, 300), tok(" Adri,", 300, 600), tok("<fin>", 600, 600)],
    });
    expect(s.utterances.map((u) => [u.text, u.cutOff])).toEqual([["Hey Adri,", true]]);
    // Later ones aren't.
    s.session.finalize();
    await settle();
    s.ws.message({ tokens: [tok(" yes", 900, 1100), tok("<fin>", 1100, 1100)] });
    expect(s.utterances.at(-1)).toMatchObject({ text: "yes" });
    expect(s.utterances.at(-1)!.cutOff).toBeUndefined();
    await s.session.close();
  });

  test("keepalive well inside Soniox's 20 s idle limit", async () => {
    const s = await open();
    expect(s.ws.controls.filter((c) => c.type === "keepalive")).toHaveLength(0);
    setSystemTime(new Date(Date.now() + KEEPALIVE_IDLE_MS + 100));
    await Bun.sleep(1100);
    expect(s.ws.controls.filter((c) => c.type === "keepalive")).toHaveLength(1);
    await s.session.close();
  });
});
