import "../test-db";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { schema } from "@hearloom/db";
import type { ServerWebSocket } from "bun";
import { and, eq } from "drizzle-orm";
import { webhookSignature } from "../agent/webhooks";
import { db } from "../db";
import { type IngestSocketData, registerPhoneSocket } from "../ingest/phones";
import type { VoiceDetection } from "../live/voice/types";
import { getSettings, updateSettings } from "../settings";
import { onDetection, sendTestCommand, setFeedback } from "./commands";
import { voiceProfile } from "./profile";
import { onTeachHeard, resetTeach, startTeach, teachState } from "./teach";

// Runs against the throwaway test database with a throwaway user (rows cascade on delete).
const userId = `test-${crypto.randomUUID()}`;
const SECRET = "whsec_c2VjcmV0LWtleS1mb3ItdGVzdHM=";

/** A fake Hermes webhook route: answers with the next queued response. */
const received: { headers: Headers; body: Record<string, unknown> }[] = [];
let answers: { status: number; body?: string }[] = [];
const hermes = Bun.serve({
  port: 0,
  async fetch(req) {
    const text = await req.text();
    received.push({ headers: req.headers, body: JSON.parse(text) });
    const a = answers.shift() ?? { status: 202 };
    return new Response(a.body ?? '{"status":"accepted"}', { status: a.status });
  },
});

/** A fake phone connection, to see the pendant buzzes. */
const buzzes: string[] = [];
let phoneId = "";

beforeAll(async () => {
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Tester", email: `${userId}@test.local` });
  const [phone] = await db
    .insert(schema.phones)
    .values({ userId, name: "test phone" })
    .returning({ id: schema.phones.id });
  phoneId = phone!.id;
  registerPhoneSocket(phoneId, {
    data: { kind: "ingest", userId, phoneId } as IngestSocketData,
    send: (msg: string) => {
      const m = JSON.parse(msg);
      if (m.t === "haptic") buzzes.push(m.pattern);
      return 1;
    },
  } as unknown as ServerWebSocket<IngestSocketData>);
  await updateSettings(userId, {
    agent: {
      webhookUrl: `http://localhost:${hermes.port}/webhooks/hearloom`,
      webhookSecret: SECRET,
    },
  });
});

afterAll(async () => {
  resetTeach();
  hermes.stop(true);
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

beforeEach(() => {
  received.length = 0;
  buzzes.length = 0;
  answers = [];
});

function detection(over: Partial<VoiceDetection> = {}): VoiceDetection {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    userId,
    // No capture stream rows in this test.
    streamId: null as never,
    chainId: crypto.randomUUID(),
    spokenAt: now - 3000,
    endedAt: now - 1000,
    detectedAt: now,
    wakeName: "Hermes",
    heardAs: "Hermes",
    nameScore: 1,
    transcript: "Hey Hermes, what's 17 times 23?",
    command: "what's 17 times 23?",
    lang: "en",
    speakerScore: 0.78,
    status: "pending",
    reason: null,
    ...over,
  };
}

async function row(id: string) {
  const [r] = await db.select().from(schema.voiceCommands).where(eq(schema.voiceCommands.id, id));
  return r!;
}

test("a command is delivered, signed, and acknowledged with a short buzz", async () => {
  const d = detection();
  await onDetection(d);
  expect(received).toHaveLength(1);
  const { headers, body } = received[0]!;
  expect(body).toMatchObject({
    id: d.id,
    type: "voice.command",
    command: "what's 17 times 23?",
    wakeName: "Hermes",
    speaker: { verified: true, score: 0.78 },
    attempt: 1,
    userId,
  });
  expect(headers.get("webhook-id")).toBe(d.id);
  const ts = Number(headers.get("webhook-timestamp"));
  expect(headers.get("webhook-signature")).toBe(
    webhookSignature(SECRET, d.id, ts, JSON.stringify(body)),
  );
  const r = await row(d.id);
  expect(r).toMatchObject({ status: "sent", attempts: 1, httpStatus: 202, reason: null });
  expect(r.sentAt).not.toBeNull();
  expect(buzzes).toEqual(["short"]);
});

test("retries a 500 with the same event id", async () => {
  answers = [{ status: 500 }, { status: 202 }];
  const d = detection();
  await onDetection(d);
  expect(received.map((r) => r.headers.get("webhook-id"))).toEqual([d.id, d.id]);
  expect(received.map((r) => r.body.attempt)).toEqual([1, 2]);
  expect(await row(d.id)).toMatchObject({ status: "sent", attempts: 2 });
}, 10_000);

test("a rejected command: double buzz and a silent notification", async () => {
  answers = [{ status: 401, body: "bad signature" }];
  const d = detection();
  await onDetection(d);
  expect(await row(d.id)).toMatchObject({ status: "failed", reason: "http_401", attempts: 1 });
  expect(buzzes).toEqual(["short", "short"]);
  const [n] = await db
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.userId, userId),
        eq(schema.notifications.category, "voice_command"),
      ),
    );
  expect(n).toMatchObject({ interruptionLevel: "passive", deepLink: "/voice" });
  expect(n!.body).toContain("secret was rejected");
});

