import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { cosine, SPEAKER_MODEL_ID, type SpeakerEmbedder } from "@hearloom/inference";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { concatPieces, loadStreamPieces } from "../audio/load";
import { scribeTranscribe } from "../providers/elevenlabs";
import type { Diarizer, DiarSegment } from "./diarizer";
import { type NewUtterance, wordsToUtterances } from "./words";

export interface RefineDeps {
  db: Db;
  embedder: SpeakerEmbedder | null;
  diarizer: Diarizer | null;
  provider: "elevenlabs" | "keep";
  elevenlabs: { apiKey: string; enableLogging: boolean } | null;
  matchThreshold: number;
  log(message: string): void;
}

interface Turn {
  speaker: string;
  startAt: number;
  endAt: number;
}

/** Longest stretch refined in one pass (diarizer memory, upload size); longer ones are split. */
const MAX_WINDOW_MS = 3 * 3600_000;
const LANG3: Record<string, string> = {
  eng: "en",
  nld: "nl",
  deu: "de",
  fra: "fr",
  spa: "es",
  ita: "it",
};

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

/**
 * Refine a finished conversation: re-diarize the whole conversation offline (consistent speakers),
 * identify voices against enrolled people, optionally re-transcribe with a stronger batch model,
 * and replace the live rows that were re-derived (rows without audio are kept).
 */
export async function refineConversation(
  deps: RefineDeps,
  conversationId: string,
): Promise<string> {
  try {
    return await refineNow(deps, conversationId);
  } catch (err) {
    // Don't leave it "refining" forever if this was the last attempt; a retry sets it again.
    await deps.db
      .update(schema.conversations)
      .set({ status: "closed" })
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.status, "refining"),
        ),
      )
      .catch(() => {});
    throw err;
  }
}

