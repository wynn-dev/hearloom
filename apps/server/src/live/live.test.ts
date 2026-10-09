import { describe, expect, test } from "bun:test";
import { SessionClock, SonioxAssembler } from "./asr/soniox-assembler";
import { wav } from "./asr/soniox-async";
import { PcmHistory } from "./pcm";
import { SoundEventSmoother } from "./sounds";
import { SpeakerClusters } from "./speakers";

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
    // Classes the tagger gives to plain talking.
    for (const name of ["Mantra", "Chant", "Beatboxing"]) {
      expect(s.push([{ name, prob: 0.7 }], 0, 2000).opened).toHaveLength(0);
    }
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

  test("the utterance in progress: its final tokens plus the current guesses", () => {
    const clock = new SessionClock();
    clock.sent(1_000_000, 2000);
    const a = new SonioxAssembler(clock, "stt-rt-v5");
    const tok = (text: string, s: number, e: number, is_final: boolean, speaker = "1") => ({
      text,
      start_ms: s,
      end_ms: e,
      is_final,
      speaker,
    });
    const first = [
      tok("Hey", 100, 300, true),
      tok(" A", 400, 500, false),
      tok("dri", 500, 700, false),
    ];
    expect(a.push(first)).toEqual([]);
    expect(a.partial(first)).toEqual({
      text: "Hey Adri",
      startAt: 1_000_100,
      ends: [
        { offset: 3, endAt: 1_000_300 },
        { offset: 5, endAt: 1_000_500 },
        { offset: 8, endAt: 1_000_700 },
      ],
      audioAt: 1_002_000,
      speakerKey: "soniox:1",
    });
    // The guesses are replaced by the next response's; a new speaker starts a new utterance.
    const next = [
      tok(" Adri", 400, 700, true),
      tok(",", 700, 700, false),
      tok("Yes", 900, 1100, false, "2"),
    ];
    a.push(next);
    expect(a.partial(next)).toMatchObject({
      text: "Yes",
      startAt: 1_000_900,
      speakerKey: "soniox:2",
    });
    // Nothing in progress after an endpoint.
    const end = [tok(",", 700, 700, true), tok("<end>", 700, 700, true)];
    expect(a.push(end).map((u) => u.text)).toEqual(["Hey Adri,"]);
    expect(a.partial(end)).toBeNull();
  });

  describe("punctuation", () => {
    const tok = (text: string, s: number, e: number, speaker = "1") => ({
      text,
      start_ms: s,
      end_ms: e,
      is_final: true,
      speaker,
    });

    test("closes the words before it and never forms a line of its own", () => {
      const clock = new SessionClock();
      clock.sent(0, 10_000);
      const a = new SonioxAssembler(clock, "stt-rt-v5");
      const out = a.push([
        tok("Yes", 100, 400),
        tok(".", 2500, 2600, "2"), // late, other speaker: still ends "Yes"
        tok("<end>", 2600, 2600),
        tok(".", 2700, 2800), // after the endpoint: dropped
        tok("So", 3000, 3200),
        tok("<end>", 3200, 3200),
        tok("…", 4000, 4100),
        tok("<end>", 4100, 4100),
      ]);
      expect(out.map((u) => [u.text, u.speakerKey, u.endAt])).toEqual([
        ["Yes.", "soniox:1", 400],
        ["So", "soniox:1", 3200],
      ]);
      expect(a.flush()).toBeNull();
    });

    test("doesn't hide a speaker change or a pause after it", () => {
      const clock = new SessionClock();
      clock.sent(0, 30_000);
      const a = new SonioxAssembler(clock, "stt-rt-v5");
      const out = a.push([
        tok("Yes", 100, 400),
        tok(".", 2500, 2600, "2"),
        tok(" So", 2700, 2900, "2"), // the other speaker, no endpoint in between
        tok(" what", 2900, 3100, "2"),
        tok("?", 3100, 3200, "2"),
        tok(" Later", 20_000, 20_300, "2"), // long pause
      ]);
      const last = a.flush()!;
      expect([...out, last].map((u) => [u.text, u.speakerKey, u.startAt, u.endAt])).toEqual([
        ["Yes.", "soniox:1", 100, 400],
        ["So what?", "soniox:2", 2700, 3100],
        ["Later", "soniox:2", 20_000, 20_300],
      ]);
    });

    test("doesn't bridge stitched backlog segments", () => {
      const clock = new SessionClock();
      clock.sent(1_000_000, 2000);
      clock.sent(1_010_000, 2000); // 10 s later
      const a = new SonioxAssembler(clock, "stt-async-v5");
      const out = a.push([tok("Hello", 100, 900), tok(".", 2100, 2200), tok(" Next", 2300, 2900)]);
      const last = a.flush()!;
      expect([...out, last].map((u) => [u.text, u.startAt, u.endAt])).toEqual([
        ["Hello.", 1_000_100, 1_000_900],
        ["Next", 1_010_300, 1_010_900],
      ]);
    });

    test("symbols that can open text are kept", () => {
      const clock = new SessionClock();
      clock.sent(0, 10_000);
      const line = (...texts: string[]) => {
        const a = new SonioxAssembler(clock, "stt-rt-v5");
        a.push(texts.map((t, i) => tok(t, 100 + i * 100, 200 + i * 100)));
        return a.flush()!.text;
      };
      expect(line("€", "5")).toBe("€5");
      expect(line("-", "5", " graden")).toBe("-5 graden");
      expect(line(" '", "t", " is")).toBe("'t is");
      expect(line("Yes", ' "', "Hello", '"')).toBe('Yes "Hello"');
      expect(line("Yes", " —", " so")).toBe("Yes — so");
    });
  });

  test("silence cut out of stitched backlog audio still splits utterances", () => {
    // Two speech segments a minute apart, sent back to back with 300 ms of silence between them.
    const clock = new SessionClock();
    clock.sent(1_000_000, 2000);
    clock.sent(1_002_000, 300);
    clock.sent(1_060_000, 2000);
    const a = new SonioxAssembler(clock, "stt-async-v5");
    const tok = (text: string, s: number, e: number) => ({
      text,
      start_ms: s,
      end_ms: e,
      is_final: true,
      speaker: "1",
    });
    const out = a.push([tok("Before", 1200, 1900), tok(" after", 2400, 2800)]);
    expect(out.map((u) => u.text)).toEqual(["Before"]);
    expect(a.flush()!.startAt).toBe(1_060_100);
  });
});

