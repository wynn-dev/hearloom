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
  MAX_AGE_MS,
} from "./deliver";
import { insertVoiceprint, selfPersonId } from "./profile";
import { isTeaching } from "./teach";

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
      parts: d.parts,
      detectedAt: new Date(d.detectedAt),
      wakeName: d.wakeName,
      heardAs: d.heardAs,
      nameScore: d.nameScore,
      transcript: d.transcript,
      command: d.command,
      lang: d.lang,
      speakerScore: d.speakerScore,
      // Defence in depth: while the user is teaching, the phrases they read must not be sent
      // (the live pipeline should have taught them instead, but it may have restarted).
      ...(d.status !== "ignored" && isTeaching(d.userId, d.spokenAt)
        ? { status: "ignored" as const, reason: "teaching" }
        : { status: d.status, reason: d.reason }),
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

/** Detections that fired (passed the own-voice gate): they can be confirmed or called false. */
const FIRED = new Set(["sent", "shadow", "failed", "expired"]);
/**
 * Ignored detections the user may call "missed". Not `not_own_voice` or `media_voice`: the gate
 * already heard someone else there, and learning it would enrol their voice and loosen the gate.
 */
const MISSABLE = new Set(["near_miss", "no_command", "rate_limited", "no_voiceprint"]);

export interface FeedbackResult {
  /** Something was learned from it (voice and/or how the name is heard). */
  learned: boolean;
  /** Why nothing was learned, for the user. */
  note: string | null;
}

/**
 * The user's verdict on a detection. "confirmed" (it was me, and right) and "missed" (it was me:
 * it should have fired) are learned from: the command's audio becomes a voiceprint, if it sounds
 * like the user as much as a sent command must, and the way the name was heard an alias.
 * "false_trigger" undoes that and blocks the spelling from loose matching. null clears the verdict.
 *
 * Verdicts on one command are serialized by a row lock, held only briefly: the verdict is recorded
 * (and earlier learning undone) first; embedding the voice (seconds, in the live pipeline) happens
 * without the lock; then the voiceprint and its sample row are stored together under the lock
 * again, only if the verdict is still the same and nothing else was stored meanwhile.
 */
export async function setFeedback(
  userId: string,
  id: string,
  feedback: "confirmed" | "false_trigger" | "missed" | null,
): Promise<FeedbackResult> {
  const row = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(voiceCommands)
      .where(and(eq(voiceCommands.id, id), eq(voiceCommands.userId, userId)))
      .for("update");
    if (!row) throw new FeedbackError("voice command not found");
    const fired = FIRED.has(row.status);
    if (feedback === "confirmed" || feedback === "false_trigger") {
      if (!fired) throw new FeedbackError("only commands that fired can be confirmed or rejected");
    } else if (feedback === "missed") {
      if (row.status !== "ignored" || !MISSABLE.has(row.reason ?? ""))
        throw new FeedbackError(
          row.reason === "not_own_voice" || row.reason === "media_voice"
            ? "This didn't sound like you, so it can't be learned from. Teach your voice instead."
            : "only ignored detections can be marked as missed",
        );
    }
    await unlearn(tx, userId, id);
    await tx.update(voiceCommands).set({ feedback }).where(eq(voiceCommands.id, id));
    return row;
  });

  let result: FeedbackResult = { learned: false, note: null };
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
    result = await learnFrom(userId, row, feedback);
  }
  livePipeline.voiceChanged(userId);
  invalidate(userId, ["voice", "people"]);
  return result;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Remove what an earlier verdict on this command taught (its sample and voiceprint). */
async function unlearn(tx: Tx, userId: string, commandId: string): Promise<void> {
  const undone = await tx
    .delete(voiceSamples)
    .where(and(eq(voiceSamples.commandId, commandId), eq(voiceSamples.userId, userId)))
    .returning({ voiceprintId: voiceSamples.voiceprintId });
  for (const u of undone) {
    if (u.voiceprintId)
      await tx
        .delete(voiceprints)
        .where(and(eq(voiceprints.id, u.voiceprintId), eq(voiceprints.userId, userId)));
  }
}