async function refineNow(deps: RefineDeps, conversationId: string): Promise<string> {
  const { db } = deps;
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId));
  if (!conv) return "missing";
  if (!conv.endedAt) throw new Error("conversation still open");
  if (conv.status === "refined") return "already refined";
  if (!deps.diarizer && deps.provider === "keep")
    return "nothing to do (no diarizer, no batch provider)";

  const live = await db
    .select()
    .from(schema.utterances)
    .where(
      and(
        eq(schema.utterances.conversationId, conversationId),
        isNull(schema.utterances.supersededAt),
      ),
    );
  if (live.length === 0) {
    await db
      .update(schema.conversations)
      .set({ status: "refined" })
      .where(eq(schema.conversations.id, conversationId));
    return "empty";
  }
  await db
    .update(schema.conversations)
    .set({ status: "refining" })
    .where(eq(schema.conversations.id, conversationId));

  const people = await db
    .select({
      id: schema.people.id,
      isSelf: schema.people.isSelf,
      name: schema.people.name,
      embedding: schema.voiceprints.embedding,
    })
    .from(schema.voiceprints)
    .innerJoin(schema.people, eq(schema.people.id, schema.voiceprints.personId))
    .where(
      and(
        eq(schema.voiceprints.userId, conv.userId),
        eq(schema.voiceprints.model, SPEAKER_MODEL_ID),
      ),
    );
  const names = [...new Set(people.map((p) => p.name))];

  const created: (NewUtterance & {
    streamId: string;
    /**
     * Identity from this utterance's own voiceprint, which wins over the cluster's:
     * a person, null = clearly not the cluster's person, undefined = no opinion.
     */
    own?: { personId: string; isSelf: boolean } | null;
  })[] = [];
  const soundRows: { streamId: string; label: string; startAt: number; endAt: number }[] = [];
  const speakerPerson = new Map<
    string,
    { personId: string | null; isSelf: boolean | null; key: string }
  >();
  let anonymous = 0;
  /** Live rows re-derived by this pass (only these are superseded). */
  const replaced: typeof live = [];

  // Usually one stream per conversation; reconnects can split it. Rows without a stream (no audio)
  // stay as they are.
  const byStream = new Map<string, typeof live>();
  for (const u of live) {
    if (!u.streamId) continue;
    byStream.set(u.streamId, [...(byStream.get(u.streamId) ?? []), u]);
  }
  const passes = [...byStream].flatMap(([streamId, rows]) =>
    windows(rows, MAX_WINDOW_MS).map((utts) => ({ streamId, utts })),
  );

  for (const [pass, { streamId, utts }] of passes.entries()) {
    const from = Math.min(...utts.map((u) => u.startAt.getTime())) - 300;
    const to = Math.max(...utts.map((u) => u.endAt.getTime())) + 300;
    const pieces = await loadStreamPieces(db, streamId, from, to);
    if (pieces.length === 0) continue; // audio gone: keep the live rows
    const { samples, toAbs, toOffset } = concatPieces(pieces);
    const firstNew = created.length;
    /** Cluster keys are per pass: diarizer labels restart in every pass. */
    const tag = `${pass}:`;
    replaced.push(...utts);

    // 1) Offline diarization over the whole conversation.
    let turns: Turn[] = [];
    if (deps.diarizer) {
      const segs: DiarSegment[] = await deps.diarizer.diarize(samples);
      turns = segs.map((s) => ({
        speaker: s.speaker,
        startAt: toAbs(s.start),
        endAt: toAbs(s.end),
      }));
      // 2) Name each cluster by matching its voice against enrolled people.
      for (const speaker of new Set(segs.map((s) => s.speaker))) {
        const key = `${tag}${speaker}`;
        let audio = new Float32Array(0);
        for (const s of segs.filter((x) => x.speaker === speaker)) {
          const part = samples.subarray(Math.floor(s.start * 16000), Math.floor(s.end * 16000));
          const next = new Float32Array(audio.length + part.length);
          next.set(audio);
          next.set(part, audio.length);
          audio = next;
          if (audio.length > 30 * 16000) break;
        }
        let match: { personId: string; isSelf: boolean } | null = null;
        if (deps.embedder && audio.length >= 16000) {
          const emb = deps.embedder.embed(audio);
          let best = deps.matchThreshold;
          for (const p of people) {
            const score = cosine(emb, p.embedding);
            if (score >= best) {
              best = score;
              match = { personId: p.id, isSelf: p.isSelf };
            }
          }
        }
        // Fresh key either way: shown when an utterance's own voice check drops the name.
        speakerPerson.set(key, {
          personId: match?.personId ?? null,
          isSelf: match ? match.isSelf : null,
          key: `S${++anonymous}`,
        });
      }
    }

    // 3) Text: a stronger batch model, or keep the live text and only fix speakers.
    if (deps.provider === "elevenlabs" && deps.elevenlabs) {
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++)
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768)));
      const result = await scribeTranscribe(pcm, { ...deps.elevenlabs, keyterms: names });
      const { utterances, events } = wordsToUtterances(
        result.words,
        toAbs,
        (a, b, scribeSpeaker) => {
          const s = turns.length
            ? speakerFor(turns, a, b)
            : scribeSpeaker
              ? `scribe_${scribeSpeaker}`
              : null;
          return s ? `${tag}${s}` : null;
        },
      );
      const fallbackLang = LANG3[result.language_code] ?? result.language_code?.slice(0, 2) ?? null;
      for (const u of utterances) created.push({ ...u, lang: u.lang ?? fallbackLang, streamId });
      for (const e of events) soundRows.push({ streamId, ...e });
    } else {
      for (const u of utts) {
        const s = speakerFor(turns, u.startAt.getTime(), u.endAt.getTime());
        created.push({
          startAt: u.startAt.getTime(),
          endAt: u.endAt.getTime(),
          text: u.text,
          lang: u.lang,
          speaker: s ? `${tag}${s}` : null,
          confidence: u.confidence,
          provider: u.provider,
          model: u.model,
          streamId,
        });
      }
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

  // Speakers that only came from Scribe (no diarizer): anonymous labels.
  for (const u of created) {
    if (u.speaker && !speakerPerson.has(u.speaker)) {
      speakerPerson.set(u.speaker, { personId: null, isSelf: null, key: `S${++anonymous}` });
    }
  }

  if (replaced.length === 0) {
    await db
      .update(schema.conversations)
      .set({ status: "closed" })
      .where(eq(schema.conversations.id, conversationId));
    return "no stored audio to refine";
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
      throw new Error("conversation changed while refining; retrying");
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
            userId: conv.userId,
            conversationId,
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
    if (soundRows.length > 0) {
      await tx.insert(schema.soundEvents).values(
        soundRows.map((e) => ({
          userId: conv.userId,
          streamId: e.streamId,
          startAt: new Date(e.startAt),
          endAt: new Date(Math.max(e.endAt, e.startAt)),
          label: e.label,
          kind: "point" as const,
          confidence: 1,
          audiosetLabels: [],
          source: "refine",
          model: "scribe_v2",
        })),
      );
    }
    const speakers = new Set(
      created
        .map((u) =>
          u.own
            ? u.own.personId
            : u.speaker
              ? u.own === null
                ? u.speaker
                : (speakerPerson.get(u.speaker)?.personId ?? u.speaker)
              : null,
        )
        .filter(Boolean),
    );
    await tx
      .update(schema.conversations)
      .set({
        status: "refined",
        speakerCount: speakers.size,
        languages: [...new Set(created.map((u) => u.lang).filter((l): l is string => Boolean(l)))],
      })
      .where(eq(schema.conversations.id, conversationId));
  });
  const kept = live.length - replaced.length;
  return `refined: ${replaced.length} live → ${created.length} utterances, ${speakerPerson.size} speakers${kept ? ` (${kept} kept: no audio)` : ""}`;
}
