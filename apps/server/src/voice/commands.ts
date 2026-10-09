import { schema } from "@hearloom/db";
import { aliasWorthLearning, compactName, type HapticPattern } from "@hearloom/shared";
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { sendWebhook } from "../agent/webhooks";
import { db } from "../db";
import { buzzUserPhones } from "../ingest/phones";
import { livePipeline } from "../live/host";
import type { VoiceCue, VoiceCueEvent, VoiceDetection } from "../live/voice/types";
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

const { voiceCommands, voiceSamples, voiceprints } = schema;
type CommandRow = typeof voiceCommands.$inferSelect;

/**
 * The pendant's pulses for each cue (short 100 ms, medium 300 ms, long 500 ms), told apart by count
 * and length: heard · , the agent replied · · , nothing came of it — , not sent (or no reply) · · · .
 * "Sent" is told when the agent has answered, not when the webhook was taken (see `commandReplied`).
 */
export const CUE_PULSES: Record<VoiceCue, HapticPattern[]> = {
  heard: ["short"],
  sent: ["short", "short"],
  no_command: ["medium"],
  failed: ["short", "short", "short"],
};
/** From the start of one pulse to the start of the next. */
export const PULSE_GAP_MS = 350;
const PULSE_MS: Record<HapticPattern, number> = { short: 100, medium: 300, long: 500 };
/** At least this much stillness between two cues, so they don't run together. */
export const CUE_GAP_MS = 600;

/** Per user: cues play one after another. */
const buzzing = new Map<string, { chain: Promise<void>; stillAt: number }>();

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

/**
 * Tell the user about a voice command on the pendant(s) of their online phones, unless voice
 * command buzzes are off. (Shadow mode never buzzes: the pipeline only cues, and only delivers,
 * commands in "on" mode.)
 */
export function cue(userId: string, cue: VoiceCue): Promise<void> {
  if (CUE_PULSES[cue].length === 0) return Promise.resolve();
  const queue = buzzing.get(userId) ?? { chain: Promise.resolve(), stillAt: 0 };
  buzzing.set(userId, queue);
  const run = queue.chain.then(async () => {
    if (!(await getSettings(userId)).voice.haptics) return;
    const wait = queue.stillAt + CUE_GAP_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    const pulses = CUE_PULSES[cue];
    // New app builds play the cue themselves: it ends when the last pulse does, either way.
    queue.stillAt = Date.now() + (pulses.length - 1) * PULSE_GAP_MS + PULSE_MS[pulses.at(-1)!];
    const phones = await buzzUserPhones(userId, pulses, PULSE_GAP_MS, `"${cue}" cue`);
    if (phones === 0) console.warn(`[voice] the "${cue}" buzz reached no phone (none online)`);
  });
  queue.chain = run.catch(() => {});
  return run;
}

/** A cue from the live pipeline: the wake phrase was heard, or nothing came of it. */
export async function onCue(e: VoiceCueEvent): Promise<void> {
  if (e.cue === "heard" && e.nameEndAt !== null) {
    const now = Date.now();
    const what = e.via === "partial" ? "name" : "utterance";
    console.log(
      `[voice] wake phrase heard (${e.via}): buzz ${now - e.nameEndAt} ms after the ${what} ended (pipeline ${e.at - e.nameEndAt} ms)`,
    );
  }
  await cue(e.userId, e.cue);
}

/** A wake phrase from the live pipeline: store it, and deliver it if it should go to the agent. */
export async function onDetection(d: VoiceDetection): Promise<void> {
  // A command to send was buzzed as heard: if it can't even be stored, say it wasn't sent.
  const failed = () => (d.status === "pending" ? cue(d.userId, "failed") : undefined);
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
    .returning()
    .catch(async (err) => {
      await failed()?.catch(() => {});
      throw err;
    });
  invalidate(d.userId, ["voice"]);
  if (row?.status === "pending")
    await deliver(row).catch(async (err) => {
      // Before it could say how it went (its buzz is its last step).
      await failed()?.catch(() => {});
      throw err;
    });
  else if (row) await failed(); // stored as ignored (teaching)
}

// ---- waiting for the agent's answer -----------------------------------------------------------
//
// A sent command's wait is stored on its row (reply_status "awaiting" until reply_deadline_at),
// so a restart doesn't lose it; this process keeps a timer per wait. Whoever settles the row
// first (the agent's report, or the timer) buzzes; everything else finds it settled.

/**
 * An answer must come within this long of sending, unless the agent reports that its run started.
 * Hermes's answers took 20–54 s on 2026-10-09 (web lookups): 60 s would cry wolf.
 */
