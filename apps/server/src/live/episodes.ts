import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import type { EpisodeKind } from "@hearloom/shared";
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  type ContextMinute,
  classify,
  cutPoint,
  MIN_EPISODE_MS,
  MINUTE,
  type SegmentAction,
  Segmenter,
  type SpeechSpan,
  segmentRange,
  WINDOW_MS,
  windowFeatures,
} from "../episodes/rules";

/** What the user is in right now. */
export interface Activity {
  episodeId: string;
  kind: EpisodeKind;
  /** When the episode started (unix ms). */
  since: number;
}

export interface EpisodeEvents {
  /** The user's current episode started, changed kind, or ended (null). */
  activity(userId: string, activity: Activity | null): void;
  /** An episode ended: live, or rebuilt from backlog. */
  ended(userId: string, episodeId: string): void;
  /** Episodes changed: refresh what clients show. */
  changed(userId: string): void;
  /** An open episode has been going on for another CHECKPOINT_MS (long talks, TV evenings). */
  checkpoint(userId: string, episodeId: string, at: number): void;
}

/** Utterances are final a little after they're spoken: classify a minute once it's this old. */
const LAG_MS = 20_000;
/** Speech and context kept per user for classifying the open episode. */
const KEEP_MS = 10 * MINUTE;
/** A long open episode reports progress this often (`episode.checkpoint`). */
export const CHECKPOINT_MS = 15 * MINUTE;
/** A sound state (music, traffic…) this long without speech becomes a `sound` episode. */
export const SOUND_EPISODE_MS = 15 * MINUTE;

interface Open {
  id: string;
  /** The chain of speech it belongs to (an episode never spans chains). */
  chainId: string;
  startedAt: number;
  /** The episode's kind as shown (the rules' view is `segmenter.kind`). */
  kind: EpisodeKind;
  /** Set by the user or an agent: rules don't re-label it (but a lasting change still cuts). */
  kindLocked: boolean;
  segmenter: Segmenter;
  /** Last minute boundary classified. */
  lastStep: number;
  /** Checkpoints reported so far. */
  checkpoints: number;
}

interface UserState {
  open: Open | null;
  speech: SpeechSpan[];
  context: ContextMinute[];
}

/**
 * Episodes per user, live: one opens when a chain of speech starts and ends when the chain ends;
 * in between, each minute the last two minutes of speech are classified (see episodes/rules.ts)
 * and a lasting change of kind cuts the episode at the best pause. Backlog chains are segmented
 * offline the same way once their upload is quiet. Episodes edited by the user or an agent are left
 * alone.
 */
