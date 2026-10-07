import { describe, expect, test } from "bun:test";
import { settingsSchema } from "@hearloom/shared";
import {
  decide,
  HARD_LIMIT_PER_HOUR,
  inQuietHours,
  type PolicyDecision,
  type PolicyInput,
  type QuietReason,
} from "./policy";

const settings = settingsSchema.parse({ timezone: "Europe/Amsterdam" });
// 2026-10-05 is CEST (UTC+2).
const at = (local: string) => new Date(`2026-10-05T${local}:00+02:00`);

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  settings,
  source: "agent",
  level: "active",
  now: at("12:00"),
  sentLastHour: 0,
  audibleLastHour: 0,
  inConversation: false,
  ...over,
});

const sent: PolicyDecision = { action: "send", level: "active", quietedBy: null };
const silent = (quietedBy: QuietReason): PolicyDecision => ({
  action: "send",
  level: "passive",
  quietedBy,
});

describe("notification policy", () => {
  test("quiet hours wrap midnight in the user's timezone", () => {
    expect(inQuietHours(at("23:00"), settings)).toBe(true);
    expect(inQuietHours(at("06:59"), settings)).toBe(true);
    expect(inQuietHours(at("07:30"), settings)).toBe(false);
    expect(inQuietHours(at("12:00"), settings)).toBe(false);
  });

  test("sends right away when nothing is in the way", () => {
    expect(decide(base())).toEqual(sent);
  });

  test("quiet hours deliver silently, even when the agent asks for time-sensitive", () => {
    expect(decide(base({ now: at("23:15") }))).toEqual(silent("quiet_hours"));
    expect(decide(base({ now: at("23:15"), level: "time-sensitive" }))).toEqual(
      silent("quiet_hours"),
    );
  });

  test("system alerts are quiet at night unless time-sensitive (the test button)", () => {
    expect(decide(base({ source: "system", now: at("23:15") }))).toEqual(silent("quiet_hours"));
    expect(decide(base({ source: "system", now: at("23:15"), level: "time-sensitive" }))).toEqual({
      action: "send",
      level: "time-sensitive",
      quietedBy: null,
    });
  });

  test("a conversation makes it silent; time-sensitive still rings", () => {
    expect(decide(base({ inConversation: true }))).toEqual(silent("in_conversation"));
    expect(decide(base({ inConversation: true, level: "time-sensitive" }))).toEqual({
      action: "send",
      level: "time-sensitive",
      quietedBy: null,
    });
  });

  test("past the hourly limit with sound it is silent; system alerts are exempt", () => {
    expect(decide(base({ audibleLastHour: 4, sentLastHour: 4 }))).toEqual(silent("hourly_limit"));
    expect(decide(base({ source: "system", audibleLastHour: 4 }))).toEqual(sent);
  });

  test("passive stays passive without a reason", () => {
    expect(decide(base({ level: "passive", inConversation: true }))).toEqual({
      action: "send",
      level: "passive",
      quietedBy: null,
    });
  });

  test("the hard limit refuses agent notifications but never system alerts", () => {
    const n = HARD_LIMIT_PER_HOUR;
    expect(decide(base({ sentLastHour: n, level: "time-sensitive" }))).toEqual({
      action: "refuse",
      reason: "hard_limit",
    });
    expect(decide(base({ sentLastHour: n, source: "system" }))).toEqual(sent);
  });

  test("disabled sources are refused", () => {
    const off = settingsSchema.parse({ notifications: { sources: { agent: false } } });
    expect(decide(base({ settings: off }))).toEqual({
      action: "refuse",
      reason: "source_disabled",
    });
  });
});
