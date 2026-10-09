import { describe, expect, test } from "bun:test";
import {
  CommandAssembler,
  commandLang,
  DEFAULT_LIMITS,
  type HeardUtterance,
  longestWaitMs,
} from "./assembler";

const cfg = { names: ["Hermes"], aliases: [] };
const T = 1_800_000_000_000;

function utt(text: string, startS: number, endS: number, over: Partial<HeardUtterance> = {}) {
  return {
    streamId: "s1",
    text,
    startAt: T + startS * 1000,
    endAt: T + endS * 1000,
    lang: "en",
    speakerKey: "S1",
    isSelf: true,
    chainId: "c1",
    ...over,
  } satisfies HeardUtterance;
}
/** Wall clock: the final arrives ~1.5 s after the utterance ends. */
const at = (s: number) => T + s * 1000;
/** No speech after this audio time. */
const quiet = (s: number) => T + s * 1000;
/** Audio heard up to this time. */
const heard = (s: number) => T + s * 1000;

describe("CommandAssembler", () => {
  test("single utterance completes at once when the user stops talking", () => {
    const a = new CommandAssembler();
    const step = a.push(utt("Hey Hermes, call mom.", 0, 2), cfg, quiet(2), at(3.5));
    expect(step.done).toHaveLength(1);
    expect(step.done[0]).toMatchObject({
      command: "call mom.",
      transcript: "Hey Hermes, call mom.",
      spokenAt: T,
      endedAt: T + 2000,
    });
    expect(a.busy).toBe(false);
  });

  test("non-wake speech is ignored", () => {
    const a = new CommandAssembler();
    const step = a.push(utt("I asked Hermes yesterday.", 0, 2), cfg, quiet(2), at(3.5));
    expect(step).toEqual({ done: [], abandoned: [], woke: null });
    expect(a.busy).toBe(false);
  });

  test("wake word, then the command in the next utterance", () => {
    const a = new CommandAssembler();
    expect(
      a.push(utt("Hey Hermes.", 0, 0.8, { isSelf: null }), cfg, quiet(0.8), at(2)).done,
    ).toEqual([]);
    expect(a.busy).toBe(true);
    const step = a.push(utt("What's the weather tomorrow?", 2.5, 4.5), cfg, quiet(4.5), at(6));
    expect(step.done[0]).toMatchObject({
      command: "What's the weather tomorrow?",
      transcript: "Hey Hermes. What's the weather tomorrow?",
      spokenAt: T,
    });
  });

  test("wake word alone times out as no_command", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2), heard(2));
    expect(a.tick(quiet(0.8), at(5), heard(5)).abandoned).toEqual([]);
    expect(a.tick(quiet(0.8), at(8.5), heard(8.5)).abandoned).toEqual([]);
    // 8 s of audio after the wake phrase without speech.
    const step = a.tick(quiet(0.8), at(9), heard(9));
    expect(step.abandoned).toHaveLength(1);
    expect(step.abandoned[0]!.reason).toBe("no_command");
  });

  test("continuation while the user is still talking", () => {
    const a = new CommandAssembler();
    // Speech at 3.5 s, after the first part's end: a continuation is coming.
    let step = a.push(utt("Hey Hermes, remind me to", 0, 2), cfg, quiet(3.5), at(3.5));
    expect(step.done).toHaveLength(0);
    expect(a.tick(quiet(3.5), at(4)).done).toHaveLength(0);
    step = a.push(utt("call mom at six.", 2.8, 4), cfg, quiet(4), at(5.5));
    expect(step.done[0]!.command).toBe("remind me to call mom at six.");
    expect(step.done[0]!.parts).toHaveLength(2);
  });

  test("gives up waiting for a continuation", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, remind me to", 0, 2), cfg, quiet(3.5), at(3.5));
    expect(a.tick(quiet(3.5), at(7.6)).done[0]!.command).toBe("remind me to");
  });

  test("a different speaker ends the command and is not appended", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, turn on", 0, 2), cfg, quiet(3), at(3.5));
    const step = a.push(
      utt("the lights are on already", 2.5, 4, { speakerKey: "S2", isSelf: false }),
      cfg,
      quiet(4),
      at(5.5),
    );
    expect(step.done[0]!.command).toBe("turn on");
  });

  test("caps the number of parts", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, one", 0, 1), cfg, quiet(9), at(2));
    a.push(utt("two", 1.5, 2), cfg, quiet(9), at(3));
    const step = a.push(utt("three", 2.5, 3), cfg, quiet(9), at(4));
    expect(step.done[0]!.command).toBe("one two three");
  });

  test("a new wake phrase while pending starts a new command", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, first", 0, 1), cfg, quiet(2), at(2));
    const step = a.push(utt("Hey Hermes, second", 1.5, 2.5), cfg, quiet(2.5), at(4));
    expect(step.done.map((c) => c.command)).toEqual(["first", "second"]);
  });
});

