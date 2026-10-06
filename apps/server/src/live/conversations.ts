import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { SpeakerClusters } from "./speakers";

/** Silence longer than this ends a conversation. */
export const CONVERSATION_GAP_MS = 120_000;
/** Longest conversation the backlog lookup considers (bounds the index scan). */
const MAX_CONVERSATION_MS = 24 * 3600_000;

interface Open {
  id: string;
  startedAt: number;
  lastEndAt: number;
  languages: Set<string>;
  speakers: Set<string>;
  clusters: SpeakerClusters;
}

/** A closed conversation that backlog audio was just added to. */
interface Touched {
  userId: string;
  at: number;
  clusters: SpeakerClusters;
}

export interface ConversationEvents {
  started(userId: string, id: string): void;
  /** `live`: the user's current conversation ended (vs. one rebuilt from uploaded backlog). */
  ended(userId: string, id: string, live: boolean): void;
}

/**
 * Rule-based conversations per user: consecutive utterances less than CONVERSATION_GAP_MS apart
 * belong together. Conversations are rows in Postgres so utterances can reference them.
 *
 * Live audio drives the user's open conversation. Backlog (audio uploaded late, e.g. after the
 * phone was offline) is placed into the closed conversation it falls in, extending it, or a new
 * closed one; those report `ended` once their upload goes quiet and none of the user's backlog is
 * still being transcribed (see `hold`).
 */
