import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import type { BlockSpeaker } from "@hearloom/db/schema";
import { cosine, SPEAKER_MODEL_ID } from "@hearloom/inference";
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { type AudioPiece, concatPieces, loadStreamPieces } from "../audio/load";
import type { DiarSegment } from "./diarizer";

export interface Embedder {
  embed(audio: Float32Array): Float32Array;
}

export interface BlockDiarizer {
  diarize(samples: Float32Array): Promise<DiarSegment[]>;
}

export interface RefineDeps {
  db: Db;
  embedder: Embedder | null;
  diarizer: BlockDiarizer | null;
  /** Voice similarity that names a speaker after an enrolled person. */
  matchThreshold: number;
  /** Voice similarity that makes two clusters the same speaker (across blocks of a chain). */
  clusterThreshold: number;
  /** Decoded audio of a stream between two times; defaults to the stored chunks. */
  loadPieces?: (streamId: string, fromMs: number, toMs: number) => Promise<AudioPiece[]>;
  log(message: string): void;
}

interface NewUtterance {
  startAt: number;
  endAt: number;
  text: string;
  lang: string | null;
  speaker: string | null;
  confidence: number | null;
  provider: string;
  model: string | null;
}

interface Turn {
  speaker: string;
  startAt: number;
  endAt: number;
}

/**
 * Longest stretch diarized in one pass (diarizer memory). Blocks are far shorter; only blocks
 * migrated from long conversations need splitting.
 */
const MAX_WINDOW_MS = 3 * 3600_000;
/**
 * The end of the previous block, diarized together with this one: a cluster that shares this
 * speech with a previous speaker takes over its key, so keys carry across a chain.
 */
export const CONTEXT_MS = 90_000;
/** Shared speech (in the context) needed to take over a previous speaker's key. */
const ANCHOR_MIN_MS = 2000;

/** Speaker whose turns overlap [a, b] the most (or the nearest turn). */
function speakerFor(turns: Turn[], a: number, b: number): string | null {
  let best: string | null = null;
  let bestOverlap = 0;
  let nearest: string | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const t of turns) {
    const overlap = Math.min(b, t.endAt) - Math.max(a, t.startAt);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = t.speaker;
    }
    const dist = overlap > 0 ? 0 : Math.min(Math.abs(a - t.endAt), Math.abs(t.startAt - b));
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = t.speaker;
    }
  }
  return best ?? (nearestDist < 1500 ? nearest : null);
}

/** Consecutive utterances grouped into windows of at most `maxMs`. */
export function windows<T extends { startAt: Date; endAt: Date }>(rows: T[], maxMs: number): T[][] {
  const sorted = [...rows].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const out: T[][] = [];
  for (const r of sorted) {
    const cur = out[out.length - 1];
    if (cur && r.endAt.getTime() - cur[0]!.startAt.getTime() <= maxMs) cur.push(r);
    else out.push([r]);
  }
  return out;
}

const keyNumber = (key: string) => Number(/^S(\d+)$/.exec(key)?.[1] ?? 0);

/** A speaker the chain already knows (from its refined blocks). */
export interface KnownSpeaker {
  key: string;
  centroid: Float32Array;
  personId: string | null;
  isSelf: boolean | null;
}

/** What a diarizer cluster of this block looks like, for deciding its key. */
export interface ClusterFacts {
  label: string;
  /** Milliseconds of speech shared with the previous block's speakers (by key), in the context. */
  anchors: Map<string, number>;
  /** Voice embedding of its speech in this block, if long enough. */
  embedding: Float32Array | null;
  /** Live speaker keys of the utterances it covers, with counts. */
  liveKeys: Map<string, number>;
}

export type KeySource = "anchor" | "voice" | "live" | "new";

/**
 * Key per cluster, in order of trust: the previous block's speaker it overlaps in the context;
 * a known voice of the chain; the live key most of its utterances had (so keys don't change when
 * a block is refined, unless that key belongs to a known voice); else the next free key.
 */
