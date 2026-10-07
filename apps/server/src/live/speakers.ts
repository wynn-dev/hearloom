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

  async identify(userId: string, embedding: Float32Array): Promise<SpeakerMatch | null> {
    let best: SpeakerMatch | null = null;
    for (const p of await this.prints(userId)) {
      const score = cosine(embedding, p.embedding);
      if (score >= this.threshold && (!best || score > best.score)) {
        best = { personId: p.personId, name: p.name, isSelf: p.isSelf, score };
      }
    }
    return best;
  }
}

/**
 * Groups unidentified voices within one conversation into S1, S2, … by embedding similarity, and
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

  assign(embedding: Float32Array): string {
    let best: (typeof this.clusters)[number] | null = null;
    let bestScore = -1;
    for (const c of this.clusters) {
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

  /** Stable `S…` key for an engine's speaker label within this conversation. */
  alias(external: string): string {
    let key = this.aliases.get(external);
    if (!key) {
      key = `S${this.next++}`;
      this.aliases.set(external, key);
    }
    return key;
  }
}
