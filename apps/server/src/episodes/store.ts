/**
 * Episodes in Postgres: queries shared by the API, MCP and the worker, and the edits users and
 * agents can make (rename, re-kind, split, merge). Edits record who made them, and rules never
 * undo what an agent or the user decided (see `mayEdit`).
 */
import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { type EditSource, type KnownEpisodeKind, mayEdit } from "@hearloom/shared";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

export type EpisodeRow = typeof schema.episodes.$inferSelect;
const { episodes: e, blocks: b } = schema;

export class EpisodeEditError extends Error {}

/** The episode each of these times falls in (one indexed lookup per time). */
export async function episodesAt(
  db: Db,
  userId: string,
  times: Date[],
): Promise<Map<number, { id: string; kind: EpisodeRow["kind"] }>> {
  const out = new Map<number, { id: string; kind: EpisodeRow["kind"] }>();
  if (times.length === 0) return out;
  const list = sql.join(
    times.map((t) => sql`${t.toISOString()}::timestamptz`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    select t.at, ep.id, ep.kind
    from unnest(array[${list}]) as t(at)
    cross join lateral (
      select ${e.id} as id, ${e.kind} as kind from ${e}
      where ${e.userId} = ${userId} and ${e.startedAt} <= t.at
        and (${e.endedAt} is null or ${e.endedAt} > t.at)
      order by ${e.startedAt} desc limit 1
    ) ep`)) as unknown as { at: Date | string; id: string; kind: EpisodeRow["kind"] }[];
  for (const r of rows) out.set(new Date(r.at).getTime(), { id: r.id, kind: r.kind });
  return out;
}

/** Episodes overlapping [from, to), oldest first. */
export function episodesIn(
  db: Db,
  userId: string,
  from: Date,
  to: Date,
  limit = 500,
): Promise<EpisodeRow[]> {
  return db
    .select()
    .from(e)
    .where(
      and(eq(e.userId, userId), lt(e.startedAt, to), or(isNull(e.endedAt), gt(e.endedAt, from))),
    )
    .orderBy(asc(e.startedAt))
    .limit(limit);
}

export async function getEpisode(db: Db, userId: string, id: string): Promise<EpisodeRow | null> {
  const [row] = await db
    .select()
    .from(e)
    .where(and(eq(e.id, id), eq(e.userId, userId)));
  return row ?? null;
}

/**
 * Ended episodes whose speech is all refined: every block overlapping them is. (Open episodes are
 * never refined: more speech is coming.)
 */
export async function refinedIds(db: Db, userId: string, eps: EpisodeRow[]): Promise<Set<string>> {
  const ended = eps.filter((x) => x.endedAt);
  if (ended.length === 0) return new Set();
  const from = new Date(Math.min(...ended.map((x) => x.startedAt.getTime())));
  const to = new Date(Math.max(...ended.map((x) => x.endedAt!.getTime())));
  const rows = await db
    .select({ startedAt: b.startedAt, endedAt: b.endedAt, status: b.status })
    .from(b)
    .where(
      and(eq(b.userId, userId), lt(b.startedAt, to), or(isNull(b.endedAt), gt(b.endedAt, from))),
    );
  const out = new Set<string>();
  for (const x of ended) {
    const s = x.startedAt.getTime();
    const t = x.endedAt!.getTime();
    const overlapping = rows.filter(
      (r) => r.startedAt.getTime() < t && (r.endedAt?.getTime() ?? Number.POSITIVE_INFINITY) > s,
    );
    if (overlapping.every((r) => r.status === "refined")) out.add(x.id);
  }
  return out;
}

/** The ended, refined episodes overlapping [from, to) (`episode.refined` candidates). */
async function refinedIn(
  db: Db,
  userId: string,
  from: Date,
  to: Date,
): Promise<{ id: string; kind: EpisodeRow["kind"] }[]> {
  // An episode starting exactly where the range ends doesn't overlap it.
  const eps = (await episodesIn(db, userId, from, to)).filter(
    (x) => x.endedAt !== null && x.startedAt < to,
  );
  const refined = await refinedIds(db, userId, eps);
  return eps.filter((x) => refined.has(x.id)).map((x) => ({ id: x.id, kind: x.kind }));
}

/** After a block was refined: the ended episodes it overlaps that are now fully refined. */
export async function episodesRefinedBy(
  db: Db,
  blockId: string,
): Promise<{ userId: string; episodes: { id: string; kind: EpisodeRow["kind"] }[] } | null> {
  const [block] = await db.select().from(b).where(eq(b.id, blockId));
  if (!block?.endedAt) return null;
  return {
    userId: block.userId,
    episodes: await refinedIn(db, block.userId, block.startedAt, block.endedAt),
  };
}

/** The refined episodes of a chain (after its speaker keys were consolidated). */
export async function refinedEpisodesOfChain(
  db: Db,
  chainId: string,
): Promise<{ userId: string; episodes: { id: string; kind: EpisodeRow["kind"] }[] } | null> {
  const [chain] = await db.select().from(schema.chains).where(eq(schema.chains.id, chainId));
  if (!chain?.endedAt) return null;
  return {
    userId: chain.userId,
    episodes: await refinedIn(db, chain.userId, chain.startedAt, chain.endedAt),
  };
}

export interface EpisodePatch {
  title?: string | null;
  summary?: string | null;
  kind?: KnownEpisodeKind;
}

/** Sources an edit by `by` may override. */
const overridable = (by: EditSource): EditSource[] =>
  (["rule", "agent", "user"] as const).filter((s) => mayEdit(by, s));

/**
 * Rename, describe or re-kind an episode. Returns the updated row. What the user set can't be
 * changed by an agent (the check is part of the update, so a concurrent edit can't slip past).
 */
export async function updateEpisode(
  db: Db,
  userId: string,
  id: string,
  patch: EpisodePatch,
  by: EditSource,
): Promise<EpisodeRow> {
  const cur = await getEpisode(db, userId, id);
  if (!cur) throw new EpisodeEditError("episode not found");
  const set: Partial<typeof e.$inferInsert> = {};
  const text = patch.title !== undefined || patch.summary !== undefined;
  if (patch.title !== undefined) set.title = patch.title?.trim().slice(0, 200) || null;
  if (patch.summary !== undefined) set.summary = patch.summary?.trim().slice(0, 4000) || null;
  if (text) set.textSource = by;
  if (patch.kind !== undefined) {
    set.kind = patch.kind;
    set.kindSource = by;
  }
  if (Object.keys(set).length === 0) return cur;
  const allowed = overridable(by);
  const [row] = await db
    .update(e)
    .set(set)
    .where(
      and(
        eq(e.id, id),
        eq(e.userId, userId),
        text ? inArray(e.textSource, allowed) : undefined,
        patch.kind !== undefined ? inArray(e.kindSource, allowed) : undefined,
      ),
    )
    .returning();
  if (!row) {
    const what = text && !mayEdit(by, cur.textSource) ? "title and summary were" : "kind was";
    throw new EpisodeEditError(`its ${what} set by the user; they can't be changed`);
  }
  return row;
}

/** Split an ended episode at `at` (strictly inside it). Returns the two parts. */
export async function splitEpisode(
  db: Db,
  userId: string,
  id: string,
  at: Date,
  by: EditSource,
): Promise<[EpisodeRow, EpisodeRow]> {
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(e)
      .where(and(eq(e.id, id), eq(e.userId, userId)))
      .for("update");
    if (!cur) throw new EpisodeEditError("episode not found");
    if (!cur.endedAt) throw new EpisodeEditError("an episode can be split once it has ended");
    if (!mayEdit(by, cur.boundarySource)) {
      throw new EpisodeEditError(`its boundaries were set by the ${cur.boundarySource}`);
    }
    if (at <= cur.startedAt || at >= cur.endedAt) {
      throw new EpisodeEditError("the split time must be inside the episode");
    }
    const [first] = await tx
      .update(e)
      .set({ endedAt: at, boundarySource: by })
      .where(eq(e.id, id))
      .returning();
    const [second] = await tx
      .insert(e)
      .values({
        userId,
        startedAt: at,
        endedAt: cur.endedAt,
        kind: cur.kind,
        kindSource: cur.kindSource,
        textSource: cur.textSource,
        boundarySource: by,
      })
      .returning();
    return [first!, second!];
  });
}

