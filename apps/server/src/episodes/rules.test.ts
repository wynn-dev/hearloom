import { describe, expect, test } from "bun:test";
import {
  type ContextMinute,
  ContextMinutes,
  type ContextScores,
  classify,
  contextScores,
  cutPoint,
  MINUTE,
  Segmenter,
  type SpeechSpan,
  segmentRange,
  windowFeatures,
} from "./rules";

const T0 = Date.UTC(2026, 9, 7, 19, 0);
const at = (min: number) => T0 + min * MINUTE;

/** Speakers taking turns of `turnMs` with `gapMs` pauses between `from` and `to` (minutes). */
function turns(
  from: number,
  to: number,
  speakers: { speaker: string; isWearer?: boolean; weight?: number }[],
  turnMs = 5_000,
  gapMs = 1_000,
): SpeechSpan[] {
  const out: SpeechSpan[] = [];
  const pool = speakers.flatMap((s) => Array(s.weight ?? 1).fill(s));
  let i = 0;
  for (let t = at(from); t + turnMs <= at(to); t += turnMs + gapMs) {
    const s = pool[i++ % pool.length]!;
    out.push({ startAt: t, endAt: t + turnMs, speaker: s.speaker, isWearer: s.isWearer ?? false });
  }
  return out;
}

function minutes(from: number, to: number, scores: Partial<ContextScores>): ContextMinute[] {
  const out: ContextMinute[] = [];
  for (let m = from; m < to; m++) out.push({ at: at(m), windows: 60, scores });
  return out;
}

const me = { speaker: "me", isWearer: true };
const sam = { speaker: "sam" };
const kind = (speech: SpeechSpan[], context: ContextMinute[], selfKnown = true) =>
  classify(windowFeatures(speech, context, at(0), at(2)), selfKnown);

describe("classify", () => {
  test("the user talking with someone is a conversation, even with the TV on", () => {
    expect(kind(turns(0, 2, [me, sam]), [])).toBe("conversation");
    expect(kind(turns(0, 2, [me, sam]), minutes(0, 2, { tv: 0.5 }))).toBe("conversation");
  });

  test("one other voice holding the floor is a talk", () => {
    const lecture = turns(0, 2, [{ speaker: "prof" }], 20_000);
    expect(kind(lecture, [])).toBe("talk");
  });

  test("broadcast audio, or many voices with laughter and music, is media", () => {
    const show = turns(0, 2, [{ speaker: "a" }, { speaker: "b" }, { speaker: "c" }]);
    expect(kind(show, minutes(0, 2, { tv: 0.3 }))).toBe("media");
    expect(kind(show, minutes(0, 2, { laughter: 0.2 }))).toBe("media");
  });

  test("only the user is solo; other people not talking to the user is ambient", () => {
    expect(kind(turns(0, 2, [me]), [])).toBe("solo");
    const cafe = turns(0, 2, [{ speaker: "a" }, { speaker: "b" }, { speaker: "c" }]);
    expect(kind(cafe, [])).toBe("ambient");
  });

  test("without the user's voiceprint, speech defaults to a conversation", () => {
    const cafe = turns(0, 2, [{ speaker: "a" }, { speaker: "b" }]);
    expect(kind(cafe, [], false)).toBe("conversation");
    const lecture = turns(0, 2, [{ speaker: "prof" }], 20_000);
    expect(kind(lecture, minutes(0, 2, { narration: 0.2 }), false)).toBe("talk");
  });

  test("too little speech says nothing", () => {
    expect(kind(turns(0, 0.2, [me, sam]), [])).toBeNull();
  });
});

describe("Segmenter", () => {
  test("labels an unknown episode at once, ignores a one-minute blip, cuts on a lasting change", () => {
    const s = new Segmenter(at(0));
    expect(s.step(at(1), "conversation")).toEqual({ type: "kind", kind: "conversation" });
    expect(s.step(at(6), "media")).toBeNull();
    expect(s.step(at(7), "conversation")).toBeNull();
    expect(s.step(at(8), "media")).toBeNull();
    expect(s.step(at(9), "media")).toEqual({
      type: "cut",
      kind: "media",
      from: at(6),
      to: at(8),
    });
  });

  test("a young episode is re-labelled instead of split", () => {
    const s = new Segmenter(at(0));
    s.step(at(1), "solo");
    s.step(at(2), "conversation");
    expect(s.step(at(3), "conversation")).toEqual({ type: "kind", kind: "conversation" });
  });
});

test("cuts at the start of the utterance after the longest pause", () => {
  const speech: SpeechSpan[] = [
    { startAt: at(0), endAt: at(0) + 4_000, speaker: "a", isWearer: false },
    { startAt: at(0) + 5_000, endAt: at(0) + 9_000, speaker: "a", isWearer: false },
    { startAt: at(0) + 20_000, endAt: at(0) + 24_000, speaker: "b", isWearer: false },
    { startAt: at(0) + 25_000, endAt: at(0) + 29_000, speaker: "b", isWearer: false },
  ];
  expect(cutPoint(speech, at(0), at(1))).toBe(at(0) + 20_000);
  expect(cutPoint([], at(0), at(1))).toBe(at(0));
});

test("context minutes average tagged windows", () => {
  const m = new ContextMinutes();
  const s = (tv: number) => contextScores([{ name: "Television", prob: tv }]);
  m.add(at(0), at(0) + 2_000, s(0.4));
  m.add(at(0) + 1_000, at(0) + 3_000, s(0.2));
  m.add(at(1), at(1) + 2_000, s(0.9));
  expect(m.drain(at(1) + 30_000)).toEqual([{ at: at(0), windows: 2, scores: { tv: 0.3 } }]);
  expect(m.drain().map((x) => x.at)).toEqual([at(1)]);
});

describe("segmenting a stretch of speech", () => {
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2.5 * MINUTE);

  test("an evening: dinner, TV, chatting over the TV, TV", () => {
    const tvVoices = [{ speaker: "a" }, { speaker: "b" }, { speaker: "c" }, { speaker: "d" }];
    const speech = [
      ...turns(0, 40, [me, sam]),
      ...turns(40, 90, tvVoices, 4_000, 500),
      ...turns(90, 110, [me, sam]),
      ...turns(110, 140, tvVoices, 4_000, 500),
    ];
    const context = [
      ...minutes(40, 140, { tv: 0.35, laughter: 0.1 }),
      ...minutes(0, 40, { conversation: 0.3 }),
    ];
    const segs = segmentRange(speech, context, at(0), at(140), true);
    expect(segs.map((s) => s.kind)).toEqual(["conversation", "media", "conversation", "media"]);
    near(segs[1]!.startedAt, at(40));
    near(segs[2]!.startedAt, at(90));
    near(segs[3]!.startedAt, at(110));
    expect(segs[3]!.endedAt).toBe(at(140));
  });

  test("a lecture, then a chat on the way out", () => {
    const speech = [
      ...turns(0, 100, [{ speaker: "prof", weight: 12 }, { speaker: "student" }], 20_000),
      ...turns(100, 112, [me, { speaker: "alice" }]),
    ];
    const segs = segmentRange(speech, [], at(0), at(112), true);
    expect(segs.map((s) => s.kind)).toEqual(["talk", "conversation"]);
    near(segs[1]!.startedAt, at(100));
  });

  test("a short exchange still gets a kind", () => {
    const segs = segmentRange(turns(0, 0.5, [me, sam]), [], at(0), at(0.5), true);
    expect(segs).toEqual([{ startedAt: at(0), endedAt: at(0.5), kind: "conversation" }]);
  });
});
