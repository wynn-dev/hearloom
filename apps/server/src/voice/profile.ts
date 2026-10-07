import { schema } from "@hearloom/db";
import { SPEAKER_MODEL_ID } from "@hearloom/inference";
import { and, avg, count, desc, eq, isNotNull, ne, sum } from "drizzle-orm";
import { db } from "../db";
import { commandThreshold, MIN_PRINT_SAMPLES } from "../live/voice/detector";

const { people, voiceprints, voiceSamples } = schema;

/** Teaching samples and seconds of voice that make a solid voice model. */
export const GOOD_SAMPLES = 8;
export const GOOD_SECONDS = 30;

export async function selfPersonId(userId: string): Promise<string | null> {
  const [me] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.userId, userId), eq(people.isSelf, true)));
  return me?.id ?? null;
}

/** The user's own person, created if missing (like "This is me" on an utterance). */
export async function ensureSelfPerson(userId: string, name: string): Promise<string> {
  const id = await selfPersonId(userId);
  if (id) return id;
  const [row] = await db
    .insert(people)
    .values({ userId, name: name || "Me", isSelf: true })
    .returning({ id: people.id });
  return row!.id;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Store a voiceprint of the user's own voice learned for voice commands (a teaching sample or a
 * confirmed command), in the transaction that inserts the `voice_samples` row linking it: a
 * voiceprint without its sample would count as the user's voice, but nothing could remove it.
 */
export async function insertVoiceprint(
  tx: Tx,
  v: { userId: string; personId: string; embedding: number[]; seconds: number },
): Promise<string> {
  const [row] = await tx
    .insert(voiceprints)
    .values({
      userId: v.userId,
      personId: v.personId,
      model: SPEAKER_MODEL_ID,
      embedding: v.embedding,
      sampleSeconds: v.seconds,
      source: "enrollment",
    })
    .returning({ id: voiceprints.id });
  return row!.id;
}

/** How well Hearloom knows the user's voice and how they say the agent's name. */
export async function voiceProfile(userId: string) {
  const personId = await selfPersonId(userId);
  const [prints] = personId
    ? await db
        .select({ n: count(), seconds: sum(voiceprints.sampleSeconds) })
        .from(voiceprints)
        .where(
          and(
            eq(voiceprints.userId, userId),
            eq(voiceprints.personId, personId),
            eq(voiceprints.model, SPEAKER_MODEL_ID),
          ),
        )
    : [{ n: 0, seconds: "0" }];
  const [samples] = await db
    .select({ n: count(), avgScore: avg(voiceSamples.speakerScore) })
    .from(voiceSamples)
    .where(eq(voiceSamples.userId, userId));
  const recent = await db
    .select({
      score: voiceSamples.speakerScore,
      nameScore: voiceSamples.nameScore,
      source: voiceSamples.source,
    })
    .from(voiceSamples)
    .where(eq(voiceSamples.userId, userId))
    .orderBy(desc(voiceSamples.createdAt))
    .limit(50);
  // Same samples as the live pipeline's threshold: taught ones, not vouched-for commands.
  const scores = recent.flatMap((r) =>
    r.score === null || r.source === "command" ? [] : [r.score],
  );
  const [scored] = await db
    .select({ n: count() })
    .from(voiceSamples)
    .where(
      and(
        eq(voiceSamples.userId, userId),
        isNotNull(voiceSamples.speakerScore),
        ne(voiceSamples.source, "command"),
      ),
    );
  const voiceprintCount = prints?.n ?? 0;
  const voiceSeconds = Number(prints?.seconds ?? 0);
  const sampleCount = samples?.n ?? 0;
  const progress = Math.min(
    1,
    0.5 * Math.min(1, sampleCount / GOOD_SAMPLES) + 0.5 * Math.min(1, voiceSeconds / GOOD_SECONDS),
  );
  return {
    personId,
    voiceprints: voiceprintCount,
    voiceSeconds,
    samples: sampleCount,
    /** Average similarity of samples to the voice learned before them (consistency). */
    consistency:
      samples?.avgScore === null || samples?.avgScore === undefined
        ? null
        : Number(samples.avgScore),
    /** Share of recent samples whose name the matcher recognized (as configured then). */
    nameRecognition:
      recent.length === 0 ? null : recent.filter((r) => r.nameScore > 0).length / recent.length,
    /** Own-voice similarity a command needs (learned from the samples). */
    threshold: commandThreshold(scores),
    thresholdLearned: (scored?.n ?? 0) >= 3,
    /** 0..1: how much teaching is done (samples and seconds of voice). */
    progress,
    /** Voice commands can be turned on (a voiceprint of the user's own voice exists). */
    canEnable: voiceprintCount > 0,
    minPrintSeconds: MIN_PRINT_SAMPLES / 16_000,
  };
}
