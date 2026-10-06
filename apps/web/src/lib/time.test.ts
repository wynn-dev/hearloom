import { describe, expect, test } from "bun:test";
import { dayInZone, dayRange, zonedMidnight } from "./time";

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
