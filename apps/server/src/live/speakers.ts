import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { cosine } from "@hearloom/inference";
import { and, eq } from "drizzle-orm";

interface Print {
  personId: string;
  name: string;
  isSelf: boolean;
  embedding: Float32Array;
}

export interface SpeakerMatch {
  personId: string;
  name: string;
  isSelf: boolean;
  score: number;
}

/** Enrolled voiceprints per user (refreshed every minute), matched by cosine similarity. */
export class SpeakerDirectory {
  private cache = new Map<string, { at: number; prints: Print[] }>();

  constructor(
    private readonly db: Db,
    private readonly model: string,
    private readonly threshold: number,
  ) {}

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private async prints(userId: string): Promise<Print[]> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.prints;
    const rows = await this.db
      .select({
        personId: schema.people.id,
        name: schema.people.name,
        isSelf: schema.people.isSelf,
        embedding: schema.voiceprints.embedding,
      })
      .from(schema.voiceprints)
      .innerJoin(schema.people, eq(schema.people.id, schema.voiceprints.personId))
      .where(and(eq(schema.voiceprints.userId, userId), eq(schema.voiceprints.model, this.model)));
    const prints = rows.map((r) => ({ ...r, embedding: Float32Array.from(r.embedding) }));
    this.cache.set(userId, { at: Date.now(), prints });
    return prints;
  }

  /** The user has enrolled their own voice (so their speech can be recognized as theirs). */
  async hasSelf(userId: string): Promise<boolean> {
    return (await this.prints(userId)).some((p) => p.isSelf);
  }

  /** Best similarity to the user's own voiceprints (null: none enrolled), and to anyone else's. */
  async compare(
    userId: string,
    embedding: Float32Array,
  ): Promise<{ self: number | null; other: number }> {
    let self: number | null = null;
    let other = 0;
    for (const p of await this.prints(userId)) {
      const score = cosine(embedding, p.embedding);
      if (p.isSelf) self = Math.max(self ?? -1, score);
      else other = Math.max(other, score);
    }
    return { self, other };
  }

  /**
   * The best match at or above the threshold. `ownerBar`: the user's own-voice bar for voice
   * commands; their own voice matches from it when it's lower than the threshold, so a line isn't
   * held to a stricter bar than a command (and their near misses are tagged as theirs).
   */
  async identify(
    userId: string,
    embedding: Float32Array,
    ownerBar?: number | null,
  ): Promise<SpeakerMatch | null> {
    const selfThreshold = Math.min(this.threshold, ownerBar ?? this.threshold);
    // The closest voice first, then its own bar: a voice closer to someone else is never the
    // user's, however low the user's bar.
    let best: SpeakerMatch | null = null;
    for (const p of await this.prints(userId)) {
      const score = cosine(embedding, p.embedding);
      if (!best || score > best.score)
        best = { personId: p.personId, name: p.name, isSelf: p.isSelf, score };
    }
    if (!best) return null;
    return best.score >= (best.isSelf ? selfThreshold : this.threshold) ? best : null;
  }
}

/** A match this far above the clustering threshold is clearly that voice. */
const CLEAR_MATCH_MARGIN = 0.15;

/**
 * Groups unidentified voices within one chain of speech into S1, S2, … by embedding similarity, and
 * gives engine speaker labels (e.g. Soniox's per-session numbers) keys from the same series.
 */
export class SpeakerClusters {
  private clusters: { key: string; centroid: Float32Array; n: number }[] = [];
  private aliases = new Map<string, string>();
  private next: number;

  /** `first`: number of the first key handed out (continue a chain's existing keys). */
  constructor(
    private readonly threshold = 0.6,
    first = 1,
  ) {
    this.next = first;
  }

  /** `exclude`: keys that can't be this voice. */
  assign(embedding: Float32Array, exclude?: ReadonlySet<string>): string {
    let best: (typeof this.clusters)[number] | null = null;
    let bestScore = -1;
    for (const c of this.clusters) {
      if (exclude?.has(c.key)) continue;
      const s = cosine(embedding, c.centroid);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    if (best && bestScore >= this.threshold) {
      for (let i = 0; i < best.centroid.length; i++) {
        best.centroid[i] = (best.centroid[i]! * best.n + embedding[i]!) / (best.n + 1);
      }
      best.n++;
      return best.key;
    }
    const key = `S${this.next++}`;
    this.clusters.push({ key, centroid: Float32Array.from(embedding), n: 1 });
    return key;
  }

  /** Stable `S…` key for an engine's speaker label within this chain. */
  alias(external: string): string {
    let key = this.aliases.get(external);
    if (!key) {
      key = `S${this.next++}`;
      this.aliases.set(external, key);
    }
    return key;
  }

  /** The cluster closest to `embedding`, if any. */
  private closest(embedding: Float32Array): { key: string; score: number } | null {
    let best: { key: string; score: number } | null = null;
    for (const c of this.clusters) {
      const score = cosine(embedding, c.centroid);
      if (!best || score > best.score) best = { key: c.key, score };
    }
    return best;
  }

  /**
   * Key for an engine's speaker label (`session`: the labels' scope, e.g. one Soniox session, whose
   * labels restart at 1). Decided by the label's first utterance and then kept: by its voice's
   * cluster in this chain if `embedding` is given (so a voice keeps one key across sessions; pass
   * one only for enough audio to be sure), else (too short to tell) a fresh key. A cluster another
   * label of the same session already has is someone else, per the engine; if the voice clearly is
   * that cluster's anyway, the label gets a fresh key without a cluster (no second cluster for one
   * voice).
   */
  label(external: string, session: string, embedding: Float32Array | null): string {
    const known = this.aliases.get(external);
    const taken = new Set<string>();
    for (const [label, k] of this.aliases)
      if (label !== external && label.startsWith(session)) taken.add(k);
    const best = embedding ? this.closest(embedding) : null;
    if (known) {
      // Keyed while too short to tell: its voice, once heard, can be matched by later sessions
      // (unless it's like a known voice: one cluster per voice).
      if (
        embedding &&
        !this.clusters.some((c) => c.key === known) &&
        (!best || best.score < this.threshold)
      )
        this.clusters.push({ key: known, centroid: Float32Array.from(embedding), n: 1 });
      return known;
    }
    const clearlyTaken =
      !!best && taken.has(best.key) && best.score >= this.threshold + CLEAR_MATCH_MARGIN;
    const key = embedding && !clearlyTaken ? this.assign(embedding, taken) : `S${this.next++}`;
    this.aliases.set(external, key);
    return key;
  }
}
