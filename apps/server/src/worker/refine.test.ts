import { expect, test } from "bun:test";
import type { ScribeWord } from "../providers/elevenlabs";
import { wordsToUtterances } from "./words";

const w = (
  text: string,
  start: number,
  end: number,
  speaker = "speaker_0",
  type: ScribeWord["type"] = "word",
): ScribeWord => ({
  text,
  start,
  end,
  type,
  speaker_id: speaker,
});

test("groups words by speaker and pauses, extracts audio events", () => {
  const words: ScribeWord[] = [
    w("Hoi", 0.1, 0.4),
    w(" ", 0.4, 0.45, "speaker_0", "spacing"),
    w("Sam!", 0.45, 0.8),
    w("(laughter)", 0.9, 1.6, "speaker_0", "audio_event"),
    w("Hey", 1.7, 1.9, "speaker_1"),
    w(" ", 1.9, 1.95, "speaker_1", "spacing"),
    w("there", 1.95, 2.2, "speaker_1"),
    w("Later", 4.0, 4.3, "speaker_1"), // > 1 s pause → new utterance
  ];
  const base = 1_000_000;
  const { utterances, events } = wordsToUtterances(
    words,
    (s) => base + s * 1000,
    (_a, _b, sp) => sp ?? null,
  );
  expect(utterances.map((u) => [u.text, u.speaker, u.lang])).toEqual([
    ["Hoi Sam!", "speaker_0", null],
    ["Hey there", "speaker_1", null],
    ["Later", "speaker_1", null],
  ]);
  expect(utterances[0]!.startAt).toBe(base + 100);
  expect(events).toEqual([{ label: "laughter", startAt: base + 900, endAt: base + 1600 }]);
});
