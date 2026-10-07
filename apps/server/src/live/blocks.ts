import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { SpeakerClusters } from "./speakers";

/** Silence longer than this ends a chain (a conversation) and its block. */
export const SILENCE_GAP_MS = 120_000;
/** A block this long closes at the next pause of at least BLOCK_PAUSE_MS between utterances… */
export const BLOCK_TARGET_MS = 10 * 60_000;
export const BLOCK_PAUSE_MS = 1500;
/** …and before any utterance that would make it longer than this, pause or not. */
export const BLOCK_MAX_MS = 20 * 60_000;
/**
 * How far back the backlog lookup scans for a block start (bounds the index scan). Blocks are at
 * most BLOCK_MAX_MS long, but conversations from before blocks existed became one block each.
 */
const LOOKBACK_MS = 24 * 3600_000;

interface OpenBlock {
  id: string;
  startedAt: number;
  lastEndAt: number;
}

/** The user's live chain: continuous speech, cut into blocks. Its id is its conversation's id. */
interface Chain {
  id: string;
  startedAt: number;
  lastEndAt: number;
  languages: Set<string>;
  speakers: Set<string>;
  /** Speaker keys are per chain, so they stay the same across its blocks. */
  clusters: SpeakerClusters;
  block: OpenBlock;
}

/** A closed block or chain that backlog audio was just added to. */
interface Touched {
  userId: string;
  at: number;
}

interface TouchedChain extends Touched {
  clusters: SpeakerClusters;
}

export interface Placement {
  chainId: string;
  blockId: string;
  clusters: SpeakerClusters;
}

export interface BlockEvents {
  /** The user's live chain (a conversation) started. */
  chainStarted(userId: string, chainId: string): void;
  /** `live`: the user's current chain ended (vs. one rebuilt from uploaded backlog). */
  chainEnded(userId: string, chainId: string, live: boolean): void;
  /** A block is complete and can be refined. */
  blockClosed(userId: string, blockId: string): void;
}

/**
 * Rule-based segmentation per user. Consecutive utterances less than SILENCE_GAP_MS apart form a
 * chain (stored as a conversation); a chain is cut into blocks of at most BLOCK_MAX_MS so the
 * refine pass never waits for, or works on, hours of continuous speech. Chains and blocks are rows
 * in Postgres so utterances can reference them.
 *
 * Live audio drives the user's open chain. Backlog (audio uploaded late, e.g. after the phone was
 * offline) is placed into the closed block it falls in, extending it, or a new closed block; those
 * report `blockClosed` / `chainEnded` once their upload goes quiet and none of the user's backlog is
 * still being transcribed (see `hold`).
 */