export const REPLY_TIMEOUT_MS = 120_000;
/** Once the agent's run has started (its p90 is about a minute, its longest 157 s so far). */
export const REPLY_RUN_TIMEOUT_MS = 10 * 60_000;
/** A wait that ran out longer ago than this while the server was down ends without a buzz. */
export const REPLY_STALE_MS = 30_000;
/** After a restart, the agent's hook may still be retrying its report: give it this long. */
export const REPLY_REPORT_GRACE_MS = 10_000;
/** This many answers in a row that never came: stop waiting for answers (the hook seems gone). */
export const REPLY_TIMEOUTS_TO_STOP = 3;

let replyTimeoutMs = REPLY_TIMEOUT_MS;
let runTimeoutMs = REPLY_RUN_TIMEOUT_MS;
/** Tests only. */
export function setReplyTimeout(ms: number, runMs = REPLY_RUN_TIMEOUT_MS): void {
  replyTimeoutMs = ms;
  runTimeoutMs = runMs;
}

/** Timers of the waits this process keeps (by command id). */
const replyTimers = new Map<string, Timer>();

function armReplyTimer(id: string, userId: string, at: number): void {
  clearTimeout(replyTimers.get(id));
  const timer = setTimeout(
    () => {
      if (replyTimers.get(id) === timer) replyTimers.delete(id);
      void replyTimedOut(id, userId).catch((err) =>
        console.error("[voice] ending a reply wait failed", err),
      );
    },
    Math.max(0, at - Date.now()),
  );
  timer.unref();
  replyTimers.set(id, timer);
}

function clearReplyTimer(id: string): void {
  clearTimeout(replyTimers.get(id));
  replyTimers.delete(id);
}

const awaiting = eq(voiceCommands.replyStatus, "awaiting");
/** Ends a wait that is still on, keeping an outcome that's already in. */
const noWait = sql<null>`case when ${voiceCommands.replyStatus} = 'awaiting' then null else ${voiceCommands.replyStatus} end`;

/** Start waiting for the answer, before sending: a fast agent may answer before the call returns. */
async function awaitReply(row: CommandRow): Promise<void> {
  const deadline = Date.now() + replyTimeoutMs;
  try {
    await db
      .update(voiceCommands)
      .set({ replyStatus: "awaiting", replyDeadlineAt: new Date(deadline) })
      .where(eq(voiceCommands.id, row.id));
    armReplyTimer(row.id, row.userId, deadline);
  } catch (err) {
    console.error(`[voice] couldn't start waiting for the answer to ${row.id}`, err);
  }
}

async function replyTimedOut(id: string, userId: string): Promise<void> {
  // Not if the deadline moved meanwhile (the run started; timers may fire a little early).
  const [r] = await db
    .update(voiceCommands)
    .set({ replyStatus: "timeout" })
    .where(
      and(
        eq(voiceCommands.id, id),
        awaiting,
        lte(voiceCommands.replyDeadlineAt, new Date(Date.now() + 1000)),
      ),
    )
    .returning({ startedAt: voiceCommands.replyStartedAt });
  if (!r) return;
  clearReplyTimer(id);
  invalidate(userId, ["voice"]);
  console.log(
    `[voice] no answer from the agent to ${id} in time (${r.startedAt ? "its run started" : "its run never started"})`,
  );
  void cue(userId, "failed").catch((err) => console.error("[voice] buzz failed", err));
  await stopWaitingIfHookGone(userId);
}

/**
 * Several answers in a row never came, not even late: the agent no longer reports them (its hook
 * was removed or broke). Stop waiting, so sent commands aren't told as failed; the next answer it
 * reports turns waiting on again.
 */
