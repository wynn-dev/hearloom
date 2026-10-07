import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, schema } from "@hearloom/db";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { MINUTE, type SpeechSpan } from "../episodes/rules";
import { type Activity, EpisodeTracker, uncovered } from "./episodes";

// Runs against DATABASE_URL with a throwaway user (rows cascade on delete).
const { db, client } = createDb(process.env.DATABASE_URL, { max: 2 });
const userId = `test-${crypto.randomUUID()}`;
const activity: (Activity | null)[] = [];
const ended: string[] = [];
const checkpoints: number[] = [];
const tracker = (selfKnown = true) =>
  new EpisodeTracker(
    db,
    {
      activity: (_u, a) => activity.push(a),
      ended: (_u, id) => ended.push(id),
      changed: () => {},
      checkpoint: (_u, _id, at) => checkpoints.push(at),
    },
    async () => selfKnown,
  );

beforeAll(async () => {
  await db.insert(schema.user).values({ id: userId, name: "test", email: `${userId}@test.local` });
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await client.end();
});

const episodesBetween = (from: number, to: number) =>
  db
    .select()
    .from(schema.episodes)
    .where(
      and(
        eq(schema.episodes.userId, userId),
        gte(schema.episodes.startedAt, new Date(from)),
        lt(schema.episodes.startedAt, new Date(to)),
      ),
    )
    .orderBy(asc(schema.episodes.startedAt));

/** Speakers taking 5 s turns with 1 s pauses over [from, to). */
function turns(from: number, to: number, speakers: string[]): SpeechSpan[] {
  const out: SpeechSpan[] = [];
  let i = 0;
  for (let t = from; t + 5_000 <= to; t += 6_000) {
    const speaker = speakers[i++ % speakers.length]!;
    out.push({ startAt: t, endAt: t + 5_000, speaker, isWearer: speaker === "me" });
  }
  return out;
}

test("a live chain: dinner talk, then the TV takes over, then silence", async () => {
  const t = tracker();
  const t0 = Date.UTC(2026, 8, 1, 19, 0);
  const chain = crypto.randomUUID();
  await t.chainStarted(userId, chain, t0);
  const speech = [
    ...turns(t0, t0 + 12 * MINUTE, ["me", "sam"]),
    ...turns(t0 + 12 * MINUTE, t0 + 30 * MINUTE, ["a", "b", "c", "d"]),
  ];
  for (const s of speech) t.speech(userId, s);
  for (let m = 12; m < 30; m++) {
    t.context(userId, { at: t0 + m * MINUTE, windows: 60, scores: { tv: 0.4 } });
  }
  // Step through the minutes as they complete.
  for (let m = 1; m <= 30; m++) await t.tick(t0 + m * MINUTE + 30_000);
  await t.chainEnded(userId, chain, t0, t0 + 30 * MINUTE);

  const rows = await episodesBetween(t0, t0 + 31 * MINUTE);
  expect(rows.map((r) => r.kind)).toEqual(["conversation", "media"]);
  const cut = rows[1]!.startedAt.getTime();
  expect(Math.abs(cut - (t0 + 12 * MINUTE))).toBeLessThanOrEqual(2 * MINUTE);
  expect(rows[0]!.endedAt!.getTime()).toBe(cut);
  expect(rows[1]!.endedAt!.getTime()).toBe(t0 + 30 * MINUTE);
  expect(ended).toEqual(rows.map((r) => r.id));
  // Activity: unknown → conversation → media → nothing (never "nothing" in between).
  expect(activity.map((a) => a?.kind ?? null)).toEqual(["unknown", "conversation", "media", null]);
  expect(t.current(userId)).toBeNull();
});

