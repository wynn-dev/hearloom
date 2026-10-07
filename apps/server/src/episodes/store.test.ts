import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, schema } from "@hearloom/db";
import { eq } from "drizzle-orm";
import {
  EpisodeEditError,
  episodesAt,
  episodesIn,
  episodesRefinedBy,
  mergeEpisodes,
  refinedIds,
  splitEpisode,
  updateEpisode,
} from "./store";

// Runs against DATABASE_URL with a throwaway user (rows cascade on delete).
const { db, client } = createDb(process.env.DATABASE_URL, { max: 2 });
const userId = `test-${crypto.randomUUID()}`;
const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 1, 10, 0);
const at = (min: number) => new Date(T0 + min * MIN);

beforeAll(async () => {
  await db.insert(schema.user).values({ id: userId, name: "test", email: `${userId}@test.local` });
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await client.end();
});

async function episode(
  from: number,
  to: number | null,
  kind: "conversation" | "media" = "conversation",
) {
  const [row] = await db
    .insert(schema.episodes)
    .values({ userId, startedAt: at(from), endedAt: to === null ? null : at(to), kind })
    .returning();
  return row!;
}

test("an agent can set the kind, the user can override it, the agent can't take it back", async () => {
  const e = await episode(0, 10);
  const byAgent = await updateEpisode(
    db,
    userId,
    e.id,
    { kind: "talk", title: "Standup" },
    "agent",
  );
  expect(byAgent).toMatchObject({ kind: "talk", kindSource: "agent", title: "Standup" });
  const byUser = await updateEpisode(db, userId, e.id, { kind: "conversation" }, "user");
  expect(byUser).toMatchObject({ kind: "conversation", kindSource: "user" });
  await expect(updateEpisode(db, userId, e.id, { kind: "media" }, "agent")).rejects.toThrow(
    EpisodeEditError,
  );
  // The agent may title it until the user does; an empty title clears it.
  const titled = await updateEpisode(db, userId, e.id, { title: "  ", summary: "Notes" }, "agent");
  expect(titled).toMatchObject({ title: null, summary: "Notes", textSource: "agent" });
  await updateEpisode(db, userId, e.id, { title: "Dinner with Mom" }, "user");
  await expect(
    updateEpisode(db, userId, e.id, { title: "Chat about groceries" }, "agent"),
  ).rejects.toThrow("title and summary");
  await expect(updateEpisode(db, userId, e.id, { summary: null }, "agent")).rejects.toThrow();
});

test("split an ended episode in two; open episodes and times outside it are refused", async () => {
  const e = await episode(20, 40, "media");
  const [a, b] = await splitEpisode(db, userId, e.id, at(30), "user");
  expect([a.startedAt, a.endedAt, b.startedAt, b.endedAt]).toEqual([
    at(20),
    at(30),
    at(30),
    at(40),
  ]);
  expect(b).toMatchObject({ kind: "media", boundarySource: "user" });
  await expect(splitEpisode(db, userId, a.id, at(45), "user")).rejects.toThrow("inside");
  const open = await episode(50, null);
  await expect(splitEpisode(db, userId, open.id, at(55), "user")).rejects.toThrow("ended");
  // The agent may not undo the user's cut.
  await expect(mergeEpisodes(db, userId, [a.id, b.id], "agent")).rejects.toThrow("user");
  await db.delete(schema.episodes).where(eq(schema.episodes.id, open.id));
});

test("merge two neighbouring episodes; the longer one's kind wins", async () => {
  const a = await episode(100, 130, "media");
  const b = await episode(131, 135, "conversation");
  await updateEpisode(db, userId, b.id, { title: "Call mum" }, "user");
  const merged = await mergeEpisodes(db, userId, [b.id, a.id], "user");
  expect(merged).toMatchObject({
    id: a.id,
    kind: "media",
    kindSource: "rule",
    title: "Call mum",
    textSource: "user",
    boundarySource: "user",
  });
  expect(merged.endedAt).toEqual(at(135));
  expect(await episodesIn(db, userId, at(100), at(140))).toHaveLength(1);
});

test("merging keeps the kind someone decided over the rules' longer one", async () => {
  const a = await episode(150, 180, "media");
  const b = await episode(181, 185, "conversation");
  await updateEpisode(db, userId, b.id, { kind: "talk" }, "user");
  const merged = await mergeEpisodes(db, userId, [a.id, b.id], "agent");
  expect(merged).toMatchObject({ kind: "talk", kindSource: "user", boundarySource: "agent" });
});

test("only neighbours merge", async () => {
  const a = await episode(200, 210);
  await episode(211, 215);
  const c = await episode(216, 220);
  await expect(mergeEpisodes(db, userId, [a.id, c.id], "user")).rejects.toThrow("neighbouring");
});

test("an ended episode is refined once every block it overlaps is", async () => {
  const e = await episode(300, 320);
  const [chain] = await db
    .insert(schema.chains)
    .values({ userId, startedAt: at(300), endedAt: at(320), status: "closed" })
    .returning();
  const block = async (from: number, to: number) =>
    (
      await db
        .insert(schema.blocks)
        .values({
          userId,
          chainId: chain!.id,
          startedAt: at(from),
          endedAt: at(to),
          status: "closed",
        })
        .returning()
    )[0]!;
  const b1 = await block(298, 310);
  const b2 = await block(310, 322);
  expect((await refinedIds(db, userId, [e])).has(e.id)).toBe(false);
  await db.update(schema.blocks).set({ status: "refined" }).where(eq(schema.blocks.id, b1.id));
  expect((await episodesRefinedBy(db, b1.id))?.episodes).toEqual([]);
  await db.update(schema.blocks).set({ status: "refined" }).where(eq(schema.blocks.id, b2.id));
  expect((await episodesRefinedBy(db, b2.id))?.episodes).toEqual([
    { id: e.id, kind: "conversation" },
  ]);
});

test("the episode a moment falls in", async () => {
  const a = await episode(500, 510);
  const b = await episode(510, null, "media");
  const found = await episodesAt(db, userId, [at(505), at(510), at(600), at(499)]);
  expect(found.get(at(505).getTime())).toEqual({ id: a.id, kind: "conversation" });
  expect(found.get(at(510).getTime())).toEqual({ id: b.id, kind: "media" });
  expect(found.get(at(600).getTime())?.id).toBe(b.id);
  expect(found.has(at(499).getTime())).toBe(false);
  await db.delete(schema.episodes).where(eq(schema.episodes.id, b.id));
});
