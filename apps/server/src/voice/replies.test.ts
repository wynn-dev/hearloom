import "../test-db";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { schema } from "@hearloom/db";
import type { ServerWebSocket } from "bun";
import { eq, sql } from "drizzle-orm";
import { createToken } from "../agent/tokens";
import { db } from "../db";
import { app } from "../http/app";
import {
  HAPTIC_SEQ_TTL_MS,
  type IngestSocketData,
  onHapticAck,
  registerPhoneSocket,
  unregisterPhoneSocket,
} from "../ingest/phones";
import type { VoiceDetection } from "../live/voice/types";
import { getSettings, updateSettings } from "../settings";
import {
  CUE_PULSES,
  commandReplied,
  commandStarted,
  cue,
  deliver,
  lastReplyReport,
  onDetection,
  PULSE_GAP_MS,
  REPLY_STALE_MS,
  REPLY_TIMEOUT_MS,
  recoverReplyWaits,
  setReplyTimeout,
} from "./commands";

// Waiting for the agent's answers (stored, so restarts don't lose them) and the pendant transport.
// A throwaway user on the throwaway test database (rows cascade on delete).
const userId = `test-${crypto.randomUUID()}`;
const SECRET = "whsec_c2VjcmV0LWtleS1mb3ItdGVzdHM=";

/** A fake Hermes webhook route that takes everything. */
const hermes = Bun.serve({
  port: 0,
  fetch: () => new Response('{"status":"accepted"}', { status: 202 }),
});
const webhookUrl = `http://localhost:${hermes.port}/webhooks/hearloom`;

/** What the user's phones were sent: an old app build (per-pulse `haptic`) and a new one. */
const legacy: string[] = [];
const seq: Record<string, unknown>[] = [];
const oldPhone = crypto.randomUUID();
const newPhone = crypto.randomUUID();

function fakeSocket(phoneId: string, features: string[] | undefined, sink: (m: never) => void) {
  return {
    data: {
      kind: "ingest",
      userId,
      phoneId,
      ...(features ? { features: new Set(features) } : {}),
    } as IngestSocketData,
    send: (msg: string) => {
      sink(JSON.parse(msg) as never);
      return 1;
    },
  } as unknown as ServerWebSocket<IngestSocketData>;
}
const oldSocket = fakeSocket(oldPhone, undefined, (m: { t: string; pattern: string }) => {
  if (m.t === "haptic") legacy.push(m.pattern);
});
const newSocket = fakeSocket(newPhone, ["haptic_seq"], (m: Record<string, unknown>) => seq.push(m));

beforeAll(async () => {
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Tester", email: `${userId}@test.local` });
  registerPhoneSocket(oldPhone, oldSocket);
  await updateSettings(userId, { agent: { webhookUrl, webhookSecret: SECRET } });
});