async function stopWaitingIfHookGone(userId: string): Promise<void> {
  const last = await db
    .select({ replyStatus: voiceCommands.replyStatus, repliedAt: voiceCommands.repliedAt })
    .from(voiceCommands)
    .where(
      and(
        eq(voiceCommands.userId, userId),
        or(
          inArray(voiceCommands.replyStatus, ["answered", "failed", "timeout"]),
          isNotNull(voiceCommands.repliedAt),
        ),
      ),
    )
    .orderBy(desc(voiceCommands.spokenAt))
    .limit(REPLY_TIMEOUTS_TO_STOP);
  const gone =
    last.length === REPLY_TIMEOUTS_TO_STOP &&
    last.every((r) => r.replyStatus === "timeout" && r.repliedAt === null);
  if (!gone || !(await getSettings(userId)).agent.voiceReplies) return;
  console.warn(
    `[voice] the agent reported none of the answers to the last ${REPLY_TIMEOUTS_TO_STOP} commands: no longer waiting for answers until it reports one (is the reply hook installed and its token valid?)`,
  );
  await updateSettings(userId, { agent: { voiceReplies: false } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReplyResult = "buzzed" | "late" | "not_found";
export type ReplyOutcome = "answered" | "failed";

/**
 * The agent's run on a voice command ended (the Hermes hook in `hermes/hooks/`): answered, or
 * failed (an error, interrupted, or no answer). If the answer is still awaited: two taps, or three.
 * Late, repeated or test-command reports don't buzz. Any report turns waiting for answers on for
 * the user (`agent.voiceReplies`). Returns at once: the buzz plays meanwhile (the hook runs
 * before Hermes delivers its reply).
 */
export async function commandReplied(
  userId: string,
  id: string,
  outcome: ReplyOutcome = "answered",
  reason: string | null = null,
): Promise<ReplyResult> {
  if (!UUID.test(id)) return "not_found";
  const mine = and(eq(voiceCommands.id, id), eq(voiceCommands.userId, userId));
  const report = { repliedAt: new Date(), replyOutcome: outcome };
  const [settled] = await db
    .update(voiceCommands)
    .set({ ...report, replyStatus: outcome })
    .where(and(mine, awaiting))
    .returning({ id: voiceCommands.id });
  let result: ReplyResult = "buzzed";
  if (settled) {
    clearReplyTimer(id);
    void cue(userId, outcome === "answered" ? "sent" : "failed").catch((err) =>
      console.error("[voice] buzz failed", err),
    );
  } else {
    const [row] = await db
      .update(voiceCommands)
      .set(report)
      .where(mine)
      .returning({ id: voiceCommands.id });
    if (!row) return "not_found";
    result = "late";
  }
  console.log(
    `[voice] the agent reported ${outcome}${reason ? ` (${reason})` : ""} for ${id}: ${result}`,
  );
  invalidate(userId, ["voice"]);
  if (!(await getSettings(userId)).agent.voiceReplies)
    await updateSettings(userId, { agent: { voiceReplies: true } });
  return result;
}

export type StartResult = "extended" | "ignored" | "not_found";

/**
 * The agent's run on a voice command started (the Hermes hook, `agent:start`): its answer is
 * awaited for up to `REPLY_RUN_TIMEOUT_MS` from now instead of the first deadline.
 */
export async function commandStarted(userId: string, id: string): Promise<StartResult> {
  if (!UUID.test(id)) return "not_found";
  const mine = and(eq(voiceCommands.id, id), eq(voiceCommands.userId, userId));
  const now = Date.now();
  const deadline = now + runTimeoutMs;
  const [r] = await db
    .update(voiceCommands)
    .set({ replyStartedAt: new Date(now), replyDeadlineAt: new Date(deadline) })
    .where(and(mine, awaiting, isNull(voiceCommands.replyStartedAt)))
    .returning({ id: voiceCommands.id });
  if (r) {
    armReplyTimer(id, userId, deadline);
    return "extended";
  }
  const [row] = await db.select({ id: voiceCommands.id }).from(voiceCommands).where(mine);
  return row ? "ignored" : "not_found";
}

/** The agent's latest report of an answer (or a failed run), for the Voice page. */
export async function lastReplyReport(
  userId: string,
): Promise<{ at: Date; outcome: ReplyOutcome } | null> {
  const [r] = await db
    .select({ at: voiceCommands.repliedAt, outcome: voiceCommands.replyOutcome })
    .from(voiceCommands)
    .where(and(eq(voiceCommands.userId, userId), isNotNull(voiceCommands.repliedAt)))
    .orderBy(desc(voiceCommands.repliedAt))
    .limit(1);
  return r?.at ? { at: r.at, outcome: r.outcome ?? "answered" } : null;
}

/**
 * Send a command to the agent with retries. Taken: wait for the agent's answer (two taps then,
 * three if it failed or none comes in time), if the agent reports its answers; otherwise nothing
 * more. Not taken: the "failed" buzz and a silent notification.
 */
export async function deliver(row: CommandRow, test = false): Promise<DeliveryOutcome> {
  const { agent } = await getSettings(row.userId);
  const wait = !test && agent.webhookUrl !== "" && agent.voiceReplies;
  if (wait) await awaitReply(row);
  try {
    return await deliverAndTell(row, test, agent.webhookUrl);
  } catch (err) {
    // Its outcome is told by the caller.
    if (wait) {
      clearReplyTimer(row.id);
      await db
        .update(voiceCommands)
        .set({ replyStatus: noWait })
        .where(eq(voiceCommands.id, row.id))
        .catch((e) => console.error("[voice] ending a reply wait failed", e));
    }
    throw err;
  }
}

async function deliverAndTell(
  row: CommandRow,
  test: boolean,
  webhookUrl: string,
): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = webhookUrl
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
  const sent = outcome.status === "sent";
  if (!sent) clearReplyTimer(row.id);
  // What's told below follows from the outcome alone: failing to store it mustn't change it.
  let answered = false;
  try {
    const [after] = await db
      .update(voiceCommands)
      .set({
        status: test ? "test" : outcome.status,
        reason: sent ? null : outcome.reason,
        attempts: outcome.attempts,
        httpStatus: outcome.httpStatus,
        sentAt: sent ? new Date() : null,
        // Not sent: nothing to wait for.
        ...(sent ? {} : { replyStatus: noWait }),
      })
      .where(eq(voiceCommands.id, row.id))
      .returning({ repliedAt: voiceCommands.repliedAt });
    answered = after?.repliedAt != null;
  } catch (err) {
    console.error(`[voice] couldn't store how sending ${row.id} went (${outcome.status})`, err);
  }
  invalidate(row.userId, ["voice"]);
  if (test || sent) return outcome;
  // An attempt got through after all (its response was lost): the agent answered it.
  if (answered) return outcome;
  await cue(row.userId, "failed").catch((err) => console.error("[voice] buzz failed", err));
  await notify({
    userId: row.userId,
    category: "voice_command",
    title: `Couldn't reach ${row.wakeName}`,
    body: `“${row.command.slice(0, 120)}” wasn't sent: ${describeFailure(outcome.reason)}.`,
    interruptionLevel: "passive",
    deepLink: "/voice",
  }).catch((err) => console.error("[voice] failure notification", err));
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
const MISSABLE = new Set([
  "near_miss",
  "no_command",
  "rate_limited",
  "no_voiceprint",
  "clip_missing",
  "clip_too_short",
  "check_error",
]);

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
 * enough (same id, so the agent dedupes); expire the rest. Then pick up the answer waits.
 */
export async function recoverPending(): Promise<{ retried: number; expired: number }> {
  const stale = await db
    .update(voiceCommands)
    .set({ status: "expired", reason: "restart", replyStatus: noWait })
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
        .set({ status: "expired", reason: "mode_off", replyStatus: noWait })
        .where(eq(voiceCommands.id, row.id));
      invalidate(row.userId, ["voice"]);
      expired++;
      continue;
    }
    retried++;
    void deliver(row).catch((err) => console.error("[voice] redelivery failed", err));
  }
  const waits = await recoverReplyWaits();
  if (waits.rearmed + waits.timedOut + waits.stale > 0)
    console.log(
      `[voice] after restart: waiting again for ${waits.rearmed} answer(s); ${waits.timedOut} ran out just now, ${waits.stale} long ago (no buzz)`,
    );
  return { retried, expired };
}

/**
 * At startup: the answers sent commands were waiting for. Still to come: wait again (at least a
 * little, as the agent's hook may be retrying a report the restart refused). Ran out while the
 * server was down: the "failed" buzz if that was moments ago, else settle it silently ("stale"):
 * three taps minutes after the fact would only confuse.
 */
export async function recoverReplyWaits(
  now = Date.now(),
  graceMs = REPLY_REPORT_GRACE_MS,
): Promise<{ rearmed: number; timedOut: number; stale: number }> {
  const rows = await db
    .select({
      id: voiceCommands.id,
      userId: voiceCommands.userId,
      deadline: voiceCommands.replyDeadlineAt,
    })
    .from(voiceCommands)
    .where(and(awaiting, eq(voiceCommands.status, "sent")));
  const counts = { rearmed: 0, timedOut: 0, stale: 0 };
  for (const r of rows) {
    const deadline = r.deadline?.getTime() ?? 0;
    if (now - deadline > REPLY_STALE_MS) {
      await db
        .update(voiceCommands)
        .set({ replyStatus: "stale" })
        .where(and(eq(voiceCommands.id, r.id), awaiting));
      invalidate(r.userId, ["voice"]);
      counts.stale++;
      continue;
    }
    armReplyTimer(r.id, r.userId, Math.max(deadline, now + graceMs));
    if (deadline > now) counts.rearmed++;
    else counts.timedOut++;
  }
  return counts;
}
