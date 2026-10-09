import { describe, expect, test } from "bun:test";
import { dayInZone, dayRange, formatDayRelative, zonedMidnight } from "./time";

describe("zonedMidnight", () => {
  test.each([
    ["2026-10-06", "UTC", "2026-10-06T00:00:00.000Z", 24],
    ["2026-03-29", "Europe/Amsterdam", "2026-03-28T23:00:00.000Z", 23],
    ["2026-10-25", "Europe/Amsterdam", "2026-10-24T22:00:00.000Z", 25],
    ["2026-10-06", "Pacific/Chatham", "2026-10-05T10:15:00.000Z", 24],
    // DST starts at midnight: 00:00 doesn't exist, the day starts at 01:00.
    ["2026-09-06", "America/Santiago", "2026-09-06T04:00:00.000Z", 23],
    ["2026-03-29", "Asia/Beirut", "2026-03-28T22:00:00.000Z", 23],
  ])("%s in %s", (day, tz, start, hours) => {
    const s = zonedMidnight(day, tz);
    expect(s.toISOString()).toBe(start);
    expect(dayInZone(s, tz)).toBe(day);
    expect(dayInZone(s.getTime() - 60_000, tz) < day).toBe(true);
    const { from, to } = dayRange(day, tz);
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(hours);
  });
});

describe("formatDayRelative", () => {
  const now = Date.parse("2026-10-09T10:00:00Z");
  test("by calendar day in the zone", () => {
    expect(formatDayRelative(Date.parse("2026-10-09T00:30:00Z"), now, "UTC")).toBe("Today");
    expect(formatDayRelative(Date.parse("2026-10-08T23:59:00Z"), now, "UTC")).toBe("Yesterday");
    // 23:30 UTC on the 8th is already the 9th in Amsterdam.
    expect(formatDayRelative(Date.parse("2026-10-08T23:30:00Z"), now, "Europe/Amsterdam")).toBe(
      "Today",
    );
    expect(formatDayRelative(Date.parse("2026-10-07T12:00:00Z"), now, "UTC")).not.toMatch(
      /Today|Yesterday/,
    );
  });
  test("a clock slightly ahead of ours is still today", () => {
    expect(formatDayRelative(now + 60_000, now, "UTC")).toBe("Today");
  });
});