export function assignKeys(
  clusters: ClusterFacts[],
  known: KnownSpeaker[],
  usedKeys: Iterable<string>,
  threshold: number,
): Map<string, { key: string; source: KeySource; known?: KnownSpeaker }> {
  const out = new Map<string, { key: string; source: KeySource; known?: KnownSpeaker }>();
  const taken = new Set<string>();
  const knownKeys = new Set(known.map((k) => k.key));
  for (const c of clusters) {
    let best: [string, number] | null = null;
    let total = 0;
    for (const [key, ms] of c.anchors) {
      total += ms;
      if (!best || ms > best[1]) best = [key, ms];
    }
    if (best && best[1] >= ANCHOR_MIN_MS && best[1] >= total / 2) {
      out.set(c.label, {
        key: best[0],
        source: "anchor",
        known: known.find((k) => k.key === best[0]),
      });
      taken.add(best[0]);
    }
  }
  for (const c of clusters) {
    if (out.has(c.label) || !c.embedding) continue;
    let match: KnownSpeaker | null = null;
    let bestScore = threshold;
    for (const k of known) {
      const score = cosine(c.embedding, k.centroid);
      if (score >= bestScore) {
        bestScore = score;
        match = k;
      }
    }
    if (match) {
      out.set(c.label, { key: match.key, source: "voice", known: match });
      taken.add(match.key);
    }
  }
  let next = Math.max(0, ...[...usedKeys, ...knownKeys].map(keyNumber));
  for (const c of clusters) {
    if (out.has(c.label)) continue;
    const live = [...c.liveKeys]
      .filter(([key]) => !taken.has(key) && !knownKeys.has(key))
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    const key = live ?? `S${++next}`;
    out.set(c.label, { key, source: live ? "live" : "new" });
    taken.add(key);
  }
  return out;
}

/** One block's speaker, as input to consolidation. */
export interface ChainSpeaker extends BlockSpeaker {
  blockId: string;
}

/**
 * Keys of a finished chain that are the same voice: renames (key → key it merges into). Keys
 * merge when their voices are similar, they never speak in the same block (there, the diarizer
 * already told them apart) and they aren't named after different people.
 */
export function consolidate(speakers: ChainSpeaker[], threshold: number): Map<string, string> {
  interface Group {
    keys: Set<string>;
    blocks: Set<string>;
    people: Set<string>;
    seconds: number;
    centroid: Float32Array;
  }
  const groups = new Map<string, Group>();
  for (const s of speakers) {
    const g = groups.get(s.key);
    const c = Float32Array.from(s.centroid);
    if (!g) {
      groups.set(s.key, {
        keys: new Set([s.key]),
        blocks: new Set([s.blockId]),
        people: new Set(s.personId ? [s.personId] : []),
        seconds: s.seconds,
        centroid: c,
      });
      continue;
    }
    for (let i = 0; i < g.centroid.length; i++) {
      g.centroid[i] =
        (g.centroid[i]! * g.seconds + (c[i] ?? 0) * s.seconds) / (g.seconds + s.seconds || 1);
    }
    g.seconds += s.seconds;
    g.blocks.add(s.blockId);
    if (s.personId) g.people.add(s.personId);
  }
  const keys = [...groups.keys()];
  const pairs: [string, string, number][] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const score = cosine(groups.get(keys[i]!)!.centroid, groups.get(keys[j]!)!.centroid);
      if (score >= threshold) pairs.push([keys[i]!, keys[j]!, score]);
    }
  }
  pairs.sort((a, b) => b[2] - a[2]);
  /** Key → the group it currently belongs to. */
  const owner = new Map(keys.map((k) => [k, groups.get(k)!]));
  for (const [a, b] of pairs) {
    const ga = owner.get(a)!;
    const gb = owner.get(b)!;
    if (ga === gb) continue;
    if ([...ga.blocks].some((x) => gb.blocks.has(x))) continue;
    if (new Set([...ga.people, ...gb.people]).size > 1) continue;
    for (const k of gb.keys) {
      ga.keys.add(k);
      owner.set(k, ga);
    }
    for (const x of gb.blocks) ga.blocks.add(x);
    for (const p of gb.people) ga.people.add(p);
    ga.seconds += gb.seconds;
  }
  const renames = new Map<string, string>();
  for (const g of new Set(owner.values())) {
    if (g.keys.size < 2) continue;
    const members = [...g.keys].map((k) => ({ k, s: groups.get(k)!.seconds }));
    members.sort((x, y) => y.s - x.s || keyNumber(x.k) - keyNumber(y.k));
    for (const { k } of members.slice(1)) renames.set(k, members[0]!.k);
  }
  return renames;
}

