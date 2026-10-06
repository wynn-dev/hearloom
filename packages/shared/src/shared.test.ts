import { expect, test } from "bun:test";
import { decodeAudioBatch, encodeAudioBatch } from "./ingest";
import { isValidTimeZone, mergeSettings, settingsPatchSchema, settingsSchema } from "./settings";

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
    notifications: { maxPerHour: 12 },
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
  expect(next.notifications.maxPerHour).toBe(12);
  expect(next.notifications.pendantHaptic).toBe(false);
});
