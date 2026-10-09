import { describe, expect, test } from "bun:test";
import { SessionClock, SonioxAssembler } from "./soniox-assembler";

const tok = (text: string, s: number, e: number, speaker = "1", is_final = true) => ({
  text,
  start_ms: s,
  end_ms: e,
  is_final,
  speaker,
});

describe("SonioxAssembler: speaker changes", () => {
  test("a speaker change inside a word doesn't split it (real: 'surpr' S1, 'ise' S3)", () => {
    const clock = new SessionClock();
    clock.sent(0, 10_000);
    const a = new SonioxAssembler(clock, "stt-rt-v5");
    const out = a.push([
      tok("This", 100, 300),
      tok(" does", 300, 500),
      tok(" not", 500, 700),
      tok(" surpr", 700, 1000),
      tok("ise", 1000, 1200, "3"),
      tok(" me", 1300, 1400, "3"),
      tok(" too", 1400, 1600, "3"),
      tok(" much", 1600, 1800, "3"),
    ]);
    const last = a.flush()!;
    // The word stays whole with its speaker; the change counts at the next word boundary.
    expect([...out, last].map((u) => [u.text, u.speakerKey])).toEqual([
      ["This does not surprise", "soniox:1"],
      ["me too much", "soniox:3"],
    ]);
  });

  test("a change at a word boundary or after punctuation splits", () => {
    const clock = new SessionClock();
    clock.sent(0, 10_000);
    const a = new SonioxAssembler(clock, "stt-rt-v5");
    const out = a.push([
      tok("Yes", 100, 300),
      tok(" no", 400, 600, "2"),
      tok(",", 600, 600, "2"),
      tok("maybe", 700, 900, "1"),
    ]);
    expect([...out, a.flush()!].map((u) => [u.text, u.speakerKey])).toEqual([
      ["Yes", "soniox:1"],
      ["no,", "soniox:2"],
      ["maybe", "soniox:1"],
    ]);
  });

  test("the running transcript keeps a word whole too", () => {
    const clock = new SessionClock();
    clock.sent(0, 10_000);
    const a = new SonioxAssembler(clock, "stt-rt-v5");
    const toks = [
      tok("Hey", 100, 300),
      tok(" Ad", 300, 500, "1", false),
      tok("ri", 500, 700, "2", false),
    ];
    a.push(toks);
    expect(a.partial(toks)).toMatchObject({ text: "Hey Adri", speakerKey: "soniox:1" });
  });
});

describe("SonioxAssembler: cut off", () => {
  test("a manual finalization marks its utterance cut off only when asked", () => {
    const clock = new SessionClock();
    clock.sent(0, 10_000);
    const a = new SonioxAssembler(clock, "stt-rt-v5");
    const cut = a.push(
      [tok("Hey", 100, 300), tok(" Adri,", 300, 600), tok("<fin>", 600, 600)],
      true,
    );
    expect(cut).toEqual([expect.objectContaining({ text: "Hey Adri,", cutOff: true })]);
    // An endpoint before the <fin> ended a whole utterance: not cut off.
    const out = a.push(
      [
        tok("Yes", 1000, 1200),
        tok("<end>", 1200, 1200),
        tok(" so", 1300, 1400),
        tok("<fin>", 1400, 1400),
      ],
      true,
    );
    expect(out.map((u) => [u.text, u.cutOff])).toEqual([
      ["Yes", undefined],
      ["so", true],
    ]);
    const normal = a.push([tok("Hi", 2000, 2200), tok("<fin>", 2200, 2200)]);
    expect(normal[0]!.cutOff).toBeUndefined();
  });

  test("flush(true): the session broke mid-utterance", () => {
    const clock = new SessionClock();
    clock.sent(0, 10_000);
    const a = new SonioxAssembler(clock, "stt-rt-v5");
    a.push([
      tok("Hey", 100, 300),
      tok(" Adri,", 300, 600),
      tok(" set", 700, 900),
      tok(" a", 900, 1000),
    ]);
    expect(a.flush(true)).toMatchObject({ text: "Hey Adri, set a", cutOff: true });
  });
});

describe("SessionClock.spansFrom", () => {
  test("wall-clock spans of the audio sent after a session time", () => {
    const clock = new SessionClock();
    clock.sent(1_000_000, 2000);
    clock.sent(1_002_000, 1000); // contiguous
    clock.sent(1_060_000, 2000); // a minute later
    expect(clock.spansFrom(0)).toEqual([
      { from: 1_000_000, to: 1_003_000 },
      { from: 1_060_000, to: 1_062_000 },
    ]);
    expect(clock.spansFrom(2500)).toEqual([
      { from: 1_002_500, to: 1_003_000 },
      { from: 1_060_000, to: 1_062_000 },
    ]);
    expect(clock.spansFrom(4000)).toEqual([{ from: 1_061_000, to: 1_062_000 }]);
    expect(clock.spansFrom(5000)).toEqual([]);
  });
});
