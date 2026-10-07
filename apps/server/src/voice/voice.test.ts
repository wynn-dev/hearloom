import "../test-db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { schema } from "@hearloom/db";
import { SPEAKER_MODEL_ID } from "@hearloom/inference";
import type { ServerWebSocket } from "bun";
import { and, eq, sql } from "drizzle-orm";
import { webhookSignature } from "../agent/webhooks";
import { db } from "../db";
import { type IngestSocketData, registerPhoneSocket } from "../ingest/phones";
import { livePipeline } from "../live/host";
import { TEACH_GRACE_MS } from "../live/voice/detector";
import type { VoiceDetection } from "../live/voice/types";
import { getSettings, updateSettings } from "../settings";
import { onDetection, recoverPending, sendTestCommand, setFeedback } from "./commands";
import { MAX_AGE_MS } from "./deliver";
import { ensureSelfPerson, voiceProfile } from "./profile";
import {
  IDLE_MS,
  onTeachHeard,
  replayTeach,
  resetTeach,
  startTeach,
  stopTeach,
  teachState,
  uploadSample,
} from "./teach";

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
/** A capture stream for commands whose audio is learned from. */
const streamId = crypto.randomUUID();

beforeAll(async () => {
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Tester", email: `${userId}@test.local` });
  const [phone] = await db
    .insert(schema.phones)
    .values({ userId, name: "test phone" })
    .returning({ id: schema.phones.id });
  phoneId = phone!.id;
  await db.insert(schema.captureStreams).values({
    id: streamId,
    userId,
    phoneId,
    codec: 20,
    sampleRate: 16000,
    frameMs: 20,
    startedAt: new Date(),
  });
  await ensureSelfPerson(userId, "Tester");
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
    parts: [],
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

/** Stand-ins for the live pipeline (not running in tests). */
const pipeline = livePipeline as unknown as {
  learnVoice: typeof livePipeline.learnVoice;
  teach: typeof livePipeline.teach;
  teachAudio: typeof livePipeline.teachAudio;
};
const real = {
  ...pipeline,
  learnVoice: pipeline.learnVoice,
  teach: pipeline.teach,
  teachAudio: pipeline.teachAudio,
};
afterEach(() => {
  pipeline.learnVoice = real.learnVoice;
  pipeline.teach = real.teach;
  pipeline.teachAudio = real.teachAudio;
});

async function samplesOf(commandId: string) {
  return db.select().from(schema.voiceSamples).where(eq(schema.voiceSamples.commandId, commandId));
}

test("feedback: false triggers block the spelling, confirmations teach it", async () => {
  const fuzzy = detection({ status: "shadow", heardAs: "herpes", nameScore: 0.9 });
  await onDetection(fuzzy);
  expect(await setFeedback(userId, fuzzy.id, "false_trigger")).toEqual({
    learned: false,
    note: null,
  });
  expect((await getSettings(userId)).voice.blocked).toEqual(["herpes"]);

  // A fired command passed the own-voice gate: its spelling is learned even when its audio
  // can't be (the live pipeline isn't running here).
  const fired = detection({ status: "shadow", heardAs: "Hermus", nameScore: 0.9 });
  await onDetection(fired);
  const r = await setFeedback(userId, fired.id, "confirmed");
  expect(r.learned).toBe(true);
  expect((await getSettings(userId)).voice.aliases).toEqual(["Hermus"]);
  expect(await samplesOf(fired.id)).toHaveLength(1);
  // Changing the verdict undoes what it taught.
  await setFeedback(userId, fired.id, null);
  expect(await samplesOf(fired.id)).toHaveLength(0);
  await updateSettings(userId, { voice: { aliases: [], blocked: [] } });
});

test("feedback: Missed is refused where the gate heard someone else", async () => {
  for (const reason of ["not_own_voice", "media_voice"] as const) {
    const d = detection({ status: "ignored", reason, speakerScore: 0.35 });
    await onDetection(d);
    await expect(setFeedback(userId, d.id, "missed")).rejects.toThrow("didn't sound like you");
    expect((await row(d.id)).feedback).toBeNull();
  }
  // Nor can a command that fired be "missed", or an ignored one "confirmed".
  const sent = detection({ status: "shadow" });
  await onDetection(sent);
  await expect(setFeedback(userId, sent.id, "missed")).rejects.toThrow();
  const ignored = detection({ status: "ignored", reason: "near_miss" });
  await onDetection(ignored);
  await expect(setFeedback(userId, ignored.id, "confirmed")).rejects.toThrow();
});

test("feedback: Missed learns from the parts' audio only if it sounds like the user", async () => {
  const calls: unknown[] = [];
  pipeline.learnVoice = async (...args) => {
    calls.push(args);
    return { voiceprintId: await voiceprint(), seconds: 2.1 };
  };
  const parts = [
    { startAt: Date.now() - 9000, endAt: Date.now() - 8200 },
    { startAt: Date.now() - 3000, endAt: Date.now() - 1000 },
  ];
  const d = detection({
    status: "ignored",
    reason: "no_command",
    heardAs: "Hermus",
    parts,
    streamId,
  });
  await onDetection(d);
  expect(await setFeedback(userId, d.id, "missed")).toEqual({ learned: true, note: null });
  // The command's own utterances, not the 5 s between them.
  expect(calls[0]).toEqual([userId, expect.any(String), streamId, parts]);
  const [sample] = await samplesOf(d.id);
  expect(sample).toMatchObject({ source: "command", seconds: 2.1 });
  expect(sample!.voiceprintId).not.toBeNull();
  expect((await getSettings(userId)).voice.aliases).toEqual(["Hermus"]);
  await updateSettings(userId, { voice: { aliases: [] } });

  // The live pipeline says it isn't the user's voice: nothing is learned, not even the spelling.
  pipeline.learnVoice = async () => {
    throw new Error("That didn't sound like you — not learned.");
  };
  const other = detection({ status: "ignored", reason: "near_miss", heardAs: "Hermos", streamId });
  await onDetection(other);
  const r = await setFeedback(userId, other.id, "missed");
  expect(r).toEqual({ learned: false, note: "That didn't sound like you — not learned." });
  expect(await samplesOf(other.id)).toHaveLength(0);
  expect((await getSettings(userId)).voice.aliases).toEqual([]);
});

test("feedback on one command is serialized: 👍 then 👎 leaves nothing learned", async () => {
  const created: string[] = [];
  pipeline.learnVoice = async () => {
    await Bun.sleep(150); // the 👎 arrives while the 👍 is still learning
    const voiceprintId = await voiceprint();
    created.push(voiceprintId);
    return { voiceprintId, seconds: 2 };
  };
  const d = detection({ status: "shadow", streamId });
  await onDetection(d);
  const up = setFeedback(userId, d.id, "confirmed");
  await Bun.sleep(20);
  const down = setFeedback(userId, d.id, "false_trigger");
  await Promise.all([up, down]);
  expect((await row(d.id)).feedback).toBe("false_trigger");
  expect(await samplesOf(d.id)).toHaveLength(0);
  expect(created).toHaveLength(1);
  const left = await db
    .select()
    .from(schema.voiceprints)
    .where(eq(schema.voiceprints.id, created[0]!));
  expect(left).toHaveLength(0);
});

/** A voiceprint row for the user's own person (what the live pipeline would store). */
async function voiceprint(seconds = 2): Promise<string> {
  const personId = await ensureSelfPerson(userId, "Tester");
  const [vp] = await db
    .insert(schema.voiceprints)
    .values({
      userId,
      personId,
      model: SPEAKER_MODEL_ID,
      embedding: Array.from({ length: 4 }, () => Math.random()),
      sampleSeconds: seconds,
      source: "confirmed",
    })
    .returning({ id: schema.voiceprints.id });
  return vp!.id;
}

test("teaching: samples are stored, the phrase advances, aliases are learned", async () => {
  const samplesBefore = (await voiceProfile(userId)).samples;
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
  expect(profile.samples).toBe(samplesBefore + 2);
  // The self person was created for the voiceprints.
  expect(profile.personId).not.toBeNull();
});

test("while teaching, detections are stored as ignored, never sent", async () => {
  await startTeach(userId, "Tester", "sample");
  const d = detection({ status: "pending" });
  await onDetection(d);
  expect(received).toHaveLength(0);
  expect(await row(d.id)).toMatchObject({ status: "ignored", reason: "teaching" });
  stopTeach(userId);
});

test("a restarted live pipeline gets the teaching prompts again", async () => {
  const sent: unknown[] = [];
  pipeline.teach = (u, prompt) => sent.push([u, prompt?.sessionId]);
  await startTeach(userId, "Tester", "sample");
  const { sessionId } = teachState(userId)!;
  sent.length = 0;
  replayTeach();
  expect(sent).toEqual([[userId, sessionId]]);
  stopTeach(userId);
});

test("only progress keeps a teaching session alive; stale stops don't end a newer one", async () => {
  await startTeach(userId, "Tester", "sample");
  const s = teachState(userId)!;
  const result = (ok: boolean) => ({
    sessionId: s.sessionId,
    kind: "sample" as const,
    index: s.index,
    phrase: s.phrase,
    source: "pendant" as const,
    text: ok ? "Hey Hermes" : "pass the salt",
    ok,
    heardAs: ok ? "Hermes" : null,
    nameScore: ok ? 1 : 0,
    wouldMatch: ok,
    speakerScore: ok ? 0.7 : null,
    seconds: 1,
    voiceprintId: null,
    wouldTrigger: false,
  });
  await Bun.sleep(10);
  await onTeachHeard(userId, result(false)); // the TV, someone else
  expect(teachState(userId)!.expiresAt).toBe(s.expiresAt);
  await onTeachHeard(userId, result(true));
  expect(teachState(userId)!.expiresAt).toBeGreaterThan(s.expiresAt);
  expect(teachState(userId)!.expiresAt - Date.now()).toBeLessThanOrEqual(IDLE_MS);

  // A page from an older session going away doesn't stop this one.
  stopTeach(userId, "some-older-session");
  expect(teachState(userId)).not.toBeNull();
  stopTeach(userId, s.sessionId);
  expect(teachState(userId)).toBeNull();
});

test("browser uploads: one at a time", async () => {
  let uploads = 0;
  pipeline.teachAudio = () => {
    uploads++;
    return true;
  };
  await startTeach(userId, "Tester", "sample");
  const { sessionId } = teachState(userId)!;
  const pcm = new Int16Array(16_000);
  uploadSample(userId, sessionId, pcm);
  expect(() => uploadSample(userId, sessionId, pcm)).toThrow("still listening");
  expect(uploads).toBe(1);
  // Its result frees the slot.
  const s = teachState(userId)!;
  await onTeachHeard(userId, {
    sessionId,
    kind: "sample",
    index: s.index,
    phrase: s.phrase,
    source: "browser",
    text: "",
    ok: false,
    heardAs: null,
    nameScore: 0,
    wouldMatch: false,
    speakerScore: null,
    seconds: 0,
    voiceprintId: null,
    wouldTrigger: false,
    error: "transcription is off",
  });
  uploadSample(userId, sessionId, pcm);
  expect(uploads).toBe(2);
  stopTeach(userId);
});

test("after a restart, stuck pending commands are retried or expired", async () => {
  await updateSettings(userId, { voice: { mode: "on" } });
  const old = detection({ status: "ignored", spokenAt: Date.now() - MAX_AGE_MS - 5_000 });
  const fresh = detection({ status: "ignored", spokenAt: Date.now() - 5_000 });
  await onDetection(old);
  await onDetection(fresh);
  // As if the server stopped mid-delivery.
  await db
    .update(schema.voiceCommands)
    .set({ status: "pending" })
    .where(eq(schema.voiceCommands.userId, userId));
  await db
    .update(schema.voiceCommands)
    .set({ status: "sent" })
    .where(
      and(
        eq(schema.voiceCommands.userId, userId),
        sql`${schema.voiceCommands.id} not in (${old.id}::uuid, ${fresh.id}::uuid)`,
      ),
    );
  const r = await recoverPending();
  expect(r).toEqual({ retried: 1, expired: 1 });
  expect(await row(old.id)).toMatchObject({ status: "expired", reason: "restart" });
  await Bun.sleep(200);
  expect(received.map((x) => x.body.id)).toEqual([fresh.id]);
  expect((await row(fresh.id)).status).toBe("sent");

  // Turned off (or to shadow) while it was pending: expired, never sent.
  await updateSettings(userId, { voice: { mode: "shadow" } });
  const late = detection({ status: "ignored", spokenAt: Date.now() - 5_000 });
  await onDetection(late);
  await db
    .update(schema.voiceCommands)
    .set({ status: "pending" })
    .where(eq(schema.voiceCommands.id, late.id));
  received.length = 0;
  expect(await recoverPending()).toEqual({ retried: 0, expired: 1 });
  expect(await row(late.id)).toMatchObject({ status: "expired", reason: "mode_off" });
  await Bun.sleep(100);
  expect(received).toHaveLength(0);
  await updateSettings(userId, { voice: { mode: "off" } });
});

test("speech from just before or after Done is still teaching, never sent", async () => {
  await startTeach(userId, "Tester", "sample");
  stopTeach(userId);
  // The last phrase, finalized after Done.
  const last = detection({ status: "pending", spokenAt: Date.now() - 2_000 });
  await onDetection(last);
  expect(await row(last.id)).toMatchObject({ status: "ignored", reason: "teaching" });
  // Something said well after: a command again.
  const later = detection({ status: "pending", spokenAt: Date.now() + TEACH_GRACE_MS + 1_000 });
  await onDetection(later);
  expect((await row(later.id)).status).toBe("sent");
  expect(received.map((x) => x.body.id)).toEqual([later.id]);
});

test("the own-voice threshold ignores scores from vouched-for commands", async () => {
  await db.delete(schema.voiceSamples).where(eq(schema.voiceSamples.userId, userId));
  const taught = [0.74, 0.76, 0.78, 0.8, 0.81, 0.75, 0.79, 0.77];
  for (const score of taught)
    await db.insert(schema.voiceSamples).values({
      userId,
      source: "pendant",
      text: "Hey Hermes",
      nameScore: 1,
      speakerScore: score,
      seconds: 2,
    });
  const before = (await voiceProfile(userId)).threshold;
  for (const score of [0.35, 0.35])
    await db.insert(schema.voiceSamples).values({
      userId,
      source: "command",
      text: "Hey Hermes, x",
      nameScore: 1,
      speakerScore: score,
      seconds: 2,
    });
  expect((await voiceProfile(userId)).threshold).toBe(before);
  expect(before).toBeCloseTo(0.7);
});