/**
 * Merge two ended episodes that follow each other (nothing in between) into the first. The kind
 * of the longer one wins; titles and summaries are kept if only one has them.
 */
export async function mergeEpisodes(
  db: Db,
  userId: string,
  ids: [string, string],
  by: EditSource,
): Promise<EpisodeRow> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(e)
      .where(and(eq(e.userId, userId), inArray(e.id, ids)))
      .for("update");
    if (rows.length !== 2 || ids[0] === ids[1]) throw new EpisodeEditError("episode not found");
    const [a, z] = rows.sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime()) as [
      EpisodeRow,
      EpisodeRow,
    ];
    if (!a.endedAt || !z.endedAt) {
      throw new EpisodeEditError("episodes can be merged once they have ended");
    }
    for (const x of [a, z]) {
      if (!mayEdit(by, x.boundarySource)) {
        throw new EpisodeEditError(`its boundaries were set by the ${x.boundarySource}`);
      }
    }
    const between = await tx
      .select({ id: e.id })
      .from(e)
      .where(
        and(
          eq(e.userId, userId),
          ne(e.id, a.id),
          ne(e.id, z.id),
          lt(e.startedAt, z.startedAt),
          or(isNull(e.endedAt), gt(e.endedAt, a.endedAt)),
        ),
      )
      .limit(1);
    if (between.length > 0) throw new EpisodeEditError("only neighbouring episodes can be merged");
    const longer =
      a.endedAt.getTime() - a.startedAt.getTime() >= z.endedAt.getTime() - z.startedAt.getTime()
        ? a
        : z;
    // The kind decided with more authority wins (then the longer part's); merging doesn't make
    // it the merger's decision. Titles and summaries likewise.
    const kindFrom =
      a.kindSource !== z.kindSource ? (mayEdit(a.kindSource, z.kindSource) ? a : z) : longer;
    const textFrom = mayEdit(a.textSource, z.textSource) ? a : z;
    await tx.delete(e).where(eq(e.id, z.id));
    const [row] = await tx
      .update(e)
      .set({
        endedAt: z.endedAt,
        kind: kindFrom.kind,
        kindSource: kindFrom.kindSource,
        boundarySource: by,
        title: textFrom.title ?? a.title ?? z.title,
        summary: a.summary && z.summary ? `${a.summary}\n\n${z.summary}` : (a.summary ?? z.summary),
        textSource: textFrom.textSource,
      })
      .where(eq(e.id, a.id))
      .returning();
    return row!;
  });
}