describe("Soniox assembly of async results", () => {
  const tok = (text: string, s: number, e: number) => ({
    text,
    start_ms: s,
    end_ms: e,
    is_final: true,
    speaker: "1",
  });

  test("splits where stitched segments meet, even after a short real pause", () => {
    // Two VAD segments 0.8 s apart (under the 1.5 s pause rule), stitched with 300 ms of silence.
    const clock = new SessionClock();
    clock.sent(1_000_000, 2000);
    clock.sent(1_002_000, 300);
    clock.sent(1_002_800, 2000);
    const a = new SonioxAssembler(clock, "stt-async-v5");
    const out = a.push([tok("One", 100, 1900), tok(" two", 2400, 2900)]);
    expect(out.map((u) => u.text)).toEqual(["One"]);
    expect(a.flush()!.startAt).toBe(1_002_900);
  });

  test("caps long utterances at a word boundary", () => {
    const clock = new SessionClock();
    clock.sent(0, 60_000);
    const a = new SonioxAssembler(clock, "stt-async-v5", 1500, "soniox:", 10_000);
    const words = Array.from({ length: 30 }, (_, i) =>
      tok(i ? " w" : "w", i * 1000, i * 1000 + 800),
    );
    // A sub-word token (no leading space) never starts a new utterance.
    words.splice(11, 0, tok("x", 10_850, 10_950));
    const out = a.push(words);
    const last = a.flush()!;
    expect([...out, last].map((u) => u.endAt - u.startAt <= 11_000)).toEqual([true, true, true]);
    expect(out[0]!.text.endsWith("wx")).toBe(true);
  });
});

describe("wav", () => {
  test("16 kHz mono PCM16 header", () => {
    const f = wav(new Int16Array([1, -1, 300]));
    const v = new DataView(f.buffer);
    expect(new TextDecoder().decode(f.subarray(0, 4))).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(44 + 4, true)).toBe(300);
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

describe("SpeakerClusters.alias", () => {
  test("engine labels from different sessions get distinct keys", () => {
    const c = new SpeakerClusters();
    expect(c.alias("soniox:aaaa:1")).toBe("S1");
    expect(c.alias("soniox:bbbb:1")).toBe("S2");
    expect(c.alias("soniox:aaaa:1")).toBe("S1");
  });
});