test("a kind the user set on the open episode isn't re-labelled", async () => {
  const t = tracker();
  const t0 = Date.UTC(2026, 8, 2, 9, 0);
  const chain = crypto.randomUUID();
  await t.chainStarted(userId, chain, t0);
  const [open] = await episodesBetween(t0, t0 + 1);
  await db
    .update(schema.episodes)
    .set({ kind: "talk", kindSource: "user" })
    .where(eq(schema.episodes.id, open!.id));
  await t.reload(userId);
  expect(t.current(userId)?.kind).toBe("talk");
  // The rules hear a conversation throughout: what they hear doesn't change, so nothing is cut,
  // and the kind stays the user's.
  for (const s of turns(t0, t0 + 10 * MINUTE, ["me", "sam"])) t.speech(userId, s);
  for (let m = 1; m <= 10; m++) await t.tick(t0 + m * MINUTE + 30_000);
  expect(t.current(userId)?.kind).toBe("talk");
  await t.chainEnded(userId, chain, t0, t0 + 10 * MINUTE);
  const rows = await episodesBetween(t0, t0 + 11 * MINUTE);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "talk", kindSource: "user" });
});

test("backlog chains are segmented from stored speech, around episodes someone edited", async () => {
  const t = tracker();
  const t0 = Date.UTC(2026, 8, 3, 14, 0);
  const t1 = t0 + 40 * MINUTE;
  const [chain] = await db
    .insert(schema.chains)
    .values({ userId, startedAt: new Date(t0), endedAt: new Date(t1), status: "closed" })
    .returning({ id: schema.chains.id });
  const speech = [
    ...turns(t0, t0 + 20 * MINUTE, ["prof"]),
    ...turns(t0 + 20 * MINUTE, t1, ["me", "alice"]),
  ];
  await db.insert(schema.utterances).values(
    speech.map((s, i) => ({
      userId,
      startAt: new Date(s.startAt),
      endAt: new Date(s.endAt),
      speakerKey: s.speaker === "me" ? null : s.speaker,
      isWearer: s.isWearer,
      text: `line ${i}`,
      source: "live" as const,
      provider: "test",
    })),
  );
  // A rule-made episode (replaced) and one the user titled (kept).
  await db.insert(schema.episodes).values([
    { userId, startedAt: new Date(t0), endedAt: new Date(t0 + 5 * MINUTE) },
    {
      userId,
      startedAt: new Date(t0 + 30 * MINUTE),
      endedAt: new Date(t1),
      kind: "conversation",
      title: "Coffee with Alice",
    },
  ]);
  ended.length = 0;
  await t.segmentChain(userId, chain!.id);

  const rows = await episodesBetween(t0, t1);
  expect(rows.map((r) => [r.kind, r.title])).toEqual([
    ["talk", null],
    ["conversation", null],
    ["conversation", "Coffee with Alice"],
  ]);
  expect(rows[0]!.startedAt.getTime()).toBe(t0);
  expect(Math.abs(rows[1]!.startedAt.getTime() - (t0 + 20 * MINUTE))).toBeLessThanOrEqual(
    2 * MINUTE,
  );
  expect(rows[1]!.endedAt!.getTime()).toBe(t0 + 30 * MINUTE);
  expect(ended).toHaveLength(2);

  // More backlog for the chain, segmented again: the same episodes (ids), nothing re-announced.
  ended.length = 0;
  await t.segmentChain(userId, chain!.id);
  expect((await episodesBetween(t0, t1)).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  expect(ended).toHaveLength(0);
});

test("a late end of the previous chain doesn't end the next one", async () => {
  const t = tracker();
  const t0 = Date.UTC(2026, 8, 7, 9, 0);
  const [c1, c2] = [crypto.randomUUID(), crypto.randomUUID()];
  await t.chainStarted(userId, c1, t0);
  for (const s of turns(t0, t0 + 2 * MINUTE, ["me", "sam"])) t.speech(userId, s);
  // The next chain is reported before the first one's end (shouldn't happen, but mustn't hurt).
  await t.chainStarted(userId, c2, t0 + 5 * MINUTE);
  await t.chainEnded(userId, c1, t0, t0 + 2 * MINUTE);
  expect(t.current(userId)?.since).toBe(t0 + 5 * MINUTE);
  const rows = await episodesBetween(t0, t0 + 6 * MINUTE);
  // Ended at its last speech, then (when its end arrives) grown to the chain's end.
  expect(rows.map((r) => r.endedAt?.getTime() ?? null)).toEqual([t0 + 2 * MINUTE, null]);
  await t.chainEnded(userId, c2, t0 + 5 * MINUTE, t0 + 6 * MINUTE);
});

test("speech that backlog added before a live chain's first episode is covered when it ends", async () => {
  const t = tracker();
  const t0 = Date.UTC(2026, 8, 8, 9, 0);
  const chain = crypto.randomUUID();
  await t.chainStarted(userId, chain, t0);
  // Backlog moved the chain's start a minute earlier.
  await t.chainEnded(userId, chain, t0 - MINUTE, t0 + 3 * MINUTE);
  const rows = await episodesBetween(t0 - 2 * MINUTE, t0 + 4 * MINUTE);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.startedAt.getTime()).toBe(t0 - MINUTE);
  expect(rows[0]!.endedAt!.getTime()).toBe(t0 + 3 * MINUTE);
});

