import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDb, schema } from "@hearloom/db";
import { asc, eq } from "drizzle-orm";
import { CONVERSATION_GAP_MS, ConversationTracker } from "./conversations";

// Runs against DATABASE_URL with a throwaway user (rows cascade on delete).
const { db, client } = createDb(process.env.DATABASE_URL, { max: 2 });
const userId = `test-${crypto.randomUUID()}`;
const events: string[] = [];
const tracker = () =>
  new ConversationTracker(db, {
    started: (_u, id) => events.push(`started:${id}`),
    ended: (_u, id, live) => events.push(`ended:${id}:${live ? "live" : "backlog"}`),
  });

beforeAll(async () => {
  await db.insert(schema.user).values({ id: userId, name: "test", email: `${userId}@test.local` });
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await client.end();
});

const rows = () =>
  db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.userId, userId))
    .orderBy(asc(schema.conversations.startedAt));

test("backlog goes into one closed conversation and reports it once the upload is quiet", async () => {
  const t = tracker();
  const now = Date.now();
  // A live conversation is going on.
  const live = await t.place(userId, now - 5_000, now - 4_000, true);
  expect(t.inConversation(userId, now)).toBe(true);
  // Meanwhile an hour-old recording uploads: 30 utterances, 20 s apart.
  const base = now - 3600_000;
  const ids = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const c = await t.place(userId, base + i * 20_000, base + i * 20_000 + 5_000, false);
    ids.add(c.id);
  }
  expect(ids.size).toBe(1);
  expect(ids.has(live.id)).toBe(false);
  // The live conversation is untouched by the backlog.
  expect(t.inConversation(userId, now)).toBe(true);
  const [old] = (await rows()).filter((r) => r.id !== live.id);
  expect(old!.endedAt!.getTime()).toBe(base + 29 * 20_000 + 5_000);

  await t.tick(Date.now() + CONVERSATION_GAP_MS + 1);
  expect(events).toContain(`ended:${old!.id}:backlog`);
  expect(events).toContain(`ended:${live.id}:live`);
});

test("concurrent placements for one user share a conversation", async () => {
  const t = tracker();
  const now = Date.now() + 10 * 60_000;
  const [a, b] = await Promise.all([
    t.place(userId, now, now + 1000, true),
    t.place(userId, now + 2000, now + 3000, true),
  ]);
  expect(a.id).toBe(b.id);
  await t.closeAll();
});

test("a restarted pipeline closes conversations left open", async () => {
  const t = tracker();
  const at = Date.now() + 20 * 60_000;
  const c = await t.place(userId, at, at + 1000, true);
  // New process: the old tracker is gone with the conversation still open in the DB.
  const fresh = tracker();
  expect(await fresh.closeOrphans()).toBeGreaterThanOrEqual(1);
  const row = (await rows()).find((r) => r.id === c.id)!;
  expect(row.status).toBe("closed");
  expect(row.endedAt).not.toBeNull();
});

test("backlog conversations stay open while held, and new backlog re-opens a refined one", async () => {
  const t = tracker();
  const base = Date.now() - 5 * 3600_000;
  t.hold(userId);
  const c = await t.place(userId, base, base + 5_000, false);
  // Long after the last placement, but a batch is still being transcribed: not ended yet.
  await t.tick(Date.now() + 10 * CONVERSATION_GAP_MS);
  expect(events).not.toContain(`ended:${c.id}:backlog`);
  // Released: the quiet period starts at the release.
  const releasedAt = Date.now() + 10 * CONVERSATION_GAP_MS;
  t.release(userId, releasedAt);
  await t.tick(releasedAt + CONVERSATION_GAP_MS - 1);
  expect(events).not.toContain(`ended:${c.id}:backlog`);
  await t.tick(releasedAt + CONVERSATION_GAP_MS + 1);
  expect(events).toContain(`ended:${c.id}:backlog`);

  await db
    .update(schema.conversations)
    .set({ status: "refined" })
    .where(eq(schema.conversations.id, c.id));
  const again = await t.place(userId, base + 30_000, base + 35_000, false);
  expect(again.id).toBe(c.id);
  const row = (await rows()).find((r) => r.id === c.id)!;
  expect(row.status).toBe("closed");
  expect(row.endedAt!.getTime()).toBe(base + 35_000);
});