export class EpisodeTracker {
  private users = new Map<string, UserState>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly events: EpisodeEvents,
    /** The user has an enrolled voice (so their own speech is recognized). */
    private readonly selfKnown: (userId: string) => Promise<boolean>,
  ) {}

  private user(userId: string): UserState {
    let u = this.users.get(userId);
    if (!u) {
      u = { open: null, speech: [], context: [] };
      this.users.set(userId, u);
    }
    return u;
  }

  /** Per user, one change at a time (live steps, chain ends, backlog, edits). */
  private serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(userId, tail);
    void tail.then(() => {
      if (this.locks.get(userId) === tail) this.locks.delete(userId);
    });
    return run;
  }

  /**
   * End episodes left open by a previous process, at their last speech, and report them ended
   * (their chains, if still open, are re-segmented next; episodes that fit are kept).
   */
  async closeOrphans(): Promise<number> {
    const { episodes: e, utterances: u } = schema;
    const rows = await this.db
      .update(e)
      .set({
        endedAt: sql`coalesce((select max(${u.endAt}) from ${u} where ${u.userId} = ${e.userId} and ${u.startAt} >= ${e.startedAt} and ${u.supersededAt} is null), ${e.startedAt})`,
      })
      .where(isNull(e.endedAt))
      .returning({ id: e.id, userId: e.userId });
    for (const r of rows) this.events.ended(r.userId, r.id);
    return rows.length;
  }

  /** Wait for every queued change (before closing the database on shutdown). */
  async idle(): Promise<void> {
    while (this.locks.size > 0) await Promise.all([...this.locks.values()]);
  }

  /** Live speech (fresh audio only). */
  speech(userId: string, span: SpeechSpan): void {
    this.user(userId).speech.push(span);
  }

  /** Live audio context of a finished minute. */
  context(userId: string, minute: ContextMinute): void {
    this.user(userId).context.push(minute);
  }

  /** What the user is in right now, if anything. */
  current(userId: string): Activity | null {
    const open = this.users.get(userId)?.open;
    return open ? { episodeId: open.id, kind: open.kind, since: open.startedAt } : null;
  }

  chainStarted(userId: string, chainId: string, at: number): Promise<void> {
    return this.serial(userId, async () => {
      const u = this.user(userId);
      // The previous chain's end wasn't reported (it always is first): end it at its last speech.
      if (u.open) {
        const open = u.open;
        const last = u.speech.reduce(
          (end, s) =>
            s.startAt >= open.startedAt && s.startAt < at ? Math.max(end, s.endAt) : end,
          open.startedAt,
        );
        await this.end(userId, u, Math.min(last, at), false);
      }
      await this.trimSound(userId, at, Number.POSITIVE_INFINITY);
      const [row] = await this.db
        .insert(schema.episodes)
        .values({ userId, startedAt: new Date(at) })
        .returning({ id: schema.episodes.id });
      u.open = {
        id: row!.id,
        chainId,
        startedAt: at,
        kind: "unknown",
        kindLocked: false,
        segmenter: new Segmenter(at),
        lastStep: Math.floor(at / MINUTE) * MINUTE,
        checkpoints: 0,
      };
      this.events.activity(userId, this.current(userId));
      this.events.changed(userId);
    });
  }

  /**
   * The live chain [startAt, endAt] ended: classify what's left and end its episode. Then cover
   * what no episode does (backlog can extend a chain to before its first episode).
   */
  chainEnded(userId: string, chainId: string, startAt: number, endAt: number): Promise<void> {
    return this.serial(userId, async () => {
      const u = this.user(userId);
      if (u.open?.chainId === chainId) {
        await this.steps(userId, u, endAt);
        await this.step(userId, u, endAt);
        await this.end(userId, u, endAt);
      }
      await this.fill(userId, startAt, endAt);
    });
  }

  /** Classify the minutes that are complete by now; forget old speech. */
  async tick(now = Date.now()): Promise<void> {
    for (const [userId, u] of this.users) {
      await this.serial(userId, async () => {
        if (u.open) await this.steps(userId, u, now - LAG_MS);
        const keep = now - KEEP_MS;
        u.speech = u.speech.filter((s) => s.endAt > keep);
        u.context = u.context.filter((m) => m.at + MINUTE > keep);
      });
      if (!u.open && u.speech.length === 0 && u.context.length === 0) this.users.delete(userId);
    }
  }

  /**
   * Parts of [from, to] no episode covers: grow the (rule-made) episode right after or before
   * such a gap over it, else make episodes for it from the stored speech.
   */
  private async fill(userId: string, from: number, to: number): Promise<void> {
    const e = schema.episodes;
    const existing = await this.db
      .select()
      .from(e)
      .where(
        and(
          eq(e.userId, userId),
          lt(e.startedAt, new Date(to)),
          or(isNull(e.endedAt), gt(e.endedAt, new Date(from))),
        ),
      );
    const gaps = uncovered(
      from,
      to,
      existing.map((x) => [
        x.startedAt.getTime(),
        x.endedAt?.getTime() ?? Number.POSITIVE_INFINITY,
      ]),
    );
    if (gaps.length === 0) return;
    const created: string[] = [];
    for (const [a, b] of gaps) {
      const after = existing.find(
        (x) => x.boundarySource === "rule" && Math.abs(x.startedAt.getTime() - b) < 1000,
      );
      const before = existing.find(
        (x) => x.boundarySource === "rule" && x.endedAt && Math.abs(x.endedAt.getTime() - a) < 1000,
      );
      if (after) {
        await this.db
          .update(e)
          .set({ startedAt: new Date(a) })
          .where(eq(e.id, after.id));
      } else if (before) {
        await this.db
          .update(e)
          .set({ endedAt: new Date(b) })
          .where(eq(e.id, before.id));
      } else {
        const { speech, context } = await this.stored(userId, a, b);
        const segments = segmentRange(speech, context, a, b, await this.selfKnown(userId));
        const rows = await this.db
          .insert(e)
          .values(
            segments.map((s) => ({
              userId,
              startedAt: new Date(s.startedAt),
              endedAt: new Date(s.endedAt),
              kind: s.kind,
            })),
          )
          .returning({ id: e.id });
        created.push(...rows.map((r) => r.id));
      }
    }
    for (const id of created) this.events.ended(userId, id);
    this.events.changed(userId);
  }

  /** Stored speech and context of [from, to], as the classifier sees them. */
  private async stored(
    userId: string,
    from: number,
    to: number,
  ): Promise<{ speech: SpeechSpan[]; context: ContextMinute[] }> {
    const u = schema.utterances;
    const speech = (
      await this.db
        .select({
          startAt: u.startAt,
          endAt: u.endAt,
          personId: u.personId,
          speakerKey: u.speakerKey,
          isWearer: u.isWearer,
        })
        .from(u)
        .where(
          and(
            eq(u.userId, userId),
            isNull(u.supersededAt),
            gte(u.startAt, new Date(from)),
            lte(u.startAt, new Date(to)),
          ),
        )
        .orderBy(asc(u.startAt))
    ).map((r) => ({
      startAt: r.startAt.getTime(),
      endAt: r.endAt.getTime(),
      speaker: r.personId ?? r.speakerKey,
      isWearer: r.isWearer,
    }));
    const c = schema.contextSamples;
    const context = (
      await this.db
        .select()
        .from(c)
        .where(
          and(eq(c.userId, userId), gte(c.at, new Date(from - MINUTE)), lt(c.at, new Date(to))),
        )
    ).map((m) => ({ at: m.at.getTime(), windows: m.windows, scores: m.scores }));
    return { speech, context };
  }

  /** The user or an agent edited episodes: pick up a new kind (or lock) on the open one. */
  reload(userId: string): Promise<void> {
    return this.serial(userId, async () => {
      const open = this.users.get(userId)?.open;
      if (!open) return;
      const [row] = await this.db
        .select()
        .from(schema.episodes)
        .where(eq(schema.episodes.id, open.id));
      if (!row) {
        // Gone (merged away): nothing to continue.
        this.user(userId).open = null;
        this.events.activity(userId, null);
        return;
      }
      open.kind = row.kind;
      open.kindLocked = row.kindSource !== "rule";
      this.events.activity(userId, this.current(userId));
    });
  }

  private async steps(userId: string, u: UserState, until: number): Promise<void> {
    if (!u.open) return;
    for (let m = u.open.lastStep + MINUTE; m <= until; m += MINUTE) {
      await this.step(userId, u, m);
      if (!u.open) return;
      u.open.lastStep = m;
      const due = Math.floor((m - u.open.startedAt) / CHECKPOINT_MS);
      if (due > u.open.checkpoints) {
        u.open.checkpoints = due;
        this.events.checkpoint(userId, u.open.id, m);
      }
    }
  }

  private async step(userId: string, u: UserState, at: number): Promise<void> {
    const open = u.open;
    if (!open) return;
    const features = windowFeatures(
      u.speech,
      u.context,
      Math.max(open.startedAt, at - WINDOW_MS),
      at,
    );
    const kind = classify(features, await this.selfKnown(userId));
    const action = open.segmenter.step(at, kind);
    if (action) await this.apply(userId, u, action);
  }

  private async apply(userId: string, u: UserState, action: SegmentAction): Promise<void> {
    const open = u.open!;
    const t = action.type === "cut" ? cutPoint(u.speech, action.from, action.to) : 0;
    if (action.type === "kind" || t - open.startedAt < MIN_EPISODE_MS) {
      // Rules never overwrite a kind the user or an agent set.
      if (open.kindLocked) return;
      open.kind = action.kind;
      await this.db
        .update(schema.episodes)
        .set({ kind: action.kind })
        .where(and(eq(schema.episodes.id, open.id), eq(schema.episodes.kindSource, "rule")));
      this.events.activity(userId, this.current(userId));
      this.events.changed(userId);
      return;
    }
    await this.end(userId, u, t, false);
    const [row] = await this.db
      .insert(schema.episodes)
      .values({ userId, startedAt: new Date(t), kind: action.kind })
      .returning({ id: schema.episodes.id });
    open.segmenter.startedAt = t;
    u.open = {
      id: row!.id,
      chainId: open.chainId,
      startedAt: t,
      kind: action.kind,
      kindLocked: false,
      segmenter: open.segmenter,
      lastStep: open.lastStep,
      checkpoints: 0,
    };
    this.events.activity(userId, this.current(userId));
    this.events.changed(userId);
  }

  /** `idle`: nothing follows (vs. the next episode starting right away). */
  private async end(userId: string, u: UserState, at: number, idle = true): Promise<void> {
    const open = u.open;
    if (!open) return;
    u.open = null;
    await this.db
      .update(schema.episodes)
      .set({ endedAt: new Date(Math.max(at, open.startedAt)) })
      .where(eq(schema.episodes.id, open.id));
    this.events.ended(userId, open.id);
    if (idle) this.events.activity(userId, null);
    this.events.changed(userId);
  }

  /**
   * Make room for speech in [from, to): rule-made sound episodes overlapping it keep only their
   * parts outside it that are still long enough (the first such part keeps the id).
   */
  private async trimSound(userId: string, from: number, to: number): Promise<void> {
    const e = schema.episodes;
    const sounds = await this.db
      .select()
      .from(e)
      .where(
        and(
          eq(e.userId, userId),
          eq(e.kind, "sound"),
          eq(e.kindSource, "rule"),
          eq(e.boundarySource, "rule"),
          eq(e.textSource, "rule"),
          Number.isFinite(to) ? lt(e.startedAt, new Date(to)) : undefined,
          gt(e.endedAt, new Date(from)),
        ),
      );
    for (const s of sounds) {
      const parts = [
        [s.startedAt.getTime(), Math.min(from, s.endedAt!.getTime())],
        [Math.max(to, s.startedAt.getTime()), s.endedAt!.getTime()],
      ].filter(([a, b]) => b! - a! >= SOUND_EPISODE_MS) as [number, number][];
      const [keep, ...more] = parts;
      if (!keep) {
        await this.db.delete(e).where(eq(e.id, s.id));
        continue;
      }
      await this.db
        .update(e)
        .set({ startedAt: new Date(keep[0]), endedAt: new Date(keep[1]) })
        .where(eq(e.id, s.id));
      for (const [a, b] of more) {
        await this.db.insert(e).values({
          userId,
          startedAt: new Date(a),
          endedAt: new Date(b),
          kind: "sound",
        });
      }
    }
  }

  /**
   * A long sound state ended (music, a commute…): the parts of [from, to] no episode covers, if
   * long enough, become `sound` episodes.
   */
  soundEnded(userId: string, from: number, to: number): Promise<void> {
    return this.serial(userId, async () => {
      if (to - from < SOUND_EPISODE_MS) return;
      const e = schema.episodes;
      const existing = await this.db
        .select({ startedAt: e.startedAt, endedAt: e.endedAt })
        .from(e)
        .where(
          and(
            eq(e.userId, userId),
            lt(e.startedAt, new Date(to)),
            or(isNull(e.endedAt), gt(e.endedAt, new Date(from))),
          ),
        );
      const parts = uncovered(
        from,
        to,
        existing.map((x) => [
          x.startedAt.getTime(),
          x.endedAt?.getTime() ?? Number.POSITIVE_INFINITY,
        ]),
      ).filter(([a, b]) => b - a >= SOUND_EPISODE_MS);
      if (parts.length === 0) return;
      const rows = await this.db
        .insert(e)
        .values(
          parts.map(([a, b]) => ({
            userId,
            startedAt: new Date(a),
            endedAt: new Date(b),
            kind: "sound" as const,
          })),
        )
        .returning({ id: e.id });
      for (const row of rows) this.events.ended(userId, row.id);
      this.events.changed(userId);
    });
  }

  /**
   * A backlog chain is complete (or was left open by a crash): segment it from stored speech and
   * context. Rule-made episodes it covers are reconciled with the result: one of the same kind that
   * overlaps a new segment keeps its id (re-cut to fit, not announced again); only new ones are
   * reported ended. Episodes someone edited, titled or summarized are kept as they are, and only
   * the time around them is segmented.
   */
  segmentChain(userId: string, chainId: string): Promise<void> {
    return this.serial(userId, async () => {
      const [chain] = await this.db
        .select()
        .from(schema.chains)
        .where(and(eq(schema.chains.id, chainId), eq(schema.chains.userId, userId)));
      if (!chain?.endedAt) return;
      const from = chain.startedAt.getTime();
      const to = chain.endedAt.getTime();
      const { speech, context } = await this.stored(userId, from, to);
      const self = await this.selfKnown(userId);
      const openId = this.users.get(userId)?.open?.id;
      const e = schema.episodes;
      // Speech wins over a sound episode made before it was transcribed (backlog).
      await this.trimSound(userId, from, to);

      const created = await this.db.transaction(async (tx) => {
        // Locked: an edit landing meanwhile waits, then sees the result.
        const existing = await tx
          .select()
          .from(e)
          .where(
            and(
              eq(e.userId, userId),
              lte(e.startedAt, new Date(to)),
              or(isNull(e.endedAt), gt(e.endedAt, new Date(from))),
            ),
          )
          .for("update");
        const replaceable = (x: (typeof existing)[number]) =>
          x.endedAt !== null &&
          x.boundarySource === "rule" &&
          x.kindSource === "rule" &&
          x.textSource === "rule" &&
          x.title === null &&
          x.summary === null &&
          x.startedAt.getTime() >= from &&
          x.endedAt.getTime() <= to &&
          x.id !== openId;
        const pool = existing.filter(replaceable);
        const kept = existing.filter((x) => !replaceable(x));
        const gaps = uncovered(
          from,
          to,
          kept.map((x) => [
            x.startedAt.getTime(),
            x.endedAt?.getTime() ?? Number.POSITIVE_INFINITY,
          ]),
        );
        const segments = gaps.flatMap(([a, b]) => segmentRange(speech, context, a, b, self));
        const fresh: string[] = [];
        for (const seg of segments) {
          const overlap = (x: (typeof existing)[number]) =>
            Math.min(seg.endedAt, x.endedAt!.getTime()) -
            Math.max(seg.startedAt, x.startedAt.getTime());
          const reuse = pool
            .filter((x) => x.kind === seg.kind && overlap(x) > 0)
            .sort((x, y) => overlap(y) - overlap(x))[0];
          if (reuse) {
            pool.splice(pool.indexOf(reuse), 1);
            if (
              reuse.startedAt.getTime() !== seg.startedAt ||
              reuse.endedAt!.getTime() !== seg.endedAt
            ) {
              await tx
                .update(e)
                .set({ startedAt: new Date(seg.startedAt), endedAt: new Date(seg.endedAt) })
                .where(eq(e.id, reuse.id));
            }
            continue;
          }
          const [row] = await tx
            .insert(e)
            .values({
              userId,
              startedAt: new Date(seg.startedAt),
              endedAt: new Date(seg.endedAt),
              kind: seg.kind,
            })
            .returning({ id: e.id });
          fresh.push(row!.id);
        }
        if (pool.length)
          await tx.delete(e).where(
            inArray(
              e.id,
              pool.map((x) => x.id),
            ),
          );
        return fresh;
      });
      for (const id of created) this.events.ended(userId, id);
      this.events.changed(userId);
    });
  }
}

/** Parts of [from, to] not covered by `taken` (ignoring slivers under a second). */
export function uncovered(
  from: number,
  to: number,
  taken: Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cur = from;
  for (const [a, b] of [...taken].sort((x, y) => x[0] - y[0])) {
    if (b <= cur) continue;
    if (a > cur) out.push([cur, Math.min(a, to)]);
    cur = Math.max(cur, b);
    if (cur >= to) break;
  }
  if (cur < to) out.push([cur, to]);
  return out.filter(([a, b]) => b - a >= 1000);
}
