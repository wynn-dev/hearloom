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
}

/** Utterances are final a little after they're spoken: classify a minute once it's this old. */
const LAG_MS = 20_000;
/** Speech and context kept per user for classifying the open episode. */
const KEEP_MS = 10 * MINUTE;

interface Open {
  id: string;
  startedAt: number;
  /** The episode's kind as shown (the rules' view is `segmenter.kind`). */
  kind: EpisodeKind;
  /** Set by the user or an agent: rules don't re-label it (but a lasting change still cuts). */
  kindLocked: boolean;
  segmenter: Segmenter;
  /** Last minute boundary classified. */
  lastStep: number;
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

  /** End episodes left open by a previous process (their chains are re-segmented next). */
  async closeOrphans(): Promise<number> {
    const { episodes: e, utterances: u } = schema;
    const rows = await this.db
      .update(e)
      .set({
        endedAt: sql`coalesce((select max(${u.endAt}) from ${u} where ${u.userId} = ${e.userId} and ${u.startAt} >= ${e.startedAt} and ${u.supersededAt} is null), ${e.startedAt})`,
      })
      .where(isNull(e.endedAt))
      .returning({ id: e.id });
    return rows.length;
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

  chainStarted(userId: string, at: number): Promise<void> {
    return this.serial(userId, async () => {
      const u = this.user(userId);
      if (u.open) await this.end(userId, u, at, false);
      const [row] = await this.db
        .insert(schema.episodes)
        .values({ userId, startedAt: new Date(at) })
        .returning({ id: schema.episodes.id });
      u.open = {
        id: row!.id,
        startedAt: at,
        kind: "unknown",
        kindLocked: false,
        segmenter: new Segmenter(at),
        lastStep: Math.floor(at / MINUTE) * MINUTE,
      };
      this.events.activity(userId, this.current(userId));
      this.events.changed(userId);
    });
  }

  /** The live chain ended at `endAt`: classify what's left, then end the episode. */
  chainEnded(userId: string, endAt: number): Promise<void> {
    return this.serial(userId, async () => {
      const u = this.user(userId);
      if (!u.open) return;
      await this.steps(userId, u, endAt);
      await this.step(userId, u, endAt);
      await this.end(userId, u, endAt);
    });
  }

  /** Classify the minutes that are complete by now. */
  async tick(now = Date.now()): Promise<void> {
    for (const [userId, u] of this.users) {
      if (!u.open) {
        u.speech = [];
        u.context = [];
        continue;
      }
      await this.serial(userId, () => this.steps(userId, u, now - LAG_MS));
      const keep = now - KEEP_MS;
      u.speech = u.speech.filter((s) => s.endAt > keep);
      u.context = u.context.filter((m) => m.at + MINUTE > keep);
    }
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
      startedAt: t,
      kind: action.kind,
      kindLocked: false,
      segmenter: open.segmenter,
      lastStep: open.lastStep,
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
   * A backlog chain is complete (or was left open by a crash): segment it from stored speech and
   * context, replacing the rule-made episodes it covers. Episodes that were edited, titled or
   * summarized are kept; only the time around them is filled in.
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
      const e = schema.episodes;
      const existing = await this.db
        .select()
        .from(e)
        .where(
          and(
            eq(e.userId, userId),
            lte(e.startedAt, new Date(to)),
            or(isNull(e.endedAt), gt(e.endedAt, new Date(from))),
          ),
        );
      const replaceable = (x: (typeof existing)[number]) =>
        x.endedAt !== null &&
        x.boundarySource === "rule" &&
        x.kindSource === "rule" &&
        x.title === null &&
        x.summary === null &&
        x.startedAt.getTime() >= from &&
        x.endedAt.getTime() <= to &&
        x.id !== this.users.get(userId)?.open?.id;
      const kept = existing.filter((x) => !replaceable(x));
      const gaps = uncovered(
        from,
        to,
        kept.map((x) => [x.startedAt.getTime(), x.endedAt?.getTime() ?? Number.POSITIVE_INFINITY]),
      );

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
      const self = await this.selfKnown(userId);
      const segments = gaps.flatMap(([a, b]) => segmentRange(speech, context, a, b, self));

      const created = await this.db.transaction(async (tx) => {
        const drop = existing.filter(replaceable).map((x) => x.id);
        if (drop.length) await tx.delete(e).where(inArray(e.id, drop));
        if (segments.length === 0) return [];
        return tx
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
      });
      for (const row of created) this.events.ended(userId, row.id);
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
