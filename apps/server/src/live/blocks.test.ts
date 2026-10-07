import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, schema } from "@hearloom/db";
import { asc, eq } from "drizzle-orm";
import { BLOCK_MAX_MS, BLOCK_TARGET_MS, BlockTracker, SILENCE_GAP_MS } from "./blocks";

// Runs against DATABASE_URL with a throwaway user (rows cascade on delete).
const { db, client } = createDb(process.env.DATABASE_URL, { max: 2 });
const userId = `test-${crypto.randomUUID()}`;
const events: string[] = [];
const ends = new Map<string, number>();
const tracker = () =>
  new BlockTracker(db, {
    chainStarted: (_u, id) => events.push(`started:${id}`),
    chainEnded: (_u, id, live, endAt, _startAt) => {
      events.push(`ended:${id}:${live ? "live" : "backlog"}`);
      ends.set(id, endAt);
    },
    blockClosed: (_u, id) => events.push(`block:${id}`),
  });

beforeAll(async () => {
  await db.insert(schema.user).values({ id: userId, name: "test", email: `${userId}@test.local` });
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await client.end();
});

const chains = () =>
  db
    .select()
    .from(schema.chains)
    .where(eq(schema.chains.userId, userId))
    .orderBy(asc(schema.chains.startedAt));
const chainOpen = async (id: string) => (await chains()).find((c) => c.id === id)!.endedAt === null;
const blocks = (chainId: string) =>
  db
    .select()
    .from(schema.blocks)
    .where(eq(schema.blocks.chainId, chainId))
    .orderBy(asc(schema.blocks.startedAt));

const MIN = 60_000;

test("backlog goes into one closed block and reports it once the upload is quiet", async () => {
  const t = tracker();
  const now = Date.now();
  // A live conversation is going on.
  const live = await t.place(userId, now - 5_000, now - 4_000, true);
  expect(await chainOpen(live.chainId)).toBe(true);
  // Meanwhile an hour-old recording uploads: 30 utterances, 20 s apart.
  const base = now - 3600_000;
  const placed = [];
  for (let i = 0; i < 30; i++) {
    placed.push(await t.place(userId, base + i * 20_000, base + i * 20_000 + 5_000, false));
  }
  expect(new Set(placed.map((p) => p.blockId)).size).toBe(1);
  expect(new Set(placed.map((p) => p.chainId)).size).toBe(1);
  const old = placed[0]!;
  expect(old.chainId).not.toBe(live.chainId);
  // The live conversation is untouched by the backlog.
  expect(await chainOpen(live.chainId)).toBe(true);
  const [block] = await blocks(old.chainId);
  expect(block!.endedAt!.getTime()).toBe(base + 29 * 20_000 + 5_000);
  expect(block!.status).toBe("closed");

  await t.tick(Date.now() + SILENCE_GAP_MS + 1);
  expect(events).toContain(`block:${old.blockId}`);
  expect(events).toContain(`ended:${old.chainId}:backlog`);
  expect(ends.get(old.chainId)).toBe(base + 29 * 20_000 + 5_000);
  expect(ends.get(live.chainId)).toBe(now - 4_000);
  expect(events).toContain(`block:${live.blockId}`);
  expect(events).toContain(`ended:${live.chainId}:live`);
});

test("concurrent placements for one user share a chain and block", async () => {
  const t = tracker();
  const now = Date.now() + 10 * MIN;
  const [a, b] = await Promise.all([
    t.place(userId, now, now + 1000, true),
    t.place(userId, now + 2000, now + 3000, true),
  ]);
  expect(a.chainId).toBe(b.chainId);
  expect(a.blockId).toBe(b.blockId);
  await t.closeAll();
});

test("a restarted pipeline closes blocks and chains left open", async () => {
  const t = tracker();
  const at = Date.now() + 20 * MIN;
  const c = await t.place(userId, at, at + 1000, true);
  // New process: the old tracker is gone with the conversation still open in the DB.
  const fresh = tracker();
  expect(await fresh.closeOrphans()).toBeGreaterThanOrEqual(1);
  const chain = (await chains()).find((r) => r.id === c.chainId)!;
  expect(chain.status).toBe("closed");
  expect(chain.endedAt).not.toBeNull();
  const [block] = await blocks(c.chainId);
  expect(block!.status).toBe("closed");
  expect(block!.endedAt).not.toBeNull();
  expect(events).toContain(`block:${c.blockId}`);
});

