import { expect, test } from "bun:test";
import { renderLines } from "../mcp/render";
import { windows } from "./refine";

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