describe("CommandAssembler: quiet after a command", () => {
  test("a short pause is a continuation; quiet completes it", () => {
    const a = new CommandAssembler();
    // Recognized 1.5 s after it ended: not yet 2.2 s of quiet.
    const first = a.push(utt("Hey Hermes, call mom", 0, 2), cfg, quiet(2), at(3.5), heard(3.5));
    expect(first.done).toEqual([]);
    const second = a.push(utt("at five.", 3.5, 4.3), cfg, quiet(4.3), at(5.8), heard(5.8));
    expect(second.done).toEqual([]);
    expect(a.tick(quiet(4.3), at(6.4), heard(6.4)).done).toEqual([]);
    const done = a.tick(quiet(4.3), at(6.5), heard(6.5));
    expect(done.done[0]!.command).toBe("call mom at five.");
  });

  test("a 1.6 s pause mid-command doesn't cut it (it took 1.2 s before)", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, remind me to", 0, 2), cfg, quiet(2), at(3.4), heard(3.4));
    // 1.6 s of quiet so far: not done.
    expect(a.tick(quiet(2), at(3.6), heard(3.6)).done).toEqual([]);
    // Talking again.
    expect(a.tick(quiet(4.5), at(4.5), heard(4.5)).done).toEqual([]);
    const step = a.push(utt("call mom at six.", 3.6, 5.2), cfg, quiet(5.2), at(6.7), heard(6.7));
    expect(a.tick(quiet(5.2), at(7.4), heard(7.4)).done[0]!.command).toBe(
      "remind me to call mom at six.",
    );
    expect(step.done).toEqual([]);
  });

  test("waits for a long continuation while the user is still talking", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, remind me", 0, 2), cfg, quiet(2), at(3.4), heard(3.4));
    // Talking again from 3.6 s to 9 s: well past `waitMs` after the first part arrived.
    for (const s of [4, 5, 6, 7, 8, 9]) expect(a.tick(quiet(s), at(s), heard(s)).done).toEqual([]);
    expect(a.tick(quiet(9), at(10.5), heard(10.5)).done).toEqual([]);
    const step = a.push(
      utt("to call mom at six and buy milk on the way.", 3.6, 9),
      cfg,
      quiet(9),
      at(11.5),
      heard(11.5),
    );
    expect(step.done[0]!.command).toBe("remind me to call mom at six and buy milk on the way.");
  });

  test("speech (anyone's, or music) holds a finished command only so long", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, lights on.", 0, 2), cfg, quiet(2), at(3.5), heard(3.5));
    // Voice activity never stops.
    for (const s of [5, 8, 12, 17.4]) expect(a.tick(quiet(s), at(s), heard(s)).done).toEqual([]);
    // `waitMs` + `talkMs` after the part arrived.
    expect(a.tick(quiet(17.5), at(17.5), heard(17.5)).done[0]!.command).toBe("lights on.");
    expect(longestWaitMs(DEFAULT_LIMITS)).toBe(46_000);
  });

  test("speech that went on after a finished command is logged, not dropped silently", () => {
    const logs: string[] = [];
    const a = new CommandAssembler(DEFAULT_LIMITS, (m) => logs.push(m));
    a.push(utt("Hey Hermes, call mom", 0, 2), cfg, quiet(2), at(3.5), heard(4.3));
    expect(a.busy).toBe(false);
    const step = a.push(utt("at five.", 4.4, 5), cfg, quiet(5), at(6.5), heard(6.5));
    expect(step).toEqual({ done: [], abandoned: [], woke: null });
    expect(logs).toEqual([
      "voice: speech 2400 ms after a finished command (8 chars) wasn't part of it",
    ]);
    // Not by someone else, nor much later.
    a.push(utt("Hey Hermes, call mom", 10, 12), cfg, quiet(12), at(13.5), heard(14.3));
    a.push(utt("Okay.", 12.5, 13, { speakerKey: "S2", isSelf: false }), cfg, quiet(13), at(14.5));
    a.push(utt("At five.", 15, 16), cfg, quiet(16), at(17.5));
    expect(logs).toHaveLength(1);
  });
});