test("a restart ends episodes left open at their last speech", async () => {
  const t0 = Date.UTC(2026, 8, 4, 8, 0);
  const [ep] = await db
    .insert(schema.episodes)
    .values({ userId, startedAt: new Date(t0) })
    .returning();
  await db.insert(schema.utterances).values({
    userId,
    startAt: new Date(t0 + 1_000),
    endAt: new Date(t0 + 4_000),
    text: "hi",
    source: "live",
    provider: "test",
  });
  ended.length = 0;
  expect(await tracker().closeOrphans()).toBeGreaterThanOrEqual(1);
  expect(ended).toContain(ep!.id);
  const [row] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, ep!.id));
  expect(row!.endedAt!.getTime()).toBe(t0 + 4_000);
});

test("a long episode reports a checkpoint every 15 minutes", async () => {
  const t = tracker();
  const t0 = Date.UTC(2026, 8, 5, 9, 0);
  checkpoints.length = 0;
  await t.chainStarted(userId, t0);
  for (const s of turns(t0, t0 + 40 * MINUTE, ["prof"])) t.speech(userId, s);
  for (let m = 1; m <= 40; m++) await t.tick(t0 + m * MINUTE + 30_000);
  expect(checkpoints).toEqual([t0 + 15 * MINUTE, t0 + 30 * MINUTE]);
  await t.chainEnded(userId, t0 + 40 * MINUTE);
});

test("a long sound state without speech becomes a sound episode around existing ones", async () => {
  const t = tracker();
  const t0 = Date.UTC(2026, 8, 6, 18, 0);
  // A conversation in the middle of an hour of music.
  await db.insert(schema.episodes).values({
    userId,
    startedAt: new Date(t0 + 20 * MINUTE),
    endedAt: new Date(t0 + 25 * MINUTE),
    kind: "conversation",
  });
  ended.length = 0;
  await t.soundEnded(userId, t0, t0 + 60 * MINUTE);
  const rows = await episodesBetween(t0, t0 + 60 * MINUTE);
  expect(
    rows.map((r) => [
      r.kind,
      (r.startedAt.getTime() - t0) / MINUTE,
      (r.endedAt!.getTime() - t0) / MINUTE,
    ]),
  ).toEqual([
    ["sound", 0, 20],
    ["conversation", 20, 25],
    ["sound", 25, 60],
  ]);
  expect(ended).toHaveLength(2);
  // Short states, or what's left of them, don't count.
  await t.soundEnded(userId, t0 + 2 * 3600_000, t0 + 2 * 3600_000 + 10 * MINUTE);
  expect(await episodesBetween(t0 + 2 * 3600_000, t0 + 3 * 3600_000)).toHaveLength(0);
});

test("uncovered parts of a range", () => {
  expect(
    uncovered(0, 100_000, [
      [10_000, 20_000],
      [15_000, 30_000],
      [90_000, Number.POSITIVE_INFINITY],
    ]),
  ).toEqual([
    [0, 10_000],
    [30_000, 90_000],
  ]);
  expect(uncovered(0, 10_000, [[0, 9_500]])).toEqual([]);
});
