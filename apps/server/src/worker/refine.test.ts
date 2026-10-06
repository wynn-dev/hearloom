import { expect, test } from "bun:test";
import { renderLines } from "../mcp/render";
import type { ScribeWord } from "../providers/elevenlabs";
import { windows } from "./refine";
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

test("a silent gap cut out of the audio still splits utterances", () => {
  // Stitched audio: 0–2 s is 10:00:00, 2–4 s is 10:01:00 (a 58 s mic-sleep gap was cut out).
  const t0 = Date.UTC(2026, 9, 6, 10, 0, 0);
  const toAbs = (s: number) => (s < 2 ? t0 + s * 1000 : t0 + 60_000 + (s - 2) * 1000);
  const { utterances } = wordsToUtterances(
    [w("Before", 1.2, 1.8), w("after", 2.1, 2.5)],
    toAbs,
    () => "S1",
  );
  expect(utterances.map((u) => u.text)).toEqual(["Before", "after"]);
  expect(utterances[1]!.startAt).toBe(t0 + 60_100);
});

test("long conversations are refined in windows", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 6, 0, 0) + h * 3600_000);
  const rows = [0, 1, 2.5, 3.5, 4, 7.2].map((h) => ({ startAt: at(h), endAt: at(h + 0.1) }));
  expect(windows(rows, 3 * 3600_000).map((w) => w.length)).toEqual([3, 2, 1]);
});

test("timeline lines are ordered by time across days, with day headers", () => {
  const tz = "Europe/Amsterdam";
  const mon = new Date("2026-10-05T07:00:00Z");
  const tue = new Date("2026-10-06T07:00:00Z");
  const utt = (id: string, startAt: Date, text: string) => ({
    id,
    startAt,
    speaker: "Me",
    text,
    lang: "en",
  });
  const lines = renderLines([utt("b", tue, "tuesday"), utt("a", mon, "monday")], [], tz, {
    bookmarks: [{ at: new Date("2026-10-05T08:00:00Z"), note: "idea" }],
    dayHeaders: true,
  });
  expect(lines).toEqual([
    "## Mon 2026-10-05",
    "09:00:00 Me: monday",
    "10:00:00 ⚑ bookmark: idea",
    "## Tue 2026-10-06",
    "09:00:00 Me: tuesday",
  ]);
});
