import { describe, expect, test } from "bun:test";
import { SessionClock, SonioxAssembler } from "./asr/soniox-assembler";
import { guessLanguage } from "./lang";
import { PcmHistory } from "./pcm";
import { SoundEventSmoother } from "./sounds";
import { SpeakerClusters } from "./speakers";

describe("guessLanguage", () => {
  test("detects Dutch and English", () => {
    expect(guessLanguage("Ik weet niet of dat echt een goed idee is")).toBe("nl");
    expect(guessLanguage("I don't know if that is really a good idea")).toBe("en");
    expect(guessLanguage("ok")).toBeNull();
  });
});

describe("SoundEventSmoother", () => {
  test("opens on high score, keeps through dips, closes after misses", () => {
    const s = new SoundEventSmoother({ on: 0.5, off: 0.25, closeAfter: 2 });
    const horn = (p: number) => [
      { name: "Vehicle horn, car horn, honking", prob: p },
      { name: "Speech", prob: 0.9 },
    ];
    expect(s.push(horn(0.7), 0, 2000).opened.map((e) => e.label)).toEqual(["vehicle horn"]);
    expect(s.push(horn(0.3), 1000, 3000).closed).toHaveLength(0); // dip above off: still open
    expect(s.push(horn(0.1), 2000, 4000).closed).toHaveLength(0); // first miss
    const { closed } = s.push(horn(0.1), 3000, 5000); // second miss: closes
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      label: "vehicle horn",
      startAt: 0,
      endAt: 3000,
      confidence: 0.7,
    });
  });

  test("ignores speech classes", () => {
    const s = new SoundEventSmoother();
    expect(s.push([{ name: "Speech", prob: 0.99 }], 0, 2000).opened).toHaveLength(0);
  });
});

describe("Soniox assembly", () => {
  test("maps session time to wall clock across gaps and splits on speaker/endpoint", () => {
    const clock = new SessionClock();
    clock.sent(1_000_000, 3000); // first speech burst
    clock.sent(1_060_000, 3000); // a minute later (we didn't stream the silence)
    const a = new SonioxAssembler(clock, "stt-rt-v5");
    const tok = (text: string, s: number, e: number, speaker = "1", language = "en") => ({
      text,
      start_ms: s,
      end_ms: e,
      is_final: true,
      speaker,
      language,
      confidence: 0.9,
    });
    const out = a.push([
      tok("Hello", 100, 400),
      tok(" there", 450, 800),
      tok("Hoi", 900, 1200, "2", "nl"),
      tok("<end>", 1200, 1200, "2"),
      tok("Later", 3100, 3500),
    ]);
    expect(out.map((u) => [u.text, u.speakerKey, u.lang])).toEqual([
      ["Hello there", "soniox:1", "en"],
      ["Hoi", "soniox:2", "nl"],
    ]);
    expect(out[0]!.startAt).toBe(1_000_100);
    const last = a.flush()!;
    expect(last.text).toBe("Later");
    expect(last.startAt).toBe(1_060_100);
  });
});

describe("PcmHistory", () => {
  test("stays bounded during uninterrupted audio and slices across chunks", () => {
    const h = new PcmHistory(10_000);
    const t0 = 1_760_000_000_000;
    // One hour of contiguous 1 s chunks whose sample values encode their second.
    for (let s = 0; s < 3600; s++) h.push(t0 + s * 1000, new Float32Array(16_000).fill(s));
    expect(h.size).toBeLessThanOrEqual(12 * 16_000);
    const cut = h.slice(t0 + 3598_500, t0 + 3599_500)!;
    expect(cut.length).toBe(16_000);
    expect(cut[0]).toBe(3598);
    expect(cut[cut.length - 1]).toBe(3599);
    expect(h.slice(t0, t0 + 1000)).toBeNull();
  });
});

describe("SessionClock.covers", () => {
  test("only spans that were actually streamed", () => {
    const c = new SessionClock();
    c.sent(10_000, 2_000);
    c.sent(12_000, 1_000); // contiguous
    c.sent(60_000, 1_000); // after a gap
    expect(c.covers(10_500, 12_900)).toBe(true);
    expect(c.covers(12_500, 14_000)).toBe(false);
    expect(c.covers(60_000, 61_000)).toBe(true);
    expect(c.covers(30_000, 31_000)).toBe(false);
  });
});

describe("SpeakerClusters.alias", () => {
  test("engine labels from different sessions get distinct keys", () => {
    const c = new SpeakerClusters();
    expect(c.alias("soniox:aaaa:1")).toBe("S1");
    expect(c.alias("soniox:bbbb:1")).toBe("S2");
    expect(c.alias("soniox:aaaa:1")).toBe("S1");
  });
});
