import { expect, test } from "bun:test";
import { decodeAudioBatch, encodeAudioBatch } from "./ingest";
import {
  isValidTimeZone,
  mergeSettings,
  resolveSettings,
  settingsPatchSchema,
  settingsSchema,
} from "./settings";

const frame = (seq: number, at: number) => ({ seq, at, data: new Uint8Array([0xb8, 1, 2]) });

test("round-trips audio batches", () => {
  const t = 1_760_000_000_000;
  const batch = decodeAudioBatch(encodeAudioBatch(2, [frame(10, t), frame(11, t + 20)]));
  expect(batch.slot).toBe(2);
  expect(batch.frames.map((f) => [f.seq, f.at])).toEqual([
    [10, t],
    [11, t + 20],
  ]);
});

test("rejects implausible capture times", () => {
  expect(() => decodeAudioBatch(encodeAudioBatch(0, [frame(0, 5)]))).toThrow(
    "capture time out of range",
  );
});

test("validates time zones", () => {
  expect(isValidTimeZone("Europe/Amsterdam")).toBe(true);
  expect(isValidTimeZone("Foo/Bar")).toBe(false);
});

test("a partial settings patch only changes the fields it sends", () => {
  const current = settingsSchema.parse({
    quietHours: { start: "23:15", end: "06:00" },
    notifications: { enabled: false },
  });
  const patch = settingsPatchSchema.parse({
    quietHours: { enabled: false },
    notifications: { pendantHaptic: false },
  });
  expect(patch).toEqual({
    quietHours: { enabled: false },
    notifications: { pendantHaptic: false },
  });
  const next = mergeSettings(current, patch);
  expect(next.quietHours).toEqual({ enabled: false, start: "23:15", end: "06:00" });
  expect(next.notifications).toEqual({ enabled: false, pendantHaptic: false });
});

test("changing the webhook URL keeps the secret", () => {
  const current = settingsSchema.parse({
    agent: { webhookUrl: "https://hermes.example/hook", webhookSecret: "whsec_c2VjcmV0" },
  });
  const next = mergeSettings(
    current,
    settingsPatchSchema.parse({ agent: { webhookUrl: "https://hermes.example/other" } }),
  );
  expect(next.agent).toEqual({
    webhookUrl: "https://hermes.example/other",
    webhookSecret: "whsec_c2VjcmV0",
  });
});

test("settings stored with agent notifications upgrade instead of resetting", () => {
  const s = resolveSettings({
    timezone: "Europe/Amsterdam",
    notifications: { maxPerHour: 4, sources: { system: false, agent: true }, pendantHaptic: false },
    button: { tap: "bookmark", doubleTap: "mute", hold: "ack_nudge" },
    agent: {
      webhookUrl: "https://hermes.example/hook",
      webhookSecret: "s3cret",
      events: { episodeEnded: { conversation: true }, bookmark: true },
    },
  });
  expect(s.timezone).toBe("Europe/Amsterdam");
  expect(s.notifications).toEqual({ enabled: false, pendantHaptic: false });
  expect(s.button).toEqual({ tap: "bookmark", doubleTap: "mute", hold: "none" });
  expect(s.agent).toEqual({ webhookUrl: "https://hermes.example/hook", webhookSecret: "s3cret" });
  expect(resolveSettings({}).notifications.enabled).toBe(true);
});

test("a whsec_ webhook secret must be base64", () => {
  const ok = (webhookSecret: string) =>
    settingsPatchSchema.safeParse({ agent: { webhookSecret } }).success;
  expect(ok("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")).toBe(true);
  expect(ok("any raw secret")).toBe(true);
  expect(ok("")).toBe(true);
  expect(ok("whsec_")).toBe(false);
  expect(ok("whsec_not base64!")).toBe(false);
});