describe("CommandAssembler: the command after a bare wake phrase", () => {
  test("a long command counts from when it started, not when its transcript arrived", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2), heard(2));
    // Starts 7.5 s after the wake phrase, talks until 15.3 s.
    for (const s of [8, 9, 10, 12, 14, 15])
      expect(a.tick(quiet(s), at(s), heard(s)).abandoned).toEqual([]);
    // Recognized 2.7 s after it ended.
    expect(a.tick(quiet(15.3), at(17), heard(17)).abandoned).toEqual([]);
    const step = a.push(
      utt("Remind me to call the plumber about the leak under the sink tomorrow.", 8.3, 15.3),
      cfg,
      quiet(15.3),
      at(18),
      heard(18),
    );
    expect(step.abandoned).toEqual([]);
    expect(step.done[0]).toMatchObject({
      command: "Remind me to call the plumber about the leak under the sink tomorrow.",
      spokenAt: T,
    });
  });

  test("speech that starts after the window isn't the command", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2), heard(2));
    // Talking from 9 s: still waiting, it may have started in time.
    expect(a.tick(quiet(9.5), at(9.5), heard(9.5)).abandoned).toEqual([]);
    const step = a.push(utt("Anyway, where was I?", 9, 10.5), cfg, quiet(10.5), at(12), heard(12));
    expect(step.abandoned).toHaveLength(1);
    expect(step.done).toEqual([]);
    expect(a.busy).toBe(false);
  });

  test("speech after the wake phrase whose transcript never came", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2), heard(2));
    // Speech until 5 s: its transcript could still arrive until 4 s of audio later.
    expect(a.tick(quiet(5), at(8.9), heard(8.9)).abandoned).toEqual([]);
    expect(a.tick(quiet(5), at(9.1), heard(9.1)).abandoned).toHaveLength(1);
  });

  test("the stream ended: nothing more is coming", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2), heard(2));
    expect(a.tick(0, at(3)).abandoned).toHaveLength(1);
  });

  test("speech (anyone's, or music) holds a bare wake phrase only so long", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2), heard(2));
    for (const s of [5, 10, 15, 19.9])
      expect(a.tick(quiet(s), at(s), heard(s)).abandoned).toEqual([]);
    // `armMs` + `talkMs` after it arrived.
    expect(a.tick(quiet(20), at(20), heard(20)).abandoned).toHaveLength(1);
  });

  test("audio stalled (heard stays put): gives up by the clock", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2), heard(2));
    expect(a.tick(quiet(4), at(15), heard(4)).abandoned).toEqual([]);
    expect(a.tick(quiet(4), at(20), heard(4)).abandoned).toHaveLength(1);
  });

  test("other speakers are skipped; the same label or the user's voice is the command", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8, { isSelf: null }), cfg, quiet(0.8), at(2), heard(2));
    // Known to be someone else, or another label with no voice of its own (a guest's "What?").
    for (const over of [
      { speakerKey: "S2", isSelf: false },
      { speakerKey: "S2", isSelf: null },
      { speakerKey: "S1", isSelf: false },
    ]) {
      expect(a.push(utt("What?", 1.2, 1.6, over), cfg, quiet(1.6), at(3), heard(3))).toEqual({
        done: [],
        abandoned: [],
        woke: null,
      });
      expect(a.busy).toBe(true);
    }
    const step = a.push(
      utt("Call mom.", 3, 3.8, { isSelf: null }),
      cfg,
      quiet(3.8),
      at(6),
      heard(6),
    );
    expect(step.done[0]).toMatchObject({
      command: "Call mom.",
      transcript: "Hey Hermes. Call mom.",
    });
    expect(step.done[0]!.parts.map((p) => p.text)).toEqual(["Hey Hermes.", "Call mom."]);
  });

  test("another label is the command once its own voice is the user's (needsVoiceCheck)", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8, { isSelf: null }), cfg, quiet(0.8), at(2), heard(2));
    const u = utt("Call mom.", 3, 3.8, { speakerKey: "S3", isSelf: null });
    expect(a.needsVoiceCheck(u, cfg)).toBe(true);
    // Not for: the same label, a known voice, a new wake phrase, too late.
    expect(a.needsVoiceCheck({ ...u, speakerKey: "S1" }, cfg)).toBe(false);
    expect(a.needsVoiceCheck({ ...u, isSelf: false }, cfg)).toBe(false);
    expect(a.needsVoiceCheck({ ...u, text: "Hey Hermes, call mom." }, cfg)).toBe(false);
    expect(a.needsVoiceCheck({ ...u, startAt: at(9) }, cfg)).toBe(false);
    expect(new CommandAssembler().needsVoiceCheck(u, cfg)).toBe(false);
    // The detector found it's the user's voice.
    const step = a.push({ ...u, isSelf: true }, cfg, quiet(3.8), at(6), heard(6));
    expect(step.done[0]!.command).toBe("Call mom.");
  });

  test("an unknown speaker on another stream isn't the command", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8, { isSelf: null }), cfg, quiet(0.8), at(2), heard(2));
    const step = a.push(
      utt("Call mom.", 2, 3, { streamId: "s2", speakerKey: "S7", isSelf: null }),
      cfg,
      quiet(3),
      at(4.5),
      heard(4.5),
    );
    expect(step).toEqual({ done: [], abandoned: [], woke: null });
    expect(a.busy).toBe(true);
  });

  test("the user's own voice on another stream is the command", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8, { isSelf: null }), cfg, quiet(0.8), at(2), heard(2));
    const step = a.push(
      utt("Call mom.", 2, 3, { streamId: "s2", speakerKey: "S7", isSelf: true }),
      cfg,
      quiet(3),
      at(5.5),
      heard(5.5),
    );
    expect(step.done[0]!.command).toBe("Call mom.");
  });

  test("a new wake phrase replaces the bare one", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2), heard(2));
    const step = a.push(utt("Hey Hermes, call mom.", 2, 3.5), cfg, quiet(3.5), at(6), heard(6));
    expect(step.abandoned).toHaveLength(1);
    expect(step.done[0]!.command).toBe("call mom.");
  });
});