test("backlog blocks stay open while held, and new backlog re-opens a refined one", async () => {
  const t = tracker();
  const base = Date.now() - 5 * 3600_000;
  t.hold(userId);
  const c = await t.place(userId, base, base + 5_000, false);
  // Long after the last placement, but a batch is still being transcribed: not finished yet.
  await t.tick(Date.now() + 10 * SILENCE_GAP_MS);
  expect(events).not.toContain(`block:${c.blockId}`);
  expect(events).not.toContain(`ended:${c.chainId}:backlog`);
  // Released: the quiet period starts at the release.
  const releasedAt = Date.now() + 10 * SILENCE_GAP_MS;
  t.release(userId, releasedAt);
  await t.tick(releasedAt + SILENCE_GAP_MS - 1);
  expect(events).not.toContain(`block:${c.blockId}`);
  await t.tick(releasedAt + SILENCE_GAP_MS + 1);
  expect(events).toContain(`block:${c.blockId}`);
  expect(events).toContain(`ended:${c.chainId}:backlog`);

  await db.update(schema.blocks).set({ status: "refined" }).where(eq(schema.blocks.id, c.blockId));
  await db.update(schema.chains).set({ status: "refined" }).where(eq(schema.chains.id, c.chainId));
  const again = await t.place(userId, base + 30_000, base + 35_000, false);
  expect(again.blockId).toBe(c.blockId);
  const [block] = await blocks(c.chainId);
  expect(block!.status).toBe("closed");
  expect(block!.endedAt!.getTime()).toBe(base + 35_000);
  const chain = (await chains()).find((r) => r.id === c.chainId)!;
  expect(chain.status).toBe("closed");
});

test("continuous speech is cut into blocks at a pause once long, keeping one chain", async () => {
  const t = tracker();
  const base = Date.now() + 2 * 24 * 3600_000;
  // A lecture: 3 s utterances every 5 s (2 s pauses) for 25 minutes.
  const placed = [];
  for (let at = base; at < base + 25 * MIN; at += 5_000) {
    placed.push(await t.place(userId, at, at + 3_000, true));
  }
  const chainIds = new Set(placed.map((p) => p.chainId));
  expect(chainIds.size).toBe(1);
  expect(new Set(placed.map((p) => p.clusters)).size).toBe(1);
  const chainId = placed[0]!.chainId;
  const rows = await blocks(chainId);
  expect(rows.map((b) => b.status)).toEqual(["closed", "closed", "open"]);
  expect(rows[0]!.startedAt.getTime()).toBe(base);
  expect(rows[1]!.startedAt.getTime()).toBe(base + BLOCK_TARGET_MS);
  expect(rows[0]!.endedAt!.getTime()).toBe(base + BLOCK_TARGET_MS - 2_000);
  // Closed blocks are reported right away; the conversation is still going.
  expect(events).toContain(`block:${rows[0]!.id}`);
  expect(events).toContain(`block:${rows[1]!.id}`);
  expect(await chainOpen(chainId)).toBe(true);
  await t.closeAll();
  expect(events).toContain(`block:${rows[2]!.id}`);
  expect(events).toContain(`ended:${chainId}:live`);
});

test("speech without pauses is cut at the maximum block length", async () => {
  const t = tracker();
  const base = Date.now() + 3 * 24 * 3600_000;
  // TV: 4 s utterances 4.5 s apart (0.5 s pauses) for 45 minutes.
  const placed = [];
  for (let at = base; at < base + 45 * MIN; at += 4_500) {
    placed.push(await t.place(userId, at, at + 4_000, true));
  }
  const rows = await blocks(placed[0]!.chainId);
  expect(rows).toHaveLength(3);
  for (const b of rows.slice(0, 2)) {
    const length = b.endedAt!.getTime() - b.startedAt.getTime();
    expect(length).toBeGreaterThan(BLOCK_MAX_MS - 5_000);
    expect(length).toBeLessThanOrEqual(BLOCK_MAX_MS);
  }
  await t.closeAll();
});