/** Merge per-cluster profiles that ended up with the same key (seconds-weighted). */
function mergeProfiles(list: BlockSpeaker[]): BlockSpeaker[] {
  const byKey = new Map<string, BlockSpeaker>();
  for (const p of list) {
    const cur = byKey.get(p.key);
    if (!cur) {
      byKey.set(p.key, { ...p, centroid: [...p.centroid] });
      continue;
    }
    const total = cur.seconds + p.seconds || 1;
    cur.centroid = cur.centroid.map(
      (v, i) => (v * cur.seconds + (p.centroid[i] ?? 0) * p.seconds) / total,
    );
    cur.seconds += p.seconds;
    cur.personId ??= p.personId;
    cur.isSelf ??= p.isSelf;
  }
  return [...byKey.values()];
}

export interface RefineResult {
  message: string;
  /** The block's chain (its conversation), if the block exists. */
  chainId: string | null;
  /** The block is refined now (by this run). */
  refined: boolean;
  /** Live rows replaced. */
  replaced: number;
}

/**
 * Refine a finished block: re-diarize it offline together with the end of the previous block
 * (consistent speaker keys across the chain), identify voices against enrolled people, and replace
 * the live rows with re-attributed copies (the text is kept; rows without audio stay as they are).
 */
export async function refineBlock(deps: RefineDeps, blockId: string): Promise<RefineResult> {
  try {
    return await refineNow(deps, blockId);
  } catch (err) {
    // Don't leave it "refining" forever if this was the last attempt; a retry sets it again.
    await deps.db
      .update(schema.blocks)
      .set({ status: "closed" })
      .where(and(eq(schema.blocks.id, blockId), eq(schema.blocks.status, "refining")))
      .catch(() => {});
    throw err;
  }
}

