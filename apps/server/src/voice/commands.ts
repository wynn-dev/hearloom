import { schema } from "@hearloom/db";
import { aliasWorthLearning, compactName, type HapticPattern } from "@hearloom/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import { sendWebhook } from "../agent/webhooks";
import { db } from "../db";
import { isPhoneOnline, sendToPhone } from "../ingest/phones";
import { livePipeline } from "../live/host";
import type { VoiceDetection } from "../live/voice/types";
import { notify } from "../notify/gateway";
import { invalidate } from "../realtime";
import { getSettings, updateSettings } from "../settings";
import {
  ATTEMPT_TIMEOUT_MS,
  type DeliveryOutcome,
  deliverWithRetries,
  describeFailure,
} from "./deliver";
import { selfPersonId } from "./profile";

const { voiceCommands, voiceSamples, voiceprints, phones } = schema;
type CommandRow = typeof voiceCommands.$inferSelect;

/** Gap between the two pulses of the failure buzz. */
const DOUBLE_BUZZ_GAP_MS = 350;

/** The `voice.command` webhook body (plus `userId` and `sentAt`, added by the sender). */
export function commandEvent(row: CommandRow, attempt: number, test = false) {
  return {
    id: row.id,
    type: "voice.command",
    command: row.command,
    transcript: row.transcript,
    wakeName: row.wakeName,
    heardAs: row.heardAs,
    spokenAt: row.spokenAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    lang: row.lang,
    speaker: { verified: row.speakerScore !== null, score: row.speakerScore },
    attempt,
    ...(test ? { test: true } : {}),
  };
}

/** Buzz the pendant(s) of every online phone of the user. */
async function buzz(userId: string, pattern: HapticPattern, times = 1): Promise<void> {
  const rows = await db.select({ id: phones.id }).from(phones).where(eq(phones.userId, userId));
  const online = rows.filter((p) => isPhoneOnline(p.id));
  for (let i = 0; i < times; i++) {
    if (i > 0) await Bun.sleep(DOUBLE_BUZZ_GAP_MS);
    for (const p of online) sendToPhone(p.id, { t: "haptic", pattern });
  }
}

/** A wake phrase from the live pipeline: store it, and deliver it if it should go to the agent. */
export async function onDetection(d: VoiceDetection): Promise<void> {
  const [row] = await db
    .insert(voiceCommands)
    .values({
      id: d.id,
      userId: d.userId,
      streamId: d.streamId,
      spokenAt: new Date(d.spokenAt),
      endedAt: new Date(d.endedAt),
      detectedAt: new Date(d.detectedAt),
      wakeName: d.wakeName,
      heardAs: d.heardAs,
      nameScore: d.nameScore,
      transcript: d.transcript,
      command: d.command,
      lang: d.lang,
      speakerScore: d.speakerScore,
      status: d.status,
      reason: d.reason,
    })
    .onConflictDoNothing()
    .returning();
  invalidate(d.userId, ["voice"]);
  if (row && row.status === "pending") await deliver(row);
}

/**
 * Send a command to the agent with retries, then tell the user how it went: a short buzz when the
 * agent took it; a double buzz and a silent notification when it didn't.
 */
export async function deliver(row: CommandRow, test = false): Promise<DeliveryOutcome> {
  const { agent } = await getSettings(row.userId);
  const outcome: DeliveryOutcome = agent.webhookUrl
    ? await deliverWithRetries(async (attempt) => {
        const r = await sendWebhook(row.userId, commandEvent(row, attempt, test), {
          timeoutMs: ATTEMPT_TIMEOUT_MS,
          readBody: true,
        });
        return r.status === 0
          ? { error: r.error ?? "network error" }
          : { status: r.status, body: r.body ?? "" };
      }, row.spokenAt.getTime())
    : { status: "failed", reason: "no_webhook", attempts: 0, httpStatus: null };
  await db
    .update(voiceCommands)
    .set({
      status: test ? "test" : outcome.status,
      reason: outcome.status === "sent" ? null : outcome.reason,
      attempts: outcome.attempts,
      httpStatus: outcome.httpStatus,
      sentAt: outcome.status === "sent" ? new Date() : null,
    })
    .where(eq(voiceCommands.id, row.id));
  invalidate(row.userId, ["voice"]);
  if (test) return outcome;
  if (outcome.status === "sent") {
    await buzz(row.userId, "short");
  } else {
    await buzz(row.userId, "short", 2);
    await notify({
      userId: row.userId,
      category: "voice_command",
      title: `Couldn't reach ${row.wakeName}`,
      body: `“${row.command.slice(0, 120)}” wasn't sent: ${describeFailure(outcome.reason)}.`,
      interruptionLevel: "passive",
      deepLink: "/voice",
    }).catch((err) => console.error("[voice] failure notification", err));
  }
  return outcome;
}