export class BlockTracker {
  private open = new Map<string, Chain>();
  private touchedBlocks = new Map<string, Touched>();
  private touchedChains = new Map<string, TouchedChain>();
  private holds = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly events: BlockEvents,
    private readonly clusterThreshold = 0.6,
  ) {}

  /** Close blocks and chains left open by a previous process (it can't extend them anymore). */
  async closeOrphans(): Promise<number> {
    const { blocks, conversations, utterances } = schema;
    const closedBlocks = await this.db
      .update(blocks)
      .set({
        status: "closed",
        endedAt: sql`coalesce((select max(${utterances.endAt}) from ${utterances} where ${utterances.blockId} = ${blocks.id}), ${blocks.startedAt})`,
      })
      .where(isNull(blocks.endedAt))
      .returning({ id: blocks.id, userId: blocks.userId });
    const chains = await this.db
      .update(conversations)
      .set({
        status: "closed",
        endedAt: sql`coalesce((select max(${utterances.endAt}) from ${utterances} where ${utterances.conversationId} = ${conversations.id}), ${conversations.startedAt})`,
      })
      .where(isNull(conversations.endedAt))
      .returning({ id: conversations.id, userId: conversations.userId });
    for (const r of closedBlocks) this.events.blockClosed(r.userId, r.id);
    for (const r of chains) this.events.chainEnded(r.userId, r.id, false);
    return chains.length;
  }

  /** Returns the chain and block for an utterance (and the chain's speaker clusters). */
  place(userId: string, startAt: number, endAt: number, fresh: boolean): Promise<Placement> {
    // Serialized per user: two streams (live + backlog) must not race on the open chain.
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
  ): Promise<Placement> {
    const cur = this.open.get(userId);
    if (
      cur &&
      startAt <= cur.lastEndAt + SILENCE_GAP_MS &&
      endAt >= cur.startedAt - SILENCE_GAP_MS &&
      // Late audio from before the open block belongs in one of the chain's closed blocks.
      (fresh || endAt >= cur.block.startedAt)
    ) {
      cur.startedAt = Math.min(cur.startedAt, startAt);
      cur.lastEndAt = Math.max(cur.lastEndAt, endAt);
      await this.extendBlock(userId, cur, startAt, endAt);
      return { chainId: cur.id, blockId: cur.block.id, clusters: cur.clusters };
    }
    if (!fresh || (cur && endAt < cur.startedAt)) return this.backlog(userId, startAt, endAt);

    if (cur) await this.close(userId, cur);
    const [row] = await this.db
      .insert(schema.conversations)
      .values({ userId, startedAt: new Date(startAt), status: "open" })
      .returning({ id: schema.conversations.id });
    const next: Chain = {
      id: row!.id,
      startedAt: startAt,
      lastEndAt: endAt,
      languages: new Set(),
      speakers: new Set(),
      clusters: new SpeakerClusters(this.clusterThreshold),
      block: await this.openBlock(userId, row!.id, startAt, endAt),
    };
    this.open.set(userId, next);
    this.events.chainStarted(userId, next.id);
    return { chainId: next.id, blockId: next.block.id, clusters: next.clusters };
  }

  /** Add an utterance to the chain's open block, or start the next block if this one is long. */
  private async extendBlock(
    userId: string,
    chain: Chain,
    startAt: number,
    endAt: number,
  ): Promise<void> {
    const b = chain.block;
    const age = startAt - b.startedAt;
    const pause = startAt - b.lastEndAt;
    const tooLong = Math.max(b.lastEndAt, endAt) - b.startedAt > BLOCK_MAX_MS;
    if (tooLong || (age >= BLOCK_TARGET_MS && pause >= BLOCK_PAUSE_MS)) {
      await this.closeBlock(userId, b);
      chain.block = await this.openBlock(userId, chain.id, startAt, endAt);
      return;
    }
    b.startedAt = Math.min(b.startedAt, startAt);
    b.lastEndAt = Math.max(b.lastEndAt, endAt);
  }

  private async openBlock(
    userId: string,
    chainId: string,
    startAt: number,
    endAt: number,
  ): Promise<OpenBlock> {
    const [row] = await this.db
      .insert(schema.blocks)
      .values({ userId, chainId, startedAt: new Date(startAt), status: "open" })
      .returning({ id: schema.blocks.id });
    return { id: row!.id, startedAt: startAt, lastEndAt: endAt };
  }

  private async closeBlock(userId: string, b: OpenBlock): Promise<void> {
    await this.db
      .update(schema.blocks)
      .set({
        startedAt: new Date(b.startedAt),
        endedAt: new Date(b.lastEndAt),
        status: "closed",
      })
      .where(eq(schema.blocks.id, b.id));
    this.events.blockClosed(userId, b.id);
  }

  /** Record language/speaker of a placed utterance (persisted when the chain closes). */
  note(userId: string, chainId: string, lang: string | null, speaker: string | null): void {
    const cur = this.open.get(userId);
    if (!cur || cur.id !== chainId) return;
    if (lang) cur.languages.add(lang);
    if (speaker) cur.speakers.add(speaker);
  }

  inConversation(userId: string, now = Date.now()): boolean {
    const cur = this.open.get(userId);
    return !!cur && now - cur.lastEndAt <= SILENCE_GAP_MS;
  }

  /**
   * Backlog audio for this user is waiting to be transcribed: don't report their backlog blocks
   * and chains as finished (which queues the refine pass) until it has been placed. Pair with
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
    for (const t of [...this.touchedBlocks.values(), ...this.touchedChains.values()]) {
      if (t.userId === userId) t.at = Math.max(t.at, now);
    }
  }

  /** Close chains that have been quiet long enough; report backlog that has gone quiet. */
  async tick(now = Date.now()): Promise<void> {
    for (const [userId, cur] of this.open) {
      if (now - cur.lastEndAt > SILENCE_GAP_MS) await this.close(userId, cur);
    }
    const quiet = (t: Touched) => now - t.at > SILENCE_GAP_MS && !this.holds.has(t.userId);
    for (const [id, t] of this.touchedBlocks) {
      if (!quiet(t)) continue;
      this.touchedBlocks.delete(id);
      this.events.blockClosed(t.userId, id);
    }
    for (const [id, t] of this.touchedChains) {
      if (!quiet(t)) continue;
      this.touchedChains.delete(id);
      this.events.chainEnded(t.userId, id, false);
    }
  }

  async closeAll(): Promise<void> {
    for (const [userId, cur] of this.open) await this.close(userId, cur);
  }

  private async close(userId: string, cur: Chain): Promise<void> {
    if (this.open.get(userId) === cur) this.open.delete(userId);
    await this.closeBlock(userId, cur.block);
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
    this.events.chainEnded(userId, cur.id, true);
  }

  /**
   * Place late audio in the closed block it falls in or next to (extending it while it stays
   * under BLOCK_MAX_MS), else in a new block of that block's chain, else in a new chain.
   */
  private async backlog(userId: string, startAt: number, endAt: number): Promise<Placement> {
    const { blocks: b, conversations: c } = schema;
    const near = await this.db
      .select({ id: b.id, chainId: b.chainId, startedAt: b.startedAt, endedAt: b.endedAt })
      .from(b)
      .where(
        and(
          eq(b.userId, userId),
          isNotNull(b.endedAt),
          lte(b.startedAt, new Date(endAt + SILENCE_GAP_MS)),
          gte(b.startedAt, new Date(startAt - LOOKBACK_MS)),
          gte(b.endedAt, new Date(startAt - SILENCE_GAP_MS)),
        ),
      )
      .orderBy(desc(b.startedAt))
      .limit(20);
    const gap = (r: (typeof near)[number]) =>
      Math.max(0, r.startedAt.getTime() - endAt, startAt - r.endedAt!.getTime());
    const hit = near.sort((x, y) => gap(x) - gap(y))[0];

    let blockId: string;
    let chainId: string;
    const span = hit
      ? Math.max(hit.endedAt!.getTime(), endAt) - Math.min(hit.startedAt.getTime(), startAt)
      : 0;
    if (hit && (gap(hit) === 0 || span <= BLOCK_MAX_MS)) {
      ({ id: blockId, chainId } = hit);
      await this.db
        .update(b)
        .set({
          startedAt: sql`least(${b.startedAt}, ${new Date(startAt).toISOString()}::timestamptz)`,
          endedAt: sql`greatest(${b.endedAt}, ${new Date(endAt).toISOString()}::timestamptz)`,
          // Already refined: the new speech needs another pass (queued once this upload is quiet).
          status: sql`case when ${b.status} = 'refined' then 'closed' else ${b.status} end`,
        })
        .where(eq(b.id, blockId));
    } else {
      if (hit) {
        chainId = hit.chainId;
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
        chainId = row!.id;
      }
      const [row] = await this.db
        .insert(b)
        .values({
          userId,
          chainId,
          startedAt: new Date(startAt),
          endedAt: new Date(endAt),
          status: "closed",
        })
        .returning({ id: b.id });
      blockId = row!.id;
    }
    // The chain's conversation covers the new speech (an open one keeps its open end).
    await this.db
      .update(c)
      .set({
        startedAt: sql`least(${c.startedAt}, ${new Date(startAt).toISOString()}::timestamptz)`,
        endedAt: sql`case when ${c.endedAt} is null then null else greatest(${c.endedAt}, ${new Date(endAt).toISOString()}::timestamptz) end`,
        status: sql`case when ${c.status} = 'refined' then 'closed' else ${c.status} end`,
      })
      .where(eq(c.id, chainId));

    const now = Date.now();
    this.touchedBlocks.set(blockId, { userId, at: now });
    const live = this.open.get(userId);
    // A closed block of the live chain: the chain's end is reported live, with its own clusters.
    if (live?.id === chainId) return { chainId, blockId, clusters: live.clusters };
    const t = this.touchedChains.get(chainId) ?? {
      userId,
      at: 0,
      clusters: new SpeakerClusters(this.clusterThreshold),
    };
    t.at = now;
    this.touchedChains.set(chainId, t);
    return { chainId, blockId, clusters: t.clusters };
  }
}
