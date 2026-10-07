import { expect, test } from "bun:test";
import type { Timeline } from "@hearloom/api";
import { buildEntries, defaultFilters, foldedByDefault } from "./model";

const t = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);
const episode = (
  id: string,
  from: string,
  to: string,
  kind: Timeline["episodes"][number]["kind"] = "conversation",
): Timeline["episodes"][number] => ({
  id,
  startedAt: t(from),
  endedAt: t(to),
  kind,
  kindSource: "rule",
  boundarySource: "rule",
  title: null,
  summary: null,
  refined: false,
  speakerCount: 1,
  languages: ["en"],
});

const utterance = (id: string, at: string): Timeline["utterances"][number] => ({
  id,
  startAt: t(at),
  endAt: t(at),
  speakerKey: "S1",
  personId: null,
  personName: null,
  isWearer: null,
  text: id,
  lang: "en",
  source: "live",
  mediaVoice: false,
});

test("episodes after the last row only get a gap divider when there is one", () => {
  const data: Timeline = {
    episodes: [episode("c1", "10:00", "10:05"), episode("c2", "10:10", "10:20")],
    utterances: [],
    soundEvents: [],
    bookmarks: [{ id: "b1", at: t("09:00"), note: null, source: "button" }],
    deviceEvents: [],
    chunks: [],
  };
  const kinds = buildEntries(data, defaultFilters).map((e) => e.kind);
  // 09:00 → 10:00 is a gap; 10:05 → 10:10 is not.
  expect(kinds).toEqual(["bookmark", "gap", "episode", "episode"]);
});

test("rows belong to the episode they start in; folded episodes hide their rows", () => {
  const data: Timeline = {
    episodes: [episode("talk", "10:00", "10:30"), episode("tv", "10:30", "11:00", "media")],
    utterances: [utterance("u1", "10:15"), utterance("u2", "10:29"), utterance("u3", "10:31")],
    soundEvents: [],
    bookmarks: [{ id: "b1", at: t("10:40"), note: null, source: "button" }],
    deviceEvents: [],
    chunks: [],
  };
  const all = buildEntries(data, defaultFilters);
  expect(all.map((e) => `${e.kind}:${e.ep}`)).toEqual([
    "episode:talk",
    "utterance:talk",
    "utterance:talk",
    "episode:tv",
    "utterance:tv",
    "bookmark:tv",
  ]);
  // Folding hides what was said, not the user's bookmark.
  const folded = buildEntries(data, defaultFilters, foldedByDefault);
  expect(folded.map((e) => e.key)).toEqual(["e:talk", "u:u1", "u:u2", "e:tv", "b:b1"]);
  expect(folded[3]).toMatchObject({ kind: "episode", hidden: 1 });
});