test("backlog next to a full block starts a new block of the same chain", async () => {
  const t = tracker();
  const base = Date.now() - 2 * 24 * 3600_000;
  // A 19-minute backlog recording: one block.
  const first = [];
  for (let at = base; at <= base + 19 * MIN; at += 20_000) {
    first.push(await t.place(userId, at, at + 5_000, false));
  }
  expect(new Set(first.map((p) => p.blockId)).size).toBe(1);
  // More of it, a minute later: the block would get too long, so the chain gets a new block.
  const next = await t.place(userId, base + 20 * MIN, base + 20 * MIN + 5_000, false);
  expect(next.chainId).toBe(first[0]!.chainId);
  expect(next.blockId).not.toBe(first[0]!.blockId);
  // Speech inside the first block still goes there.
  const inside = await t.place(userId, base + 5 * MIN + 1_000, base + 5 * MIN + 2_000, false);
  expect(inside.blockId).toBe(first[0]!.blockId);
  expect(await blocks(next.chainId)).toHaveLength(2);
});

test("late audio from just before a live conversation joins it", async () => {
  const t = tracker();
  const base = Date.now() + 5 * 24 * 3600_000;
  // The phone reconnects at base: what it recorded in the minute before arrives late.
  const live = await t.place(userId, base, base + 3_000, true);
  const late = await t.place(userId, base - 60_000, base - 57_000, false);
  expect(late.chainId).toBe(live.chainId);
  expect(late.blockId).toBe(live.blockId);
  await t.closeAll();
  const conv = (await chains()).find((c) => c.id === live.chainId)!;
  expect(conv.startedAt.getTime()).toBe(base - 60_000);
  const [block] = await blocks(live.chainId);
  expect(block!.startedAt.getTime()).toBe(base - 60_000);
});

test("ending a live conversation keeps a start that backlog moved earlier", async () => {
  const t = tracker();
  const base = Date.now() + 6 * 24 * 3600_000;
  const placed = [];
  for (let at = base; at < base + 12 * MIN; at += 5_000) {
    placed.push(await t.place(userId, at, at + 3_000, true));
  }
  const chainId = placed[0]!.chainId;
  // Late audio from just before the first (now closed) block.
  await t.place(userId, base - 30_000, base - 27_000, false);
  await t.closeAll();
  const conv = (await chains()).find((c) => c.id === chainId)!;
  expect(conv.startedAt.getTime()).toBe(base - 30_000);
});

test("new speaker keys of backlog in an ended conversation continue after its keys", async () => {
  const t = tracker();
  const base = Date.now() - 3 * 24 * 3600_000;
  const first = await t.place(userId, base, base + 5_000, false);
  await db.insert(schema.utterances).values({
    userId,
    blockId: first.blockId,
    startAt: new Date(base),
    endAt: new Date(base + 5_000),
    speakerKey: "S4",
    text: "hi",
    source: "refine",
    provider: "test",
  });
  await t.tick(Date.now() + SILENCE_GAP_MS + 1);
  // More backlog for the same conversation, from a new tracker (e.g. after a restart).
  const more = await tracker().place(userId, base + 10_000, base + 12_000, false);
  expect(more.chainId).toBe(first.chainId);
  expect(more.clusters.alias("soniox:x:1")).toBe("S5");
});

test("backlog in a closed block of the live chain doesn't end the live chain", async () => {
  const t = tracker();
  const base = Date.now() + 4 * 24 * 3600_000;
  const placed = [];
  for (let at = base; at < base + 12 * MIN; at += 5_000) {
    placed.push(await t.place(userId, at, at + 3_000, true));
  }
  const chainId = placed[0]!.chainId;
  const [closed] = await blocks(chainId);
  expect(closed!.status).toBe("closed");
  // Late audio from the first minutes of this conversation (e.g. a second phone).
  const late = await t.place(userId, base + MIN + 500, base + MIN + 1_500, false);
  expect(late.blockId).toBe(closed!.id);
  expect(late.clusters).toBe(placed[0]!.clusters);
  const lastAt = base + 12 * MIN;
  await t.tick(Date.now() + SILENCE_GAP_MS + 1);
  expect(events).not.toContain(`ended:${chainId}:backlog`);
  await t.tick(lastAt + SILENCE_GAP_MS + 1);
  expect(events).toContain(`ended:${chainId}:live`);
});