describe("CommandAssembler: greeting and name split in two", () => {
  test('"Hey" | "Hermes, call mom." is one wake phrase', () => {
    const a = new CommandAssembler();
    const hey = a.push(utt("Hey", 0, 0.3, { isSelf: null }), cfg, quiet(0.3), at(1.8), heard(1.8));
    expect(hey).toEqual({ done: [], abandoned: [], woke: null, heldGreeting: true });
    const step = a.push(
      utt("Hermes, call mom.", 0.35, 1.6, { speakerKey: "S2" }),
      cfg,
      quiet(1.6),
      at(4),
      heard(4),
    );
    expect(step.woke?.utterance.text).toBe("Hey Hermes, call mom.");
    expect(step.done[0]).toMatchObject({
      command: "call mom.",
      transcript: "Hey Hermes, call mom.",
      spokenAt: T,
      endedAt: T + 1600,
    });
    expect(step.done[0]!.parts).toHaveLength(1);
    expect(step.done[0]!.parts[0]).toBe(step.woke!.utterance);
  });

  test('"Um, hey" | "Hermes." then the command', () => {
    const a = new CommandAssembler();
    a.push(utt("Um, hey", 0, 1), cfg, quiet(1), at(2.5), heard(2.5));
    const wake = a.push(
      utt("Hermes.", 1.3, 1.6, { speakerKey: "S2", isSelf: null }),
      cfg,
      quiet(1.6),
      at(3),
      heard(3),
    );
    expect(wake.woke?.wake.command).toBe("");
    expect(a.busy).toBe(true);
    const step = a.push(
      utt("Call mom.", 3, 4, { speakerKey: "S2" }),
      cfg,
      quiet(4),
      at(6.5),
      heard(6.5),
    );
    expect(step.done[0]!.command).toBe("Call mom.");
  });

  test("not joined: someone else's greeting, a close name, more than a greeting", () => {
    const a = new CommandAssembler();
    // A friend's "Hi!", then the user introducing them.
    expect(
      a.push(utt("Hi!", 0, 0.3, { speakerKey: "S2", isSelf: false }), cfg, quiet(0.3), at(1.8))
        .heldGreeting,
    ).toBeUndefined();
    expect(
      a.push(utt("Hermes, this is my friend Tom.", 0.4, 2), cfg, quiet(2), at(3.5)).woke,
    ).toBeNull();
    // Not exactly the name.
    a.push(utt("Hey", 10, 10.3), cfg, quiet(10.3), at(11.8));
    expect(a.push(utt("Hermis, call mom.", 10.4, 12), cfg, quiet(12), at(13.5)).woke).toBeNull();
    // More than a greeting.
    a.push(utt("I'm off. Hey", 20, 21), cfg, quiet(21), at(22.5));
    expect(a.push(utt("Hermes, call mom.", 21.1, 23), cfg, quiet(23), at(24.5)).woke).toBeNull();
    // The second line known to be someone else's.
    a.push(utt("Hey", 30, 30.3), cfg, quiet(30.3), at(31.8));
    expect(
      a.push(utt("Hermes, call mom.", 30.4, 32, { isSelf: false }), cfg, quiet(32), at(33.5)).woke,
    ).toBeNull();
  });

  test("not joined: too far apart, another stream, or a name without the greeting", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey", 0, 0.3), cfg, quiet(0.3), at(1.8));
    // More than 0.5 s apart.
    expect(a.push(utt("Hermes, call mom.", 0.9, 3), cfg, quiet(3), at(4.5)).woke).toBeNull();
    a.push(utt("Hey", 10, 10.3), cfg, quiet(10.3), at(11.8));
    expect(
      a.push(utt("Hermes, call mom.", 10.4, 12, { streamId: "s2" }), cfg, quiet(12), at(13.5)).woke,
    ).toBeNull();
    a.push(utt("I said hey", 20, 21), cfg, quiet(21), at(22.5));
    expect(a.push(utt("Hermes, call mom.", 21.1, 23), cfg, quiet(23), at(24.5)).woke).toBeNull();
    // Only the utterance right before.
    a.push(utt("Hey", 30, 30.3), cfg, quiet(30.3), at(31.8));
    a.push(utt("you", 30.4, 30.6), cfg, quiet(30.6), at(32));
    expect(a.push(utt("Hermes, call mom.", 30.7, 32), cfg, quiet(32), at(33.5)).woke).toBeNull();
  });
});

