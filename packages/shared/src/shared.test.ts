import { expect, test } from "bun:test";
import { decodeAudioBatch, encodeAudioBatch } from "./ingest";
import {
  isValidTimeZone,
  mergeSettings,
  publicSettings,
  publicSettingsSchema,
  resolveSettings,
  settingsPatchSchema,
  settingsSchema,
  voiceRenameReset,
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

test("renaming the agent clears learned spellings", () => {
  const current = mergeSettings(resolveSettings({}), {
    voice: { names: ["Hermes"], aliases: ["her mess"], blocked: ["herpes"] },
  });
  expect(voiceRenameReset(current, { voice: { names: ["Jarvis"] } })).toEqual({
    voice: { names: ["Jarvis"], aliases: [], blocked: [] },
  });
  // Same name (case/accents aside), or no rename: untouched.
  expect(voiceRenameReset(current, { voice: { names: ["hermès"] } })).toEqual({
    voice: { names: ["hermès"] },
  });
  expect(voiceRenameReset(current, { voice: { mode: "on" } })).toEqual({ voice: { mode: "on" } });
});

test("publicSettings: the webhook secret is write-only", () => {
  const s = resolveSettings({
    agent: { webhookUrl: "https://hermes.example/hook", webhookSecret: "whsec_c2VjcmV0c2VjcmV0" },
  });
  const pub = publicSettings(s);
  expect(pub.agent).toEqual({
    webhookUrl: "https://hermes.example/hook",
    webhookSecretSet: true,
    webhookSecretHint: "cmV0",
  });
  expect(JSON.stringify(pub)).not.toContain("c2VjcmV0c2VjcmV0");
  expect(publicSettingsSchema.parse(pub)).toEqual(pub);
  // The rest is untouched.
  expect({ ...pub, agent: undefined }).toEqual({ ...s, agent: undefined });
  expect(publicSettings(resolveSettings({})).agent).toEqual({
    webhookUrl: "",
    webhookSecretSet: false,
    webhookSecretHint: null,
  });
  // The hint skips base64 padding: generated secrets all end in "=".
  expect(
    publicSettings(
      resolveSettings({
        agent: { webhookSecret: "whsec_ymkG+jErdthmowvlVFOlsjJeA9bFMl6V7OWaAwsYa8I=" },
      }),
    ).agent.webhookSecretHint,
  ).toBe("Ya8I");
  // Too short to hint at.
  expect(publicSettings(resolveSettings({ agent: { webhookSecret: "s3cret" } })).agent).toEqual({
    webhookUrl: "",
    webhookSecretSet: true,
    webhookSecretHint: null,
  });
});