test("ignored and shadow detections are stored, never sent", async () => {
  const ignored = detection({ status: "ignored", reason: "not_own_voice", speakerScore: 0.4 });
  const shadow = detection({ status: "shadow" });
  await onDetection(ignored);
  await onDetection(shadow);
  expect(received).toHaveLength(0);
  expect(buzzes).toHaveLength(0);
  expect(await row(ignored.id)).toMatchObject({ status: "ignored", reason: "not_own_voice" });
  expect((await row(shadow.id)).status).toBe("shadow");
});

test("test command", async () => {
  const r = await sendTestCommand(userId);
  expect(r.status).toBe("sent");
  expect(received[0]!.body).toMatchObject({ type: "voice.command", test: true });
  expect((await row(r.id)).status).toBe("test");
  expect(buzzes).toHaveLength(0);
});

test("feedback: false triggers block the spelling, confirmations teach it", async () => {
  const fuzzy = detection({
    status: "ignored",
    reason: "near_miss",
    heardAs: "herpes",
    nameScore: 0.9,
  });
  await onDetection(fuzzy);
  await setFeedback(userId, fuzzy.id, "false_trigger");
  expect((await getSettings(userId)).voice.blocked).toEqual(["herpes"]);

  const missed = detection({ status: "ignored", reason: "near_miss", heardAs: "Hermus" });
  await onDetection(missed);
  // The live pipeline isn't running: the alias is learned, the voice isn't.
  await setFeedback(userId, missed.id, "missed");
  expect((await getSettings(userId)).voice.aliases).toEqual(["Hermus"]);
  const samples = await db
    .select()
    .from(schema.voiceSamples)
    .where(eq(schema.voiceSamples.commandId, missed.id));
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ source: "command", heardAs: "Hermus", voiceprintId: null });
  expect((await row(missed.id)).feedback).toBe("missed");

  // Changing the verdict undoes the learned sample.
  await setFeedback(userId, missed.id, null);
  expect(
    await db.select().from(schema.voiceSamples).where(eq(schema.voiceSamples.commandId, missed.id)),
  ).toHaveLength(0);
  await updateSettings(userId, { voice: { aliases: [], blocked: [] } });
});

test("teaching: samples are stored, the phrase advances, aliases are learned", async () => {
  await startTeach(userId, "Tester", "sample");
  const state = teachState(userId)!;
  expect(state.phrase).toBe("Hey Hermes");
  const heard = (index: number, phrase: string, heardAs: string) =>
    onTeachHeard(userId, {
      sessionId: state.sessionId,
      kind: "sample",
      index,
      phrase,
      source: "pendant",
      text: `Hey ${heardAs}`,
      ok: true,
      heardAs,
      nameScore: 0,
      wouldMatch: false,
      speakerScore: 0.7,
      seconds: 2,
      voiceprintId: null,
      wouldTrigger: false,
    });
  await heard(state.index, state.phrase, "air miss");
  const next = teachState(userId)!;
  expect(next.index).toBe(state.index + 1);
  expect(next.taken).toBe(1);
  expect(next.phrase).toBe("Hey Hermes, what's the weather tomorrow?");
  // Not like the name: learned only once heard twice.
  expect((await getSettings(userId)).voice.aliases).toEqual([]);
  await heard(next.index, next.phrase, "air miss");
  expect((await getSettings(userId)).voice.aliases).toEqual(["air miss"]);
  // A stale result (an old phrase) is shown but not stored.
  await heard(0, "Hey Hermes", "Hermes");
  expect(teachState(userId)!.taken).toBe(2);

  const profile = await voiceProfile(userId);
  expect(profile.samples).toBe(2);
  expect(profile.canEnable).toBe(false); // no voiceprint yet
  // The self person was created for the voiceprints.
  expect(profile.personId).not.toBeNull();
});
