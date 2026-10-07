import { schema } from "@hearloom/db";
import { aliasWorthLearning, compactName, teachPhrase } from "@hearloom/shared";
import { and, count, eq } from "drizzle-orm";
import { db } from "../db";
import { livePipeline } from "../live/host";
import type { TeachPrompt, TeachResult } from "../live/voice/types";
import { invalidate } from "../realtime";
import { getSettings, updateSettings } from "../settings";
import { ensureSelfPerson } from "./profile";

const { voiceSamples } = schema;

/** A teaching session ends after this long without a sample (the page was left open). */
const IDLE_MS = 5 * 60_000;
/** Results shown on the page. */
const KEEP_RESULTS = 12;

interface Session {
  prompt: TeachPrompt;
  /** Samples taken in this session. */
  taken: number;
  results: TeachResult[];
  touchedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();

export class TeachError extends Error {}

function touch(userId: string, s: Session): void {
  clearTimeout(s.timer);
  s.touchedAt = Date.now();
  s.timer = setTimeout(() => stopTeach(userId), IDLE_MS);
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
  if (old) clearTimeout(old.timer);
  const prompt = await promptFor(userId, kind, crypto.randomUUID(), personId);
  const s: Session = { prompt, taken: 0, results: [], touchedAt: Date.now(), timer: 0 as never };
  sessions.set(userId, s);
  touch(userId, s);
  livePipeline.teach(userId, prompt);
  invalidate(userId, ["voice", "people"]);
}

export function stopTeach(userId: string): void {
  const s = sessions.get(userId);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(userId);
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
  };
}

/** A sample recorded in the browser (16 kHz mono PCM16): processed like pendant speech. */
export function uploadSample(userId: string, sessionId: string, pcm: Int16Array): void {
  const s = sessions.get(userId);
  if (!s || s.prompt.sessionId !== sessionId) throw new TeachError("this teaching session ended");
  if (pcm.length < 8_000) throw new TeachError("the recording is too short");
  if (pcm.length > 16_000 * 15) throw new TeachError("the recording is too long (max 15 s)");
  touch(userId, s);
  if (!livePipeline.teachAudio(userId, s.prompt, pcm))
    throw new TeachError("the live pipeline is not running");
}

/** The live pipeline heard something during a teaching session. */
export async function onTeachHeard(userId: string, r: TeachResult): Promise<void> {
  const s = sessions.get(userId);
  if (!s || s.prompt.sessionId !== r.sessionId) return;
  s.results = [r, ...s.results].slice(0, KEEP_RESULTS);
  touch(userId, s);
  if (r.kind === "sample" && r.ok && r.index === s.prompt.index) {
    await db.insert(voiceSamples).values({
      userId,
      source: r.source,
      phrase: r.phrase,
      text: r.text,
      heardAs: r.heardAs,
      nameScore: r.nameScore,
      speakerScore: r.speakerScore,
      seconds: r.seconds,
      voiceprintId: r.voiceprintId,
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

/** Tests: forget all sessions. */
export function resetTeach(): void {
  for (const s of sessions.values()) clearTimeout(s.timer);
  sessions.clear();
}
