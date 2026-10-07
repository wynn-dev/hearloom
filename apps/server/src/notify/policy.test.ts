import { describe, expect, test } from "bun:test";
import { settingsSchema } from "@hearloom/shared";
import { decide, inQuietHours } from "./policy";

const settings = settingsSchema.parse({ timezone: "Europe/Amsterdam" });
// 2026-10-05 is CEST (UTC+2).
const at = (local: string) => new Date(`2026-10-05T${local}:00+02:00`);

describe("notification policy", () => {
  test("quiet hours wrap midnight in the user's timezone", () => {
    expect(inQuietHours(at("23:00"), settings)).toBe(true);
    expect(inQuietHours(at("06:59"), settings)).toBe(true);
    expect(inQuietHours(at("07:30"), settings)).toBe(false);
    expect(inQuietHours(at("12:00"), settings)).toBe(false);
  });

  test("sends at the requested level outside quiet hours", () => {
    for (const level of ["passive", "active", "time-sensitive"] as const) {
      expect(decide(settings, level, at("12:00"))).toEqual({
        action: "send",
        level,
        quietedBy: null,
      });
    }
  });

  test("alerts are silent at night unless time-sensitive (the test button)", () => {
    expect(decide(settings, "active", at("23:15"))).toEqual({
      action: "send",
      level: "passive",
      quietedBy: "quiet_hours",
    });
    expect(decide(settings, "time-sensitive", at("23:15"))).toEqual({
      action: "send",
      level: "time-sensitive",
      quietedBy: null,
    });
    expect(decide(settings, "passive", at("23:15"))).toEqual({
      action: "send",
      level: "passive",
      quietedBy: null,
    });
  });

  test("alerts turned off are refused", () => {
    const off = settingsSchema.parse({ notifications: { enabled: false } });
    expect(decide(off, "time-sensitive", at("12:00"))).toEqual({
      action: "refuse",
      reason: "disabled",
    });
  });
});
