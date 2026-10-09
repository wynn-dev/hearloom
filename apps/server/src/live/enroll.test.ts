import "../test-db";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { schema } from "@hearloom/db";
import { SPEAKER_MODEL_ID } from "@hearloom/inference";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { enrollUtterance } from "./enroll";
import { SpeakerDirectory } from "./speakers";

// Throwaway user in the test database (rows cascade on delete).
const userId = `test-${crypto.randomUUID()}`;
const streamId = crypto.randomUUID();
let me = "";
let partner = "";

/** Unit vectors: cos(a, b) is easy to read off. */
const VOICE = [1, 0, 0];
const LIKE_ME = [0.8, 0.6, 0]; // cos 0.8 with VOICE
const UNLIKE_ME = [0.44, 0, Math.sqrt(1 - 0.44 ** 2)]; // cos 0.44: the real bad clip
const PARTNER = [0, 1, 0];

beforeAll(async () => {
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Tester", email: `${userId}@test.local` });
  await db.insert(schema.captureStreams).values({
    id: streamId,
    userId,
    codec: 20,
    sampleRate: 16000,
    frameMs: 20,
    startedAt: new Date(),
  });
  const rows = await db
    .insert(schema.people)
    .values([
      { userId, name: "Me", isSelf: true },
      { userId, name: "Partner", isSelf: false },
    ])
    .returning({ id: schema.people.id, isSelf: schema.people.isSelf });
  me = rows.find((r) => r.isSelf)!.id;
  partner = rows.find((r) => !r.isSelf)!.id;
});

afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

beforeEach(async () => {
  await db.delete(schema.voiceprints).where(eq(schema.voiceprints.userId, userId));
});

async function print(personId: string, embedding: number[], utteranceId?: string) {
  await db.insert(schema.voiceprints).values({
    userId,
    personId,
    utteranceId: utteranceId ?? null,
    model: SPEAKER_MODEL_ID,
    embedding,
    sampleSeconds: 2,
    source: "enrollment",
  });
}

async function utterance(): Promise<string> {
  const [u] = await db
    .insert(schema.utterances)
    .values({
      userId,
      streamId,
      startAt: new Date(Date.now() - 3000),
      endAt: new Date(Date.now() - 1000),
      text: "This is me talking",
      source: "live",
      provider: "test",
    })
    .returning({ id: schema.utterances.id });
  return u!.id;
}

function deps(embedding: number[]) {
  return {
    db,
    embed: () => Float32Array.from(embedding),
    loadAudio: async () => new Float32Array(32_000),
    minScore: async () => 0.57,
  };
}

async function printsOf(personId: string) {
  return db
    .select()
    .from(schema.voiceprints)
    .where(and(eq(schema.voiceprints.userId, userId), eq(schema.voiceprints.personId, personId)));
}

test('"This is me": a clip like the user\'s voice is learned', async () => {
  await print(me, VOICE);
  const id = await utterance();
  const r = await enrollUtterance(deps(LIKE_ME), { userId, personId: me, utteranceId: id });
  expect(r).toEqual({ sampleSeconds: 2, note: null });
  expect(await printsOf(me)).toHaveLength(2);
  const [u] = await db.select().from(schema.utterances).where(eq(schema.utterances.id, id));
  expect(u).toMatchObject({ personId: me, isWearer: true });
});

test('"This is me" on an outlier: attributed, but no voiceprint', async () => {
  await print(me, VOICE);
  const id = await utterance();
  const r = await enrollUtterance(deps(UNLIKE_ME), { userId, personId: me, utteranceId: id });
  expect(r.note).toContain("no voiceprint learned");
  expect(await printsOf(me)).toHaveLength(1);
  const [u] = await db.select().from(schema.utterances).where(eq(schema.utterances.id, id));
  expect(u).toMatchObject({ personId: me, isWearer: true });
});

test('"This is me" on a clip already learned: no second copy', async () => {
  await print(me, VOICE);
  const id = await utterance();
  const r = await enrollUtterance(deps(VOICE), { userId, personId: me, utteranceId: id });
  expect(r.note).toContain("Already learned".toLowerCase());
  expect(await printsOf(me)).toHaveLength(1);
});

test('"This is me" again on the same utterance replaces its voiceprint', async () => {
  await print(me, VOICE);
  const id = await utterance();
  await enrollUtterance(deps(LIKE_ME), { userId, personId: me, utteranceId: id });
  // Not refused as a copy of itself.
  const r = await enrollUtterance(deps(LIKE_ME), { userId, personId: me, utteranceId: id });
  expect(r.note).toBeNull();
  expect(await printsOf(me)).toHaveLength(2);
});

test("the first voiceprint of the user, and other people's, aren't checked against the user", async () => {
  const first = await utterance();
  expect(
    (await enrollUtterance(deps(UNLIKE_ME), { userId, personId: me, utteranceId: first })).note,
  ).toBeNull();
  const theirs = await utterance();
  expect(
    (await enrollUtterance(deps(PARTNER), { userId, personId: partner, utteranceId: theirs })).note,
  ).toBeNull();
  expect(await printsOf(partner)).toHaveLength(1);
});

test("transcript lines: the user's own voice is tagged from their command bar", async () => {
  await print(me, VOICE);
  await print(partner, PARTNER);
  const speakers = new SpeakerDirectory(db, SPEAKER_MODEL_ID, 0.6);
  const halfway = Float32Array.from([0.55, 0, Math.sqrt(1 - 0.55 ** 2)]); // cos 0.55 with VOICE
  // Under the general threshold: not tagged…
  expect(await speakers.identify(userId, halfway)).toBeNull();
  // …but it clears the user's own bar (0.52), as a command would.
  expect(await speakers.identify(userId, halfway, 0.52)).toMatchObject({ personId: me });
  // Other people still need the general threshold.
  const nearPartner = Float32Array.from([0, 0.55, Math.sqrt(1 - 0.55 ** 2)]);
  expect(await speakers.identify(userId, nearPartner, 0.52)).toBeNull();
  // A stricter bar than the general one doesn't make tagging stricter.
  expect(await speakers.identify(userId, Float32Array.from(LIKE_ME), 0.9)).toMatchObject({
    personId: me,
  });
});