describe("command language", () => {
  const spans = (...s: [number, number, string][]) =>
    s.map(([start, end, lang]) => ({ start, end, lang }));

  test("the command's own words, not the greeting and name", () => {
    const a = new CommandAssembler();
    const text = "Hey Hermes, call mom.";
    const step = a.push(
      utt(text, 0, 2, { lang: "nl", langSpans: spans([0, 11, "nl"], [11, text.length, "en"]) }),
      cfg,
      quiet(2),
      at(4.5),
    );
    expect(step.done[0]!.lang).toBe("en");
  });

  test("after a bare wake phrase: the command utterance's language", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8, { lang: "en" }), cfg, quiet(0.8), at(2), heard(2));
    const step = a.push(utt("Bel mama.", 2, 3, { lang: "nl" }), cfg, quiet(3), at(5.5));
    expect(step.done[0]!.lang).toBe("nl");
  });

  test("across parts, by characters", () => {
    expect(
      commandLang(
        [
          utt("Hey Hermes, zet", 0, 1, { langSpans: spans([0, 11, "en"], [11, 15, "nl"]) }),
          utt("de lampen in de keuken uit", 1, 2, { langSpans: spans([0, 26, "nl"]) }),
        ],
        12,
      ),
    ).toBe("nl");
    // Without word languages: the utterance's.
    expect(commandLang([utt("Hey Hermes, call mom", 0, 1, { lang: "en" })], 12)).toBe("en");
  });

  test("joined greeting: spans shift with the text", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey", 0, 0.3, { lang: "nl", langSpans: spans([0, 3, "nl"]) }), cfg, 0, at(1.8));
    const step = a.push(
      utt("Hermes, call mom.", 0.35, 1.6, {
        lang: "nl",
        langSpans: spans([0, 8, "nl"], [8, 17, "en"]),
      }),
      cfg,
      quiet(1.6),
      at(4),
      heard(4),
    );
    expect(step.done[0]!.parts[0]!.langSpans).toEqual(
      spans([0, 3, "nl"], [4, 12, "nl"], [12, 21, "en"]),
    );
    expect(step.done[0]!.lang).toBe("en");
  });
});
