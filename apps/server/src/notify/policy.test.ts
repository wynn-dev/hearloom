import { describe, expect, test } from "bun:test";
import { settingsSchema } from "@hearloom/shared";
import { decide, inQuietHours, nextLocalTime, type PolicyInput } from "./policy";

const settings = settingsSchema.parse({ timezone: "Europe/Amsterdam" });
// 2026-10-05 is CEST (UTC+2).
const at = (local: string) => new Date(`2026-10-05T${local}:00+02:00`);

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  settings,
  source: "agent",
  interruptionLevel: "active",
  deliverWhen: "now",
  now: at("12:00"),
  sentLastHour: 0,
  inConversation: false,
  ...over,
});

describe("notification policy", () => {
  test("quiet hours wrap midnight in the user's timezone", () => {
    expect(inQuietHours(at("23:00"), settings)).toBe(true);
    expect(inQuietHours(at("06:59"), settings)).toBe(true);
    expect(inQuietHours(at("07:30"), settings)).toBe(false);
    expect(inQuietHours(at("12:00"), settings)).toBe(false);
  });

  test("holds until quiet hours end", () => {
    const d = decide(base({ now: at("23:15") }));
    expect(d).toEqual({
      action: "hold",
      until: nextLocalTime(at("23:15"), "Europe/Amsterdam", "07:30"),
      reason: "quiet_hours",
    });
    if (d.action === "hold") expect(d.until?.toISOString()).toBe("2026-10-06T05:30:00.000Z");
  });

  test("time-sensitive breaks through quiet hours", () => {
    expect(decide(base({ now: at("23:15"), interruptionLevel: "time-sensitive" }))).toEqual({
      action: "send",
    });
  });

  test("rate limit applies to agent/rule but not system", () => {
    expect(decide(base({ sentLastHour: 4 }))).toEqual({
      action: "suppress",
      reason: "rate_limited",
    });
    expect(decide(base({ sentLastHour: 4, source: "system" }))).toEqual({ action: "send" });
  });

  test("defers until the conversation ends", () => {
    expect(decide(base({ deliverWhen: "after_conversation", inConversation: true }))).toEqual({
      action: "hold",
      until: null,
      reason: "in_conversation",
    });
    expect(decide(base({ deliverWhen: "after_conversation" }))).toEqual({ action: "send" });
  });

  test("disabled sources are suppressed", () => {
    const off = settingsSchema.parse({ notifications: { sources: { agent: false } } });
    expect(decide(base({ settings: off }))).toEqual({
      action: "suppress",
      reason: "source_disabled",
    });
  });
});