afterAll(async () => {
  hermes.stop(true);
  unregisterPhoneSocket(oldSocket);
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

beforeEach(async () => {
  legacy.length = 0;
  seq.length = 0;
  await updateSettings(userId, { agent: { voiceReplies: true } });
});

afterEach(() => {
  setReplyTimeout(REPLY_TIMEOUT_MS);
  unregisterPhoneSocket(newSocket);
});

function detection(over: Partial<VoiceDetection> = {}): VoiceDetection {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    userId,
    streamId: null as never,
    chainId: crypto.randomUUID(),
    spokenAt: now - 3000,
    endedAt: now - 1000,
    detectedAt: now,
    wakeName: "Hermes",
    heardAs: "Hermes",
    nameScore: 1,
    transcript: "Hey Hermes, what's 17 times 23?",
    command: "what's 17 times 23?",
    lang: "en",
    speakerScore: 0.78,
    status: "pending",
    reason: null,
    parts: [],
    ...over,
  };
}

async function row(id: string) {
  const [r] = await db.select().from(schema.voiceCommands).where(eq(schema.voiceCommands.id, id));
  return r!;
}

async function buzzed(n: number) {
  for (let i = 0; i < 60 && legacy.length < n; i++) await Bun.sleep(50);
  return legacy;
}

/** A command that was sent and is awaited, as a restart finds it (no timer in this process). */
async function awaitedBefore(deadlineAt: number, over: Partial<VoiceDetection> = {}) {
  await updateSettings(userId, { agent: { voiceReplies: false } });
  const d = detection(over);
  await onDetection(d);
  await db
    .update(schema.voiceCommands)
    .set({ replyStatus: "awaiting", replyDeadlineAt: new Date(deadlineAt) })
    .where(eq(schema.voiceCommands.id, d.id));
  await updateSettings(userId, { agent: { voiceReplies: true } });
  return d;
}

test("the wait is stored with the command; an answer settles it with two taps", async () => {
  const d = detection();
  await onDetection(d);
  const r = await row(d.id);
  expect(r).toMatchObject({ status: "sent", replyStatus: "awaiting", repliedAt: null });
  expect(r.replyDeadlineAt!.getTime() - Date.now()).toBeGreaterThan(REPLY_TIMEOUT_MS - 10_000);
  expect(await commandReplied(userId, d.id)).toBe("buzzed");
  expect(await buzzed(2)).toEqual(CUE_PULSES.sent);
  expect(await row(d.id)).toMatchObject({ replyStatus: "answered", replyOutcome: "answered" });
  expect((await lastReplyReport(userId))?.outcome).toBe("answered");
});

test("a failed run: three taps at once, not 'answered'", async () => {
  const d = detection();
  await onDetection(d);
  const { token } = await createToken(userId, "hook");
  const post = (body: string) =>
    app.request(`/api/voice/commands/${d.id}/replied`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
  expect((await post('{"outcome":"maybe"}')).status).toBe(400);
  const res = await post('{"outcome":"failed","reason":"server_error"}');
  expect(await res.json()).toEqual({ status: "buzzed" });
  expect(await buzzed(3)).toEqual(CUE_PULSES.failed);
  expect(await row(d.id)).toMatchObject({ replyStatus: "failed", replyOutcome: "failed" });
  expect(await lastReplyReport(userId)).toMatchObject({ outcome: "failed" });
  // A hook from before outcomes posts {}: an answer.
  const d2 = detection();
  await onDetection(d2);
  const old = await app.request(`/api/voice/commands/${d2.id}/replied`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{}",
  });
  expect(await old.json()).toEqual({ status: "buzzed" });
  expect((await row(d2.id)).replyOutcome).toBe("answered");
  expect(await buzzed(5)).toEqual([...CUE_PULSES.failed, ...CUE_PULSES.sent]);
});

test("once the agent's run has started, a long run gets its answer told, not three taps", async () => {
  setReplyTimeout(300, 1_500);
  const d = detection();
  await onDetection(d);
  const { token } = await createToken(userId, "hook");
  const res = await app.request(`/api/voice/commands/${d.id}/started`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await res.json()).toEqual({ status: "extended" });
  await Bun.sleep(700);
  expect(legacy).toEqual([]);
  expect((await row(d.id)).replyStatus).toBe("awaiting");
  expect(await commandStarted(userId, d.id)).toBe("ignored"); // once
  expect(await commandReplied(userId, d.id)).toBe("buzzed");
  expect(await buzzed(2)).toEqual(CUE_PULSES.sent);

  // Never started: three taps after the first deadline; starting late changes nothing.
  legacy.length = 0;
  const d2 = detection();
  await onDetection(d2);
  expect(await buzzed(3)).toEqual(CUE_PULSES.failed);
  expect(await commandStarted(userId, d2.id)).toBe("ignored");
  expect((await row(d2.id)).replyStatus).toBe("timeout");
  // Started, but no end within the extended limit either.
  legacy.length = 0;
  const d3 = detection();
  await onDetection(d3);
  expect(await commandStarted(userId, d3.id)).toBe("extended");
  await Bun.sleep(800);
  expect(legacy).toEqual([]);
  expect(await buzzed(3)).toEqual(CUE_PULSES.failed);
  expect(await commandStarted(userId, crypto.randomUUID())).toBe("not_found");
}, 15_000);

test("after a restart: waits are picked up; ones that ran out long ago end without a buzz", async () => {
  setReplyTimeout(REPLY_TIMEOUT_MS);
  const now = Date.now();
  const coming = await awaitedBefore(now + 60_000);
  const justNow = await awaitedBefore(now - 5_000);
  const longAgo = await awaitedBefore(now - REPLY_STALE_MS - 60_000);
  const r = await recoverReplyWaits(now, 300);
  expect(r).toMatchObject({ rearmed: 1, timedOut: 1, stale: 1 });
  expect((await row(longAgo.id)).replyStatus).toBe("stale");
  // The one still to come is awaited again: its answer buzzes.
  expect(await commandReplied(userId, coming.id)).toBe("buzzed");
  expect(await buzzed(2)).toEqual(CUE_PULSES.sent);
  // The one that ran out moments ago gets the "failed" buzz after the grace for the hook's retries.
  legacy.length = 0;
  expect(await buzzed(3)).toEqual(CUE_PULSES.failed);
  expect((await row(justNow.id)).replyStatus).toBe("timeout");
  // A late answer is recorded, not buzzed.
  legacy.length = 0;
  expect(await commandReplied(userId, longAgo.id)).toBe("late");
  await Bun.sleep(100);
  expect(legacy).toEqual([]);
});

test("after a restart, a report the hook retried within the grace is still in time", async () => {
  const d = await awaitedBefore(Date.now() - 2_000);
  await recoverReplyWaits(Date.now(), 1_000);
  expect(await commandReplied(userId, d.id, "answered")).toBe("buzzed");
  expect(await buzzed(2)).toEqual(CUE_PULSES.sent);
  await Bun.sleep(1_200);
  expect(legacy).toEqual(CUE_PULSES.sent);
});

test("three answers in a row that never came: stop waiting until the agent reports one", async () => {
  const warn = spyOn(console, "warn");
  // Five "failed" buzzes would hold up the next tests' cues.
  await updateSettings(userId, { voice: { haptics: false } });
  try {
    const timedOut = async () => {
      const d = await awaitedBefore(Date.now() - 1_000);
      await recoverReplyWaits(Date.now(), 0);
      for (let i = 0; i < 40 && (await row(d.id)).replyStatus !== "timeout"; i++)
        await Bun.sleep(25);
      return d;
    };
    await timedOut();
    const second = await timedOut();
    // A late answer means the hook works: the count starts over.
    await commandReplied(userId, second.id);
    await timedOut();
    await timedOut();
    expect((await getSettings(userId)).agent.voiceReplies).toBe(true);
    await timedOut();
    await Bun.sleep(100);
    expect((await getSettings(userId)).agent.voiceReplies).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no longer waiting"))).toBe(true);
    // Not waiting: a sent command isn't awaited. Its answer turns waiting on again.
    const d = detection();
    await onDetection(d);
    expect((await row(d.id)).replyStatus).toBeNull();
    expect(await commandReplied(userId, d.id)).toBe("late");
    expect((await getSettings(userId)).agent.voiceReplies).toBe(true);
  } finally {
    warn.mockRestore();
    await updateSettings(userId, { voice: { haptics: true } });
  }
}, 15_000);

test("a run that started but never ended shows the hook works: it doesn't count", async () => {
  await updateSettings(userId, { voice: { haptics: false } });
  try {
    const timedOut = async (started: boolean) => {
      const d = await awaitedBefore(Date.now() - 1_000);
      if (started)
        await db
          .update(schema.voiceCommands)
          .set({ replyStartedAt: new Date(Date.now() - 11 * 60_000) })
          .where(eq(schema.voiceCommands.id, d.id));
      await recoverReplyWaits(Date.now(), 0);
      for (let i = 0; i < 40 && (await row(d.id)).replyStatus !== "timeout"; i++)
        await Bun.sleep(25);
    };
    await timedOut(false);
    await timedOut(true);
    await timedOut(false);
    await timedOut(false);
    expect((await getSettings(userId)).agent.voiceReplies).toBe(true);
    await timedOut(false);
    await Bun.sleep(100);
    expect((await getSettings(userId)).agent.voiceReplies).toBe(false);
  } finally {
    await updateSettings(userId, { voice: { haptics: true } });
  }
}, 15_000);

test("a command delivered again after a restart isn't awaited again once its run ended", async () => {
  setReplyTimeout(200, 10 * 60_000);
  const d = detection();
  await onDetection(d);
  expect(await commandReplied(userId, d.id)).toBe("buzzed");
  expect(await buzzed(2)).toEqual(CUE_PULSES.sent);
  // The restart found it pending (its delivery's end wasn't stored) and delivered it again; the
  // agent dedupes it, so no second report comes: no three taps for it.
  const pending = () =>
    db
      .update(schema.voiceCommands)
      .set({ status: "pending" })
      .where(eq(schema.voiceCommands.id, d.id));
  await pending();
  await deliver(await row(d.id));
  await Bun.sleep(500);
  expect(legacy).toEqual(CUE_PULSES.sent);
  expect(await row(d.id)).toMatchObject({ status: "sent", replyStatus: "answered" });

  // Its run had started before the restart: the run's deadline holds, not a fresh 2 minutes.
  const started = Date.now() - 60_000;
  await db
    .update(schema.voiceCommands)
    .set({
      replyStatus: "awaiting",
      repliedAt: null,
      replyStartedAt: new Date(started),
      status: "pending",
    })
    .where(eq(schema.voiceCommands.id, d.id));
  await deliver(await row(d.id));
  const r = await row(d.id);
  expect(r.replyStatus).toBe("awaiting");
  expect(Math.abs(r.replyDeadlineAt!.getTime() - (started + 10 * 60_000))).toBeLessThan(1_000);
  await Bun.sleep(400);
  expect(legacy).toEqual(CUE_PULSES.sent);

  // No longer waiting for answers: the old wait ends.
  await updateSettings(userId, { agent: { voiceReplies: false } });
  await pending();
  await deliver(await row(d.id));
  expect((await row(d.id)).replyStatus).toBeNull();
  await Bun.sleep(100);
  expect(legacy).toEqual(CUE_PULSES.sent);
});

test("a timer that fires before its deadline (clock stepped) waits on; a DB error is retried", async () => {
  // The clock was ahead when the timer was set: it fires while the deadline is still 1.5 s off.
  const d = await awaitedBefore(Date.now() + 1_500);
  setSystemTime(new Date(Date.now() + 3_000));
  await recoverReplyWaits(Date.now(), 0);
  setSystemTime();
  await Bun.sleep(400);
  expect((await row(d.id)).replyStatus).toBe("awaiting");
  expect(legacy).toEqual([]);
  expect(await buzzed(3)).toEqual(CUE_PULSES.failed);
  expect((await row(d.id)).replyStatus).toBe("timeout");

  legacy.length = 0;
  await db.execute(sql`create sequence hl_test_once`);
  await db.execute(sql`
    create function hl_test_once() returns trigger language plpgsql as $$
    begin if nextval('hl_test_once') = 1 then raise exception 'boom once'; end if; return new; end $$`);
  await db.execute(sql`
    create trigger hl_test_once before update on voice_commands for each row
    when (new.reply_status = 'timeout' and new.command = 'boom-once') execute function hl_test_once()`);
  const error = spyOn(console, "error");
  try {
    const e = await awaitedBefore(Date.now() - 1_000, { command: "boom-once" });
    await recoverReplyWaits(Date.now(), 0);
    expect(await buzzed(3)).toEqual(CUE_PULSES.failed);
    expect((await row(e.id)).replyStatus).toBe("timeout");
    expect(error.mock.calls.some((c) => String(c[0]).includes("retrying"))).toBe(true);
  } finally {
    error.mockRestore();
    await db.execute(sql`drop trigger hl_test_once on voice_commands`);
    await db.execute(sql`drop function hl_test_once()`);
    await db.execute(sql`drop sequence hl_test_once`);
  }
}, 15_000);

test("a new webhook URL or secret stops waiting for answers until they're reported", async () => {
  await updateSettings(userId, { agent: { webhookSecret: "another-secret" } });
  expect((await getSettings(userId)).agent.voiceReplies).toBe(false);
  await updateSettings(userId, { agent: { voiceReplies: true } });
  await updateSettings(userId, { agent: { webhookUrl: `${webhookUrl}?v=2` } });
  expect((await getSettings(userId)).agent.voiceReplies).toBe(false);
  // Unchanged values don't.
  await updateSettings(userId, { agent: { voiceReplies: true } });
  await updateSettings(userId, { agent: { webhookUrl: `${webhookUrl}?v=2` }, voice: {} });
  expect((await getSettings(userId)).agent.voiceReplies).toBe(true);
  await updateSettings(userId, { agent: { webhookUrl, webhookSecret: SECRET } });
});

test("failing to store a delivered command's outcome doesn't tell it as failed", async () => {
  await db.execute(sql`
    create or replace function hl_test_boom() returns trigger language plpgsql as $$
    begin raise exception 'boom'; end $$`);
  await db.execute(sql`
    create trigger hl_test_boom before update on voice_commands for each row
    when (new.status is distinct from old.status and new.command = 'boom') execute function hl_test_boom()`);
  const error = spyOn(console, "error");
  try {
    await updateSettings(userId, { agent: { voiceReplies: false } });
    const d = detection({ command: "boom" });
    await onDetection(d); // doesn't throw
    await Bun.sleep(200);
    expect(legacy).toEqual([]);
    expect(error.mock.calls.some((c) => String(c[0]).includes("couldn't store"))).toBe(true);
  } finally {
    error.mockRestore();
    await db.execute(sql`drop trigger hl_test_boom on voice_commands`);
    await db.execute(sql`drop function hl_test_boom()`);
  }
});

test("phones with haptic_seq get the whole cue in one message; old builds a haptic per pulse", async () => {
  registerPhoneSocket(newPhone, newSocket);
  await cue(userId, "failed");
  expect(seq).toEqual([
    {
      t: "haptic_seq",
      id: expect.any(String),
      pulses: ["short", "short", "short"],
      intervalMs: PULSE_GAP_MS,
      ttlMs: HAPTIC_SEQ_TTL_MS,
    },
  ]);
  expect(legacy).toEqual(CUE_PULSES.failed);
  // The "heard" tap is only worth playing right away.
  await cue(userId, "heard");
  expect(seq[1]).toMatchObject({ pulses: ["short"], ttlMs: 3_000 });

  const warn = spyOn(console, "warn");
  try {
    const id = seq[0]!.id as string;
    // Someone else's phone can't answer for it; the right one says it couldn't play it.
    onHapticAck(oldPhone, { id, played: false, reason: "no_pendant" });
    expect(warn).not.toHaveBeenCalled();
    onHapticAck(newPhone, { id, played: false, reason: "no_pendant" });
    expect(String(warn.mock.calls[0]?.[0])).toContain("no_pendant");
    onHapticAck(newPhone, { id, played: false }); // already settled
    onHapticAck(newPhone, { id: crypto.randomUUID(), played: true }); // unknown
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("a cue that reaches no phone is logged; buzzes off sends nothing and logs nothing", async () => {
  unregisterPhoneSocket(oldSocket);
  const warn = spyOn(console, "warn");
  try {
    await cue(userId, "heard");
    expect(String(warn.mock.calls[0]?.[0])).toContain("reached no phone");
    warn.mockClear();
    await updateSettings(userId, { voice: { haptics: false } });
    await cue(userId, "heard");
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    await updateSettings(userId, { voice: { haptics: true } });
    registerPhoneSocket(oldPhone, oldSocket);
  }
});