/** "Send test command" on the Voice page: a signed `voice.command` with `test: true`. */
export async function sendTestCommand(userId: string): Promise<CommandRow & DeliveryOutcome> {
  const { voice } = await getSettings(userId);
  const name = voice.names[0] ?? "Hermes";
  const now = new Date();
  const command = "This is a test from Hearloom. Reply with a short confirmation.";
  const [row] = await db
    .insert(voiceCommands)
    .values({
      id: crypto.randomUUID(),
      userId,
      spokenAt: now,
      endedAt: now,
      detectedAt: now,
      wakeName: name,
      heardAs: name,
      nameScore: 1,
      transcript: `Hey ${name}, ${command}`,
      command,
      status: "test",
    })
    .returning();
  const outcome = await deliver(row!, true);
  return { ...row!, ...outcome };
}

export async function listCommands(userId: string, limit: number, before?: Date) {
  return db
    .select()
    .from(voiceCommands)
    .where(
      and(
        eq(voiceCommands.userId, userId),
        before ? lt(voiceCommands.spokenAt, before) : undefined,
      ),
    )
    .orderBy(desc(voiceCommands.spokenAt))
    .limit(limit);
}

export class FeedbackError extends Error {}

/**
 * The user's verdict on a detection. "confirmed" (it was me, and right) and "missed" (it was me:
 * it should have fired) are learned from: the command's audio becomes a voiceprint sample and the
 * way the name was heard an alias. "false_trigger" undoes that and blocks the spelling from loose
 * matching. null clears the verdict.
 */
export async function setFeedback(
  userId: string,
  id: string,
  feedback: "confirmed" | "false_trigger" | "missed" | null,
): Promise<void> {
  const [row] = await db
    .select()
    .from(voiceCommands)
    .where(and(eq(voiceCommands.id, id), eq(voiceCommands.userId, userId)));
  if (!row) throw new FeedbackError("voice command not found");
  if (row.status === "test") throw new FeedbackError("test commands can't be rated");

  // Undo what an earlier verdict taught.
  const learned = await db
    .delete(voiceSamples)
    .where(and(eq(voiceSamples.commandId, id), eq(voiceSamples.userId, userId)))
    .returning({ voiceprintId: voiceSamples.voiceprintId });
  for (const l of learned) {
    if (l.voiceprintId)
      await db
        .delete(voiceprints)
        .where(and(eq(voiceprints.id, l.voiceprintId), eq(voiceprints.userId, userId)));
  }
  await db.update(voiceCommands).set({ feedback }).where(eq(voiceCommands.id, id));

  const { voice } = await getSettings(userId);
  const heard = compactName(row.heardAs);
  if (feedback === "false_trigger") {
    // A loose match on someone else's word: don't match it loosely again.
    const isName = voice.names.some((n) => compactName(n) === heard);
    if (!isName && !voice.blocked.some((b) => compactName(b) === heard)) {
      await updateSettings(userId, {
        voice: {
          blocked: [...voice.blocked, row.heardAs].slice(-20),
          aliases: voice.aliases.filter((a) => compactName(a) !== heard),
        },
      });
    }
  } else if (feedback === "confirmed" || feedback === "missed") {
    if (aliasWorthLearning(row.heardAs, { ...voice, aliases: voice.aliases }, 2)) {
      await updateSettings(userId, {
        voice: {
          aliases: [...voice.aliases, row.heardAs].slice(-20),
          blocked: voice.blocked.filter((b) => compactName(b) !== heard),
        },
      });
    }
    let voiceprintId: string | null = null;
    let seconds = (row.endedAt.getTime() - row.spokenAt.getTime()) / 1000;
    const personId = await selfPersonId(userId);
    if (personId && row.streamId) {
      try {
        ({ voiceprintId, seconds } = await livePipeline.learnVoice(
          userId,
          personId,
          row.streamId,
          row.spokenAt.getTime(),
          row.endedAt.getTime(),
        ));
      } catch (err) {
        // Too short, or the audio is gone: the alias is still learned.
        console.warn(`[voice] learning from command ${id}: ${err}`);
      }
    }
    await db.insert(voiceSamples).values({
      userId,
      source: "command",
      text: row.transcript,
      heardAs: row.heardAs,
      nameScore: row.nameScore,
      speakerScore: row.speakerScore,
      seconds,
      voiceprintId,
      commandId: id,
    });
  }
  livePipeline.voiceChanged(userId);
  invalidate(userId, ["voice", "people"]);
}
