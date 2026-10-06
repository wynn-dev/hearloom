import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { SpeakerClusters } from "./speakers";

/** Silence longer than this ends a conversation. */
export const CONVERSATION_GAP_MS = 120_000;

interface Open {
  id: string;
  startedAt: number;
  lastEndAt: number;
  languages: Set<string>;
  speakers: Set<string>;
  clusters: SpeakerClusters;
  fresh: boolean;
}

export interface ConversationEvents {
  started(userId: string, id: string): void;
  ended(userId: string, id: string): void;
}

/**
 * Rule-based conversations per user: consecutive utterances less than CONVERSATION_GAP_MS apart
 * belong together. Conversations are rows in Postgres so utterances can reference them.
 */
export class ConversationTracker {
  private open = new Map<string, Open>();

  constructor(
    private readonly db: Db,
    private readonly events: ConversationEvents,
    private readonly clusterThreshold = 0.6,
  ) {}

  /** Returns the conversation for an utterance (and its speaker clusters). */
  async place(
    userId: string,
    startAt: number,
    endAt: number,
    fresh: boolean,
  ): Promise<{ id: string; clusters: SpeakerClusters }> {
    const cur = this.open.get(userId);
    if (cur && startAt >= cur.lastEndAt - 5000 && startAt - cur.lastEndAt <= CONVERSATION_GAP_MS) {
      cur.lastEndAt = Math.max(cur.lastEndAt, endAt);
      cur.fresh = fresh;
      return cur;
    }
    if (cur && startAt < cur.startedAt - 5000) {
      // Late audio (backlog upload) from before the current conversation.
      return {
        id: await this.historical(userId, startAt, endAt),
        clusters: new SpeakerClusters(this.clusterThreshold),
      };
    }
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
      fresh,
    };
    this.open.set(userId, next);
    if (fresh) this.events.started(userId, next.id);
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
    return !!cur && cur.fresh && now - cur.lastEndAt <= CONVERSATION_GAP_MS;
  }

  /** Close conversations that have been quiet long enough. */
  async tick(now = Date.now()): Promise<void> {
    for (const [userId, cur] of this.open) {
      const quiet = cur.fresh ? now - cur.lastEndAt : Number.POSITIVE_INFINITY;
      if (quiet > CONVERSATION_GAP_MS) await this.close(userId, cur);
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
        endedAt: new Date(cur.lastEndAt),
        status: "closed",
        languages: [...cur.languages],
        speakerCount: cur.speakers.size,
      })
      .where(eq(schema.conversations.id, cur.id));
    if (cur.fresh) this.events.ended(userId, cur.id);
  }

  private async historical(userId: string, startAt: number, endAt: number): Promise<string> {
    const at = new Date(startAt);
    const [hit] = await this.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.userId, userId),
          lte(schema.conversations.startedAt, new Date(startAt + CONVERSATION_GAP_MS)),
          or(
            isNull(schema.conversations.endedAt),
            gte(schema.conversations.endedAt, new Date(startAt - CONVERSATION_GAP_MS)),
          ),
        ),
      )
      .orderBy(desc(schema.conversations.startedAt))
      .limit(1);
    if (hit) return hit.id;
    const [row] = await this.db
      .insert(schema.conversations)
      .values({ userId, startedAt: at, endedAt: new Date(endAt), status: "closed" })
      .returning({ id: schema.conversations.id });
    return row!.id;
  }
}