export class ConversationTracker {
  private open = new Map<string, Open>();
  private touched = new Map<string, Touched>();
  private holds = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly events: ConversationEvents,
    private readonly clusterThreshold = 0.6,
  ) {}

  /** Close conversations left open by a previous process (it can't extend them anymore). */
  async closeOrphans(): Promise<number> {
    const rows = await this.db
      .update(schema.conversations)
      .set({
        status: "closed",
        endedAt: sql`coalesce((select max(${schema.utterances.endAt}) from ${schema.utterances} where ${schema.utterances.conversationId} = ${schema.conversations.id}), ${schema.conversations.startedAt})`,
      })
      .where(isNull(schema.conversations.endedAt))
      .returning({ id: schema.conversations.id, userId: schema.conversations.userId });
    for (const r of rows) this.events.ended(r.userId, r.id, false);
    return rows.length;
  }

  /** Returns the conversation for an utterance (and its speaker clusters). */
  place(
    userId: string,
    startAt: number,
    endAt: number,
    fresh: boolean,
  ): Promise<{ id: string; clusters: SpeakerClusters }> {
    // Serialized per user: two streams (live + backlog) must not race on the open conversation.
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const run = prev.then(
      () => this.placeNow(userId, startAt, endAt, fresh),
      () => this.placeNow(userId, startAt, endAt, fresh),
    );
    const tail = run.catch(() => {});
    this.locks.set(userId, tail);
    void tail.then(() => {
      if (this.locks.get(userId) === tail) this.locks.delete(userId);
    });
    return run;
  }

  private async placeNow(
    userId: string,
    startAt: number,
    endAt: number,
    fresh: boolean,
  ): Promise<{ id: string; clusters: SpeakerClusters }> {
    const cur = this.open.get(userId);
    if (
      cur &&
      startAt <= cur.lastEndAt + CONVERSATION_GAP_MS &&
      endAt >= cur.startedAt - CONVERSATION_GAP_MS
    ) {
      cur.startedAt = Math.min(cur.startedAt, startAt);
      cur.lastEndAt = Math.max(cur.lastEndAt, endAt);
      return cur;
    }
    if (!fresh || (cur && endAt < cur.startedAt)) return this.backlog(userId, startAt, endAt);

    if (cur) await this.close(userId, cur);
    const [row] = await this.db
      .insert(schema.conversations)
      .values({ userId, startedAt: new Date(startAt), status: "open" })
      .returning({ id: schema.conversations.id });
    const next: Open = {
      id: row!.id,
      startedAt: startAt,
      lastEndAt: endAt,
      languages: new Set(),
      speakers: new Set(),
      clusters: new SpeakerClusters(this.clusterThreshold),
    };
    this.open.set(userId, next);
    this.events.started(userId, next.id);
    return next;
  }

  /** Record language/speaker of a placed utterance (persisted on close and periodically). */
  note(userId: string, conversationId: string, lang: string | null, speaker: string | null): void {
    const cur = this.open.get(userId);
    if (!cur || cur.id !== conversationId) return;
    if (lang) cur.languages.add(lang);
    if (speaker) cur.speakers.add(speaker);
  }

  inConversation(userId: string, now = Date.now()): boolean {
    const cur = this.open.get(userId);
    return !!cur && now - cur.lastEndAt <= CONVERSATION_GAP_MS;
  }

  /**
   * Backlog audio for this user is waiting to be transcribed: don't report their backlog
   * conversations as ended (which queues the refine pass) until it has been placed. Pair with
   * `release`.
   */
  hold(userId: string): void {
    this.holds.set(userId, (this.holds.get(userId) ?? 0) + 1);
  }

  release(userId: string, now = Date.now()): void {
    const n = (this.holds.get(userId) ?? 1) - 1;
    if (n > 0) this.holds.set(userId, n);
    else this.holds.delete(userId);
    // The quiet period starts now, not at the last placement before the wait.
    for (const t of this.touched.values()) if (t.userId === userId) t.at = Math.max(t.at, now);
  }

  /** Close conversations that have been quiet long enough. */
  async tick(now = Date.now()): Promise<void> {
    for (const [userId, cur] of this.open) {
      if (now - cur.lastEndAt > CONVERSATION_GAP_MS) await this.close(userId, cur);
    }
    for (const [id, t] of this.touched) {
      if (now - t.at <= CONVERSATION_GAP_MS || this.holds.has(t.userId)) continue;
      this.touched.delete(id);
      this.events.ended(t.userId, id, false);
    }
  }

  async closeAll(): Promise<void> {
    for (const [userId, cur] of this.open) await this.close(userId, cur);
  }

  private async close(userId: string, cur: Open): Promise<void> {
    if (this.open.get(userId) === cur) this.open.delete(userId);
    await this.db
      .update(schema.conversations)
      .set({
        startedAt: new Date(cur.startedAt),
        endedAt: new Date(cur.lastEndAt),
        status: "closed",
        languages: [...cur.languages],
        speakerCount: cur.speakers.size,
      })
      .where(eq(schema.conversations.id, cur.id));
    this.events.ended(userId, cur.id, true);
  }

  /** Place late audio in the closed conversation it belongs to (extending it), or a new one. */
  private async backlog(
    userId: string,
    startAt: number,
    endAt: number,
  ): Promise<{ id: string; clusters: SpeakerClusters }> {
    const c = schema.conversations;
    const [hit] = await this.db
      .select({ id: c.id })
      .from(c)
      .where(
        and(
          eq(c.userId, userId),
          lte(c.startedAt, new Date(endAt + CONVERSATION_GAP_MS)),
          gte(c.startedAt, new Date(startAt - MAX_CONVERSATION_MS)),
          gte(c.endedAt, new Date(startAt - CONVERSATION_GAP_MS)),
        ),
      )
      .orderBy(desc(c.startedAt))
      .limit(1);
    let id: string;
    if (hit) {
      id = hit.id;
      await this.db
        .update(c)
        .set({
          startedAt: sql`least(${c.startedAt}, ${new Date(startAt).toISOString()}::timestamptz)`,
          endedAt: sql`greatest(${c.endedAt}, ${new Date(endAt).toISOString()}::timestamptz)`,
          // Already refined: the new speech needs another pass (queued once this upload is quiet).
          status: sql`case when ${c.status} = 'refined' then 'closed' else ${c.status} end`,
        })
        .where(eq(c.id, id));
    } else {
      const [row] = await this.db
        .insert(c)
        .values({
          userId,
          startedAt: new Date(startAt),
          endedAt: new Date(endAt),
          status: "closed",
        })
        .returning({ id: c.id });
      id = row!.id;
    }
    const t = this.touched.get(id) ?? {
      userId,
      at: 0,
      clusters: new SpeakerClusters(this.clusterThreshold),
    };
    t.at = Date.now();
    this.touched.set(id, t);
    return { id, clusters: t.clusters };
  }
}
