import { schema } from "@hearloom/db";
import { aliasWorthLearning, compactName, teachPhrase } from "@hearloom/shared";
import { and, count, eq } from "drizzle-orm";
import { db } from "../db";
import { livePipeline } from "../live/host";
import { TEACH_GRACE_MS } from "../live/voice/detector";
import type { TeachHeard, TeachPrompt, TeachResult } from "../live/voice/types";
import { invalidate } from "../realtime";
import { getSettings, updateSettings } from "../settings";
import { ensureSelfPerson, insertVoiceprint } from "./profile";

const { voiceSamples } = schema;

/**
 * A teaching session ends after this long without progress (a matching sample, or the user acting
 * on the page): speech that doesn't match the prompt doesn't keep it alive, since while it runs
 * the user's wake phrases are taught, not sent.
 */
export const IDLE_MS = 5 * 60_000;
/** …and after this long in any case. */
export const MAX_SESSION_MS = 20 * 60_000;
/** Results shown on the page. */
const KEEP_RESULTS = 12;
/** Browser uploads: one at a time (each is transcribed and embedded), at most so many per window. */
const UPLOAD_TIMEOUT_MS = 30_000;
const MAX_UPLOADS = 20;
const UPLOAD_WINDOW_MS = 10 * 60_000;

interface Session {
  prompt: TeachPrompt;
  /** Samples taken in this session. */
  taken: number;
  results: TeachResult[];
  idle: ReturnType<typeof setTimeout>;
  idleAt: number;
  hardStop: ReturnType<typeof setTimeout>;
  hardStopAt: number;
  /** A browser upload is being processed since (ms). */
  uploadingSince: number | null;
  uploads: number[];
}

const sessions = new Map<string, Session>();
/** When each user's last session stopped (ms), for the grace window. */
const stoppedAt = new Map<string, number>();
/**
 * A stop is remembered this long. Longer than the grace window: a detection arrives only after
 * its command ends (up to 30 s of speech, then a pause), and is judged by when it started.
 */
const STOP_KEEP_MS = TEACH_GRACE_MS + 60_000;

/** Forget stops too old to matter (the map only ever holds recent ones). */
function pruneStops(): void {
  const cutoff = Date.now() - STOP_KEEP_MS;
  for (const [userId, at] of stoppedAt) if (at < cutoff) stoppedAt.delete(userId);
}

export class TeachError extends Error {}

/** Progress: restart the idle timer. */
function touch(userId: string, s: Session): void {
  clearTimeout(s.idle);
  s.idleAt = Date.now() + IDLE_MS;
  s.idle = setTimeout(() => stopTeach(userId, s.prompt.sessionId), IDLE_MS);
}

/**
 * Was speech at `spokenAt` (ms) part of teaching, so it must not be sent? True while a session
 * runs, and for speech that started up to TEACH_GRACE_MS after it stopped (the last phrase may
 * still be on its way through the recognizer when the user presses Done).
 */
export function isTeaching(userId: string, spokenAt: number): boolean {
  if (sessions.has(userId)) return true;
  pruneStops();
  const stopped = stoppedAt.get(userId);
  return stopped !== undefined && spokenAt < stopped + TEACH_GRACE_MS;
}

/** The live pipeline restarted: it forgot the prompts, so send them again. */
export function replayTeach(): void {
  for (const [userId, s] of sessions) livePipeline.teach(userId, s.prompt);
}

async function promptFor(
  userId: string,
  kind: TeachPrompt["kind"],
  sessionId: string,
  personId: string,
): Promise<TeachPrompt> {
  const { voice } = await getSettings(userId);
  const name = voice.names[0]!;
  // Continue through the phrases where the last session left off.
  const [done] = await db
    .select({ n: count() })
    .from(voiceSamples)
    .where(and(eq(voiceSamples.userId, userId), eq(voiceSamples.source, "pendant")));
  const [browser] = await db
    .select({ n: count() })
    .from(voiceSamples)
    .where(and(eq(voiceSamples.userId, userId), eq(voiceSamples.source, "browser")));
  const index = (done?.n ?? 0) + (browser?.n ?? 0);
  return {
    sessionId,
    kind,
    index,
    phrase: kind === "test" ? `Hey ${name}, …` : teachPhrase(name, index),
    personId,
  };
}

/** Start teaching (or a self-test): the live pipeline matches the user's speech to the prompt. */
export async function startTeach(
  userId: string,
  userName: string,
  kind: TeachPrompt["kind"],
): Promise<void> {
  const personId = await ensureSelfPerson(userId, userName);
  const old = sessions.get(userId);
  if (old) {
    clearTimeout(old.idle);
    clearTimeout(old.hardStop);
  }
  const prompt = await promptFor(userId, kind, crypto.randomUUID(), personId);
  const s: Session = {
    prompt,
    taken: 0,
    results: [],
    idle: 0 as never,
    idleAt: 0,
    hardStop: setTimeout(() => stopTeach(userId, prompt.sessionId), MAX_SESSION_MS),
    hardStopAt: Date.now() + MAX_SESSION_MS,
    uploadingSince: null,
    uploads: [],
  };
  sessions.set(userId, s);
  touch(userId, s);
  livePipeline.teach(userId, prompt);
  invalidate(userId, ["voice", "people"]);
}

