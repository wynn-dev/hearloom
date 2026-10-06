import { expect, test } from "bun:test";
import type { Timeline } from "@hearloom/api";
import { buildEntries, defaultFilters } from "./model";

const t = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);
const conv = (id: string, from: string, to: string): Timeline["conversations"][number] => ({
  id,
  startedAt: t(from),
  endedAt: t(to),
  status: "closed",
  languages: ["en"],
  speakerCount: 1,
  title: null,
});

test("conversations after the last row only get a gap divider when there is one", () => {
  const data: Timeline = {
    conversations: [conv("c1", "10:00", "10:05"), conv("c2", "10:10", "10:20")],
    utterances: [],
    soundEvents: [],
    bookmarks: [{ id: "b1", at: t("09:00"), note: null, source: "button" }],
    deviceEvents: [],
    chunks: [],
  };
  const kinds = buildEntries(data, defaultFilters).map((e) => e.kind);
  // 09:00 → 10:00 is a gap; 10:05 → 10:10 is not.
  expect(kinds).toEqual(["bookmark", "gap", "conversation", "conversation"]);
});
