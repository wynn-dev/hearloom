import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { cosine, SPEAKER_MODEL_ID } from "@hearloom/inference";
import { and, eq } from "drizzle-orm";
import { selfPrintVerdict } from "./voice/detector";

export interface EnrollDeps {
  db: Db;
  embed(audio: Float32Array): Float32Array;
  /** 16 kHz audio of a stream between two absolute times (stored chunks). */
  loadAudio(streamId: string, from: number, to: number): Promise<Float32Array | null>;
  /** The user's own-voice bar for voice commands. */
  minScore(userId: string): Promise<number>;
}

export interface EnrollResult {
  sampleSeconds: number;
  /** Why no voiceprint was learned (the utterance is attributed anyway); null if one was. */
  note: string | null;
}

/**
 * "This is me" / "This is <name>": attribute an utterance to a person and learn a voiceprint from
 * its stored audio. One of the user's own voiceprints must sound like the ones learned so far and
 * not repeat one (see selfPrintVerdict): one bad clip would loosen the own-voice gate for good.
 */
export async function enrollUtterance(
  deps: EnrollDeps,
  msg: { userId: string; personId: string; utteranceId: string },
): Promise<EnrollResult> {
  const { db } = deps;
  const [u] = await db
    .select()
    .from(schema.utterances)
    .where(
      and(eq(schema.utterances.id, msg.utteranceId), eq(schema.utterances.userId, msg.userId)),
    );
  if (!u) throw new Error("utterance not found");
  if (!u.streamId) throw new Error("utterance has no audio");
  const audio = await deps.loadAudio(u.streamId, u.startAt.getTime(), u.endAt.getTime());
  if (!audio || audio.length < 16_000) throw new Error("need at least 1 s of stored audio");
  const embedding = deps.embed(audio);
  const [person] = await db
    .select({ isSelf: schema.people.isSelf })
    .from(schema.people)
    .where(and(eq(schema.people.id, msg.personId), eq(schema.people.userId, msg.userId)));
  if (!person) throw new Error("person not found");
  const note = person.isSelf ? await selfCheck(deps, msg.userId, u.id, embedding) : null;
  await db.transaction(async (tx) => {
    // Re-attributing an utterance replaces the voiceprint learned from it (it was the wrong person).
    await tx
      .delete(schema.voiceprints)
      .where(
        and(eq(schema.voiceprints.userId, msg.userId), eq(schema.voiceprints.utteranceId, u.id)),
      );
    if (note) return;
    await tx.insert(schema.voiceprints).values({
      userId: msg.userId,
      personId: msg.personId,
      utteranceId: u.id,
      model: SPEAKER_MODEL_ID,
      embedding: Array.from(embedding),
      sampleSeconds: audio.length / 16000,
      source: "confirmed",
    });
  });
  await db
    .update(schema.utterances)
    .set({ personId: msg.personId, isWearer: person.isSelf })
    .where(eq(schema.utterances.id, u.id));
  return { sampleSeconds: audio.length / 16000, note };
}

/** Why this clip mustn't become one of the user's voiceprints (null: it may). */
async function selfCheck(
  deps: EnrollDeps,
  userId: string,
  utteranceId: string,
  embedding: Float32Array,
): Promise<string | null> {
  const rows = await deps.db
    .select({
      utteranceId: schema.voiceprints.utteranceId,
      embedding: schema.voiceprints.embedding,
      isSelf: schema.people.isSelf,
    })
    .from(schema.voiceprints)
    .innerJoin(schema.people, eq(schema.people.id, schema.voiceprints.personId))
    .where(
      and(eq(schema.voiceprints.userId, userId), eq(schema.voiceprints.model, SPEAKER_MODEL_ID)),
    );
  let self: number | null = null;
  let other = 0;
  for (const r of rows) {
    // This utterance's own earlier voiceprint is replaced, not compared with.
    if (r.utteranceId === utteranceId) continue;
    const score = cosine(embedding, Float32Array.from(r.embedding));
    if (r.isSelf) self = Math.max(self ?? -1, score);
    else other = Math.max(other, score);
  }
  const refused = selfPrintVerdict({ self, other }, await deps.minScore(userId));
  return refused ? `Attributed to you, but no voiceprint learned: ${lower(refused)}` : null;
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