/** Stop teaching (only that session, if given: a late stop must not end a newer one). */
export function stopTeach(userId: string, sessionId?: string): void {
  const s = sessions.get(userId);
  if (!s || (sessionId && s.prompt.sessionId !== sessionId)) return;
  clearTimeout(s.idle);
  clearTimeout(s.hardStop);
  sessions.delete(userId);
  pruneStops();
  stoppedAt.set(userId, Date.now());
  livePipeline.teach(userId, null);
  invalidate(userId, ["voice"]);
}

/** Move on to the next phrase without a sample. */
export async function skipPhrase(userId: string): Promise<void> {
  const s = sessions.get(userId);
  if (!s) throw new TeachError("not teaching");
  const { voice } = await getSettings(userId);
  s.prompt = {
    ...s.prompt,
    index: s.prompt.index + 1,
    phrase: teachPhrase(voice.names[0]!, s.prompt.index + 1),
  };
  touch(userId, s);
  livePipeline.teach(userId, s.prompt);
  invalidate(userId, ["voice"]);
}

export function teachState(userId: string) {
  const s = sessions.get(userId);
  if (!s) return null;
  return {
    sessionId: s.prompt.sessionId,
    kind: s.prompt.kind,
    index: s.prompt.index,
    phrase: s.prompt.phrase,
    taken: s.taken,
    results: s.results,
    /** When it ends unless there's progress (ms). */
    expiresAt: Math.min(s.idleAt, s.hardStopAt),
  };
}

/** A sample recorded in the browser (16 kHz mono PCM16): processed like pendant speech. */
export function uploadSample(userId: string, sessionId: string, pcm: Int16Array): void {
  const s = sessions.get(userId);
  if (!s || s.prompt.sessionId !== sessionId) throw new TeachError("this teaching session ended");
  if (pcm.length < 8_000) throw new TeachError("the recording is too short");
  if (pcm.length > 16_000 * 15) throw new TeachError("the recording is too long (max 15 s)");
  const now = Date.now();
  if (s.uploadingSince !== null && now - s.uploadingSince < UPLOAD_TIMEOUT_MS)
    throw new TeachError("still listening to the last recording");
  s.uploads = s.uploads.filter((t) => now - t < UPLOAD_WINDOW_MS);
  if (s.uploads.length >= MAX_UPLOADS)
    throw new TeachError(
      "that's a lot of recordings — take a break and try again in a few minutes",
    );
  s.uploads.push(now);
  s.uploadingSince = now;
  touch(userId, s);
  if (!livePipeline.teachAudio(userId, s.prompt, pcm))
    throw new TeachError("the live pipeline is not running");
}

/**
 * The live pipeline heard something during a teaching session. A sample for the current phrase is
 * stored with its voiceprint (if long enough) in one transaction; anything else learns nothing.
 */
export async function onTeachHeard(userId: string, heard: TeachHeard): Promise<void> {
  const s = sessions.get(userId);
  if (!s || s.prompt.sessionId !== heard.sessionId) return;
  const { embedding, ...rest } = heard;
  const r: TeachResult = { ...rest, voiceprintId: null };
  s.results = [r, ...s.results].slice(0, KEEP_RESULTS);
  if (r.source === "browser") s.uploadingSince = null;
  // Only progress keeps the session alive (not the TV, not other people).
  if (r.ok || r.source === "browser") touch(userId, s);
  if (r.kind === "sample" && r.ok && r.index === s.prompt.index) {
    const { personId } = s.prompt;
    r.voiceprintId = await db.transaction(async (tx) => {
      const voiceprintId = embedding
        ? await insertVoiceprint(tx, { userId, personId, embedding, seconds: r.seconds })
        : null;
      await tx.insert(voiceSamples).values({
        userId,
        source: r.source,
        phrase: r.phrase,
        text: r.text,
        heardAs: r.heardAs,
        nameScore: r.nameScore,
        speakerScore: r.speakerScore,
        seconds: r.seconds,
        voiceprintId,
      });
      return voiceprintId;
    });
    await learnAlias(userId, r.heardAs);
    s.taken++;
    const { voice } = await getSettings(userId);
    s.prompt = {
      ...s.prompt,
      index: s.prompt.index + 1,
      phrase: teachPhrase(voice.names[0]!, s.prompt.index + 1),
    };
    livePipeline.teach(userId, s.prompt);
    livePipeline.voiceChanged(userId);
  }
  invalidate(userId, ["voice", "people"]);
}

/** Add how the recognizer spells the name in the user's voice, if it's new and plausible. */
async function learnAlias(userId: string, heardAs: string | null): Promise<void> {
  if (!heardAs) return;
  const { voice } = await getSettings(userId);
  const key = compactName(heardAs);
  const seen = await db
    .select({ heardAs: voiceSamples.heardAs })
    .from(voiceSamples)
    .where(eq(voiceSamples.userId, userId));
  const times = seen.filter((r) => r.heardAs && compactName(r.heardAs) === key).length;
  if (!aliasWorthLearning(heardAs, voice, times)) return;
  await updateSettings(userId, { voice: { aliases: [...voice.aliases, heardAs].slice(-20) } });
}

/** Tests: how many stops are remembered for the grace window. */
export function rememberedStops(): number {
  return stoppedAt.size;
}

/** Tests: forget all sessions. */
export function resetTeach(): void {
  for (const s of sessions.values()) {
    clearTimeout(s.idle);
    clearTimeout(s.hardStop);
  }
  sessions.clear();
  stoppedAt.clear();
}