async function refineNow(deps: RefineDeps, blockId: string): Promise<RefineResult> {
  const { db } = deps;
  const [block] = await db.select().from(schema.blocks).where(eq(schema.blocks.id, blockId));
  if (!block) return { message: "missing", chainId: null, refined: false, replaced: 0 };
  const result = (message: string, refined: boolean, replaced = 0): RefineResult => ({
    message,
    chainId: block.chainId,
    refined,
    replaced,
  });
  if (!block.endedAt) throw new Error("block still open");
  if (block.status === "refined") return result("already refined", false);
  const { diarizer } = deps;
  if (!diarizer) return result("nothing to do (diarizer not built)", false);
  const markRefined = () =>
    db.update(schema.blocks).set({ status: "refined" }).where(eq(schema.blocks.id, blockId));

  const live = await db
    .select()
    .from(schema.utterances)
    .where(and(eq(schema.utterances.blockId, blockId), isNull(schema.utterances.supersededAt)));
  if (live.length === 0) {
    await markRefined();
    return result("empty", true);
  }
  await db.update(schema.blocks).set({ status: "refining" }).where(eq(schema.blocks.id, blockId));

  const people = await db
    .select({
      id: schema.people.id,
      isSelf: schema.people.isSelf,
      embedding: schema.voiceprints.embedding,
    })
    .from(schema.voiceprints)
    .innerJoin(schema.people, eq(schema.people.id, schema.voiceprints.personId))
    .where(
      and(
        eq(schema.voiceprints.userId, block.userId),
        eq(schema.voiceprints.model, SPEAKER_MODEL_ID),
      ),
    );

  // What the chain already knows: voices of its other refined blocks, the keys in use, and the
  // previous block's speakers at the start of this one.
  const chain = await db
    .select({
      id: schema.blocks.id,
      startedAt: schema.blocks.startedAt,
      status: schema.blocks.status,
      speakers: schema.blocks.speakers,
    })
    .from(schema.blocks)
    .where(eq(schema.blocks.chainId, block.chainId));
  const others = chain.filter((b) => b.id !== blockId);
  const known: KnownSpeaker[] = mergeProfiles(others.flatMap((b) => b.speakers)).map((s) => ({
    key: s.key,
    centroid: Float32Array.from(s.centroid),
    personId: s.personId,
    isSelf: s.isSelf,
  }));
  const usedKeys = (
    await db
      .selectDistinct({ key: schema.utterances.speakerKey })
      .from(schema.utterances)
      .where(
        and(
          inArray(
            schema.utterances.blockId,
            chain.map((b) => b.id),
          ),
          isNull(schema.utterances.supersededAt),
          isNotNull(schema.utterances.speakerKey),
        ),
      )
  ).map((r) => r.key!);
  const prev = others
    .filter((b) => b.status === "refined" && b.startedAt < block.startedAt)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  const context = prev
    ? await db
        .select()
        .from(schema.utterances)
        .where(
          and(
            eq(schema.utterances.blockId, prev.id),
            isNull(schema.utterances.supersededAt),
            isNotNull(schema.utterances.speakerKey),
            gt(schema.utterances.endAt, new Date(block.startedAt.getTime() - CONTEXT_MS)),
          ),
        )
    : [];
  const load = deps.loadPieces ?? ((s, f, t) => loadStreamPieces(db, s, f, t));

  const created: (NewUtterance & {
    streamId: string;
    /**
     * Identity from this utterance's own voiceprint, which wins over the cluster's:
     * a person, null = clearly not the cluster's person, undefined = no opinion.
     */
    own?: { personId: string; isSelf: boolean } | null;
  })[] = [];
  const speakerPerson = new Map<
    string,
    { personId: string | null; isSelf: boolean | null; key: string }
  >();
  const profiles: BlockSpeaker[] = [];
  /** Live rows re-derived by this pass (only these are superseded). */
  const replaced: typeof live = [];

  // Usually one stream per block; reconnects can split it. Rows without a stream (no audio) stay
  // as they are.
  const byStream = new Map<string, typeof live>();
  for (const u of live) {
    if (!u.streamId) continue;
    byStream.set(u.streamId, [...(byStream.get(u.streamId) ?? []), u]);
  }
  const passes = [...byStream].flatMap(([streamId, rows]) =>
    windows(rows, MAX_WINDOW_MS).map((utts) => ({ streamId, utts })),
  );

  for (const [pass, { streamId, utts }] of passes.entries()) {
    const blockFrom = Math.min(...utts.map((u) => u.startAt.getTime())) - 300;
    const to = Math.max(...utts.map((u) => u.endAt.getTime())) + 300;
    const ctx = context.filter(
      (c) =>
        c.streamId === streamId &&
        c.endAt.getTime() > blockFrom - CONTEXT_MS &&
        c.startAt.getTime() < to,
    );
    const from = ctx.length
      ? Math.max(blockFrom - CONTEXT_MS, Math.min(...ctx.map((c) => c.startAt.getTime())) - 300)
      : blockFrom;
    const pieces = await load(streamId, from, to);
    if (pieces.length === 0) continue; // audio gone: keep the live rows
    const { samples, toAbs, toOffset } = concatPieces(pieces);
    const blockOffset = from < blockFrom ? toOffset(blockFrom) : 0;
    const firstNew = created.length;
    /** Cluster labels are per pass: diarizer labels restart in every pass. */
    const tag = `${pass}:`;
    replaced.push(...utts);

    // 1) Offline diarization over the block (and the context before it).
    const segs: DiarSegment[] = await diarizer.diarize(samples);
    const turns: Turn[] = segs.map((s) => ({
      speaker: s.speaker,
      startAt: toAbs(s.start),
      endAt: toAbs(s.end),
    }));

    // 2) Each utterance takes the speaker it overlaps most.
    const labelOf = new Map(
      utts.map((u) => [u.id, speakerFor(turns, u.startAt.getTime(), u.endAt.getTime())]),
    );
    const labels = [...new Set([...labelOf.values()].filter((l): l is string => l !== null))];

    // 3) Facts per cluster: shared speech with the previous block's speakers, its voice in this
    // block, and the live keys of its utterances.
    const facts: ClusterFacts[] = [];
    const seconds = new Map<string, number>();
    for (const label of labels) {
      const anchors = new Map<string, number>();
      for (const t of turns) {
        if (t.speaker !== label) continue;
        for (const c of ctx) {
          const o = Math.min(t.endAt, c.endAt.getTime()) - Math.max(t.startAt, c.startAt.getTime());
          if (o > 0) anchors.set(c.speakerKey!, (anchors.get(c.speakerKey!) ?? 0) + o);
        }
      }
      let audio = new Float32Array(0);
      let total = 0;
      for (const s of segs) {
        if (s.speaker !== label) continue;
        const a = Math.max(blockOffset, Math.floor(s.start * 16000));
        const b = Math.floor(s.end * 16000);
        if (b <= a) continue;
        total += (b - a) / 16000;
        if (audio.length > 30 * 16000) continue;
        const part = samples.subarray(a, b);
        const next = new Float32Array(audio.length + part.length);
        next.set(audio);
        next.set(part, audio.length);
        audio = next;
      }
      seconds.set(label, total);
      const liveKeys = new Map<string, number>();
      for (const u of utts) {
        if (labelOf.get(u.id) === label && u.speakerKey)
          liveKeys.set(u.speakerKey, (liveKeys.get(u.speakerKey) ?? 0) + 1);
      }
      facts.push({
        label,
        anchors,
        embedding: deps.embedder && audio.length >= 16000 ? deps.embedder.embed(audio) : null,
        liveKeys,
      });
    }

    // 4) Keys (carried over where the voice is the chain's), and names from enrolled voices.
    const keys = assignKeys(facts, known, usedKeys, deps.clusterThreshold);
    for (const f of facts) {
      const { key, source, known: was } = keys.get(f.label)!;
      let inherited: { personId: string | null; isSelf: boolean | null } | undefined = was;
      if (source === "anchor") {
        const named = ctx.find((c) => c.speakerKey === key && c.personId);
        if (named) inherited = { personId: named.personId, isSelf: named.isWearer };
      }
      let match: { personId: string; isSelf: boolean } | null = null;
      if (f.embedding) {
        let best = deps.matchThreshold;
        for (const p of people) {
          const score = cosine(f.embedding, p.embedding);
          if (score >= best) {
            best = score;
            match = { personId: p.id, isSelf: p.isSelf };
          }
        }
      }
      const who = {
        personId: match?.personId ?? inherited?.personId ?? null,
        isSelf: match ? match.isSelf : (inherited?.isSelf ?? null),
        key,
      };
      speakerPerson.set(`${tag}${f.label}`, who);
      if (f.embedding) {
        const profile = {
          key,
          personId: who.personId,
          isSelf: who.isSelf,
          centroid: Array.from(f.embedding),
          seconds: seconds.get(f.label) ?? 0,
        };
        profiles.push(profile);
        // Later passes of this block (long migrated blocks) match against it too.
        known.push({ ...profile, centroid: f.embedding });
      }
      usedKeys.push(key);
    }

    // 5) Keep the live text, re-attributed.
    for (const u of utts) {
      const label = labelOf.get(u.id);
      created.push({
        startAt: u.startAt.getTime(),
        endAt: u.endAt.getTime(),
        text: u.text,
        lang: u.lang,
        speaker: label ? `${tag}${label}` : null,
        confidence: u.confidence,
        provider: u.provider,
        model: u.model,
        streamId,
      });
    }

    // Per-utterance voice match: diarizers can merge similar voices into one cluster, so a
    // confident match on the utterance itself overrides the cluster's name.
    if (deps.embedder && people.length > 0) {
      for (const u of created.slice(firstNew)) {
        const clip = samples.subarray(toOffset(u.startAt), toOffset(u.endAt));
        if (clip.length < 16000) continue;
        const emb = deps.embedder.embed(clip);
        let best = deps.matchThreshold;
        for (const p of people) {
          const score = cosine(emb, p.embedding);
          if (score >= best) {
            best = score;
            u.own = { personId: p.id, isSelf: p.isSelf };
          }
        }
        // No match: if the cluster was named after someone this clip clearly isn't, drop the name.
        const clusterPerson = u.speaker ? speakerPerson.get(u.speaker)?.personId : null;
        if (u.own === undefined && clusterPerson) {
          const theirs = people
            .filter((p) => p.id === clusterPerson)
            .map((p) => cosine(emb, p.embedding));
          if (theirs.length && Math.max(...theirs) < deps.matchThreshold - 0.15) u.own = null;
        }
      }
    }
  }

  if (replaced.length === 0) {
    // Nothing to re-derive (no stored audio): the live rows are final.
    await markRefined();
    return result("no stored audio to refine", true);
  }

  const now = new Date();
  const replacedIds = replaced.map((u) => u.id);
  await db.transaction(async (tx) => {
    // Rows edited since we read them (e.g. a speaker identified from the timeline): start over, so
    // the edit and the new voiceprint are taken into account.
    const current = await tx
      .select({
        id: schema.utterances.id,
        personId: schema.utterances.personId,
        supersededAt: schema.utterances.supersededAt,
      })
      .from(schema.utterances)
      .where(inArray(schema.utterances.id, replacedIds))
      .for("update");
    const before = new Map(replaced.map((u) => [u.id, u.personId]));
    if (current.some((c) => c.supersededAt !== null || c.personId !== before.get(c.id))) {
      throw new Error("block changed while refining; retrying");
    }
    // Only the rows re-derived above: rows added meanwhile (backlog) or without audio stay live.
    await tx
      .update(schema.utterances)
      .set({ supersededAt: now })
      .where(inArray(schema.utterances.id, replacedIds));
    if (created.length > 0) {
      await tx.insert(schema.utterances).values(
        created.map((u) => {
          const cluster = u.speaker ? speakerPerson.get(u.speaker) : undefined;
          const who =
            u.own === undefined
              ? cluster
              : {
                  personId: u.own?.personId ?? null,
                  isSelf: u.own?.isSelf ?? null,
                  key: cluster?.key ?? null,
                };
          return {
            userId: block.userId,
            conversationId: block.chainId,
            blockId,
            streamId: u.streamId,
            startAt: new Date(u.startAt),
            endAt: new Date(Math.max(u.endAt, u.startAt)),
            speakerKey: who?.key ?? null,
            personId: who?.personId ?? null,
            isWearer: who?.isSelf ?? null,
            text: u.text,
            lang: u.lang,
            confidence: u.confidence,
            source: "refine" as const,
            provider: u.provider,
            model: u.model,
            revision: 1,
          };
        }),
      );
    }
    await tx
      .update(schema.blocks)
      .set({ status: "refined", speakers: mergeProfiles(profiles) })
      .where(eq(schema.blocks.id, blockId));
  });
  const kept = live.length - replaced.length;
  const speakers = new Set([...speakerPerson.values()].map((s) => s.key)).size;
  return result(
    `refined: ${replaced.length} live → ${created.length} utterances, ${speakers} speakers${kept ? ` (${kept} kept: no audio)` : ""}`,
    true,
    replaced.length,
  );
}

