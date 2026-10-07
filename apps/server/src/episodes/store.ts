/**
 * Episodes in Postgres: queries shared by the API, MCP and the worker, and the edits users and
 * agents can make (rename, re-kind, split, merge). Edits record who made them, and rules never
 * undo what an agent or the user decided (see `mayEdit`).
 */
import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { type EditSource, type KnownEpisodeKind, mayEdit } from "@hearloom/shared";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";

export type EpisodeRow = typeof schema.episodes.$inferSelect;
const { episodes: e, blocks: b } = schema;

export class EpisodeEditError extends Error {}

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

/** After a block was refined: the ended episodes it overlaps that are now fully refined. */
export async function episodesRefinedBy(
  db: Db,
  blockId: string,
): Promise<{ userId: string; ids: string[] } | null> {
  const [block] = await db.select().from(b).where(eq(b.id, blockId));
  if (!block?.endedAt) return null;
  const eps = (await episodesIn(db, block.userId, block.startedAt, block.endedAt)).filter(
    (x) => x.endedAt !== null,
  );
  // A block ending exactly where an episode starts doesn't overlap it.
  const overlapping = eps.filter((x) => x.startedAt < block.endedAt!);
  const refined = await refinedIds(db, block.userId, overlapping);
  return { userId: block.userId, ids: [...refined] };
}

export interface EpisodePatch {
  title?: string | null;
  summary?: string | null;
  kind?: KnownEpisodeKind;
}

/** Rename, describe or re-kind an episode. Returns the updated row. */
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
  if (patch.title !== undefined) set.title = patch.title?.trim().slice(0, 200) || null;
  if (patch.summary !== undefined) set.summary = patch.summary?.trim().slice(0, 4000) || null;
  if (patch.kind !== undefined) {
    if (!mayEdit(by, cur.kindSource)) {
      throw new EpisodeEditError(`the kind was set by the ${cur.kindSource}; it can't be changed`);
    }
    set.kind = patch.kind;
    set.kindSource = by;
  }
  if (Object.keys(set).length === 0) return cur;
  const [row] = await db.update(e).set(set).where(eq(e.id, id)).returning();
  return row!;
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
    // Same kind: keep whoever decided it with more authority. Different kinds: the longer one's
    // kind, now chosen by whoever merged.
    const kindSource =
      a.kind === z.kind ? (mayEdit(a.kindSource, z.kindSource) ? a.kindSource : z.kindSource) : by;
    await tx.delete(e).where(eq(e.id, z.id));
    const [row] = await tx
      .update(e)
      .set({
        endedAt: z.endedAt,
        kind: longer.kind,
        kindSource,
        boundarySource: by,
        title: a.title ?? z.title,
        summary: a.summary && z.summary ? `${a.summary}\n\n${z.summary}` : (a.summary ?? z.summary),
      })
      .where(eq(e.id, a.id))
      .returning();
    return row!;
  });
}