async function learnFrom(
  userId: string,
  row: CommandRow,
  feedback: "confirmed" | "missed",
): Promise<FeedbackResult> {
  // The voice, from the command's own utterances (not what was said between them), checked in
  // the live pipeline against the user's voice. Only embedded there: it's stored below, with the
  // sample row that 👎 removes it by, so a timeout or restart can't leave it unlinked.
  let voice: { embedding: number[]; seconds: number } | null = null;
  let note: string | null = null;
  const personId = await selfPersonId(userId);
  const ranges = row.parts?.length
    ? row.parts
    : [{ startAt: row.spokenAt.getTime(), endAt: row.endedAt.getTime() }];
  if (personId && row.streamId) {
    try {
      voice = await livePipeline.learnVoice(userId, row.streamId, ranges);
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    }
  } else {
    note = "no audio to learn from";
  }
  return db.transaction(async (tx): Promise<FeedbackResult> => {
    const [now] = await tx
      .select({ feedback: voiceCommands.feedback })
      .from(voiceCommands)
      .where(eq(voiceCommands.id, row.id))
      .for("update");
    // The verdict changed while we were learning: that one decides what's learned.
    if (now?.feedback !== feedback) return { learned: false, note: "changed meanwhile" };
    const [already] = await tx
      .select({ voiceprintId: voiceSamples.voiceprintId })
      .from(voiceSamples)
      .where(eq(voiceSamples.commandId, row.id));
    // The same verdict, sent twice at once: the other request learned from it. Any other verdict
    // in between would have removed its sample, so this one's is saved and learned from (the
    // spelling only, if the voice wasn't: then say why, as the other request did).
    if (already) return { learned: true, note: already.voiceprintId ? null : note };
    // The name: a fired command was already verified as the user's voice; a missed one only
    // if its voice just was. Confirmed by the user, so even a multi-word spelling.
    const { voice: settings } = await getSettings(userId);
    const aliasLearned =
      (FIRED.has(row.status) || voice !== null) && aliasWorthLearning(row.heardAs, settings, 2);
    if (!voice && !aliasLearned) return { learned: false, note };
    const voiceprintId =
      voice && personId ? await insertVoiceprint(tx, { userId, personId, ...voice }) : null;
    await tx.insert(voiceSamples).values({
      userId,
      source: "command",
      text: row.transcript,
      heardAs: row.heardAs,
      nameScore: row.nameScore,
      speakerScore: row.speakerScore,
      seconds: voice?.seconds ?? 0,
      voiceprintId,
      commandId: row.id,
    });
    if (aliasLearned) {
      const heard = compactName(row.heardAs);
      await updateSettings(userId, {
        voice: {
          aliases: [...settings.aliases, row.heardAs].slice(-20),
          blocked: settings.blocked.filter((b) => compactName(b) !== heard),
        },
      });
    }
    return { learned: true, note: voiceprintId ? null : note };
  });
}

/**
 * At startup: deliveries in flight when the server stopped are lost. Retry the ones still fresh
 * enough (same id, so the agent dedupes); expire the rest.
 */
export async function recoverPending(): Promise<{ retried: number; expired: number }> {
  const stale = await db
    .update(voiceCommands)
    .set({ status: "expired", reason: "restart" })
    .where(
      and(
        eq(voiceCommands.status, "pending"),
        lt(voiceCommands.spokenAt, new Date(Date.now() - MAX_AGE_MS)),
      ),
    )
    .returning({ userId: voiceCommands.userId });
  for (const r of stale) invalidate(r.userId, ["voice"]);
  const fresh = await db.select().from(voiceCommands).where(eq(voiceCommands.status, "pending"));
  let retried = 0;
  let expired = stale.length;
  for (const row of fresh) {
    // Voice commands may have been turned off (or set to shadow) meanwhile.
    if ((await getSettings(row.userId)).voice.mode !== "on") {
      await db
        .update(voiceCommands)
        .set({ status: "expired", reason: "mode_off" })
        .where(eq(voiceCommands.id, row.id));
      invalidate(row.userId, ["voice"]);
      expired++;
      continue;
    }
    retried++;
    void deliver(row).catch((err) => console.error("[voice] redelivery failed", err));
  }
  return { retried, expired };
}