/**
 * Once a chain has ended and all its blocks are refined: merge speaker keys that split across
 * blocks (same voice, see `consolidate`) and mark its conversation refined. Returns whether the
 * conversation is refined now.
 */
export async function finishChain(
  deps: RefineDeps,
  chainId: string,
): Promise<{ finished: boolean; message: string }> {
  const { db } = deps;
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, chainId));
  if (!conv?.endedAt) return { finished: false, message: "chain still open" };
  const chain = await db.select().from(schema.blocks).where(eq(schema.blocks.chainId, chainId));
  if (chain.length === 0 || chain.some((b) => b.status !== "refined")) {
    return { finished: false, message: "blocks still to refine" };
  }
  const ids = chain.map((b) => b.id);
  const renames = consolidate(
    chain.flatMap((b) => b.speakers.map((s) => ({ ...s, blockId: b.id }))),
    deps.clusterThreshold,
  );
  await db.transaction(async (tx) => {
    for (const [from, to] of renames) {
      await tx
        .update(schema.utterances)
        .set({ speakerKey: to })
        .where(
          and(
            inArray(schema.utterances.blockId, ids),
            eq(schema.utterances.speakerKey, from),
            isNull(schema.utterances.supersededAt),
          ),
        );
    }
    for (const b of chain) {
      if (!b.speakers.some((s) => renames.has(s.key))) continue;
      await tx
        .update(schema.blocks)
        .set({
          speakers: mergeProfiles(
            b.speakers.map((s) => ({ ...s, key: renames.get(s.key) ?? s.key })),
          ),
        })
        .where(eq(schema.blocks.id, b.id));
    }
    const rows = await tx
      .select({
        personId: schema.utterances.personId,
        speakerKey: schema.utterances.speakerKey,
        lang: schema.utterances.lang,
      })
      .from(schema.utterances)
      .where(and(inArray(schema.utterances.blockId, ids), isNull(schema.utterances.supersededAt)));
    await tx
      .update(schema.conversations)
      .set({
        status: "refined",
        speakerCount: new Set(rows.map((r) => r.personId ?? r.speakerKey).filter(Boolean)).size,
        languages: [...new Set(rows.map((r) => r.lang).filter((l): l is string => Boolean(l)))],
      })
      .where(eq(schema.conversations.id, chainId));
  });
  return {
    finished: true,
    message: `conversation refined (${chain.length} blocks${renames.size ? `, ${renames.size} keys merged` : ""})`,
  };
}
