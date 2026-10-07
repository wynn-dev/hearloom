import { contract } from "@hearloom/api";
import { schema } from "@hearloom/db";
import { implement, ORPCError } from "@orpc/server";
import { and, asc, count, desc, eq, gte, isNull, lt, lte, max, or, sql } from "drizzle-orm";
import { createToken } from "../agent/tokens";
import { type AuthSession, getSession } from "../auth";
import { db } from "../db";
import {
  EpisodeEditError,
  type EpisodeRow,
  episodesIn,
  mediaVoices,
  mergeEpisodes,
  refinedIds,
  splitEpisode,
  updateEpisode,
} from "../episodes/store";
import { chunkUrl } from "../http/media";
import { isPhoneOnline } from "../ingest/phones";
import { livePipeline } from "../live/host";
import { markOpened, notify } from "../notify/gateway";
import { invalidate } from "../realtime";
import { getSettings, updateSettings } from "../settings";
import { FeedbackError, listCommands, sendTestCommand, setFeedback } from "../voice/commands";
import { voiceProfile } from "../voice/profile";
import {
  skipPhrase,
  startTeach,
  stopTeach,
  TeachError,
  teachState,
  uploadSample,
} from "../voice/teach";

const {
  phones,
  wearables,
  captureStreams,
  audioChunks,
  bookmarks,
  deviceEvents,
  notifications,
  utterances,
  soundEvents,
  people,
  voiceprints,
  apiTokens,
  blocks,
} = schema;

export interface RpcContext {
  headers: Headers;
}

const os = implement(contract).$context<RpcContext>();

const authed = os.use(async ({ context, next }) => {
  const session = await getSession(context.headers);
  if (!session) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { session, userId: session.user.id } });
});

type Ctx = { session: AuthSession; userId: string };

/** A stream counts as live if it is open and received audio in the last 2 minutes. */
const LIVE_WINDOW_MS = 120_000;

async function listPhones(userId: string) {
  const rows = await db
    .select()
    .from(phones)
    .where(eq(phones.userId, userId))
    .orderBy(asc(phones.createdAt));
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    model: p.model,
    osVersion: p.osVersion,
    appVersion: p.appVersion,
    pushEnabled: p.pushEnabled,
    hasPushToken: p.apnsToken !== null,
    apnsEnv: p.apnsEnv,
    lastSeenAt: p.lastSeenAt,
    online: isPhoneOnline(p.id),
  }));
}

async function listWearables(userId: string) {
  return db
    .select({
      id: wearables.id,
      name: wearables.name,
      model: wearables.model,
      firmware: wearables.firmware,
      batteryLevel: wearables.batteryLevel,
      lastSeenAt: wearables.lastSeenAt,
    })
    .from(wearables)
    .where(eq(wearables.userId, userId))
    .orderBy(desc(wearables.lastSeenAt));
}

async function listPeople(userId: string) {
  const rows = await db
    .select({
      id: people.id,
      name: people.name,
      isSelf: people.isSelf,
    })
    .from(people)
    .where(eq(people.userId, userId))
    .orderBy(desc(people.isSelf), asc(people.name));
  const prints = await db
    .select({ personId: voiceprints.personId, n: count() })
    .from(voiceprints)
    .where(eq(voiceprints.userId, userId))
    .groupBy(voiceprints.personId);
  const heard = await db
    .select({ personId: utterances.personId, n: count(), last: max(utterances.endAt) })
    .from(utterances)
    .where(and(eq(utterances.userId, userId), isNull(utterances.supersededAt)))
    .groupBy(utterances.personId);
  return rows.map((r) => {
    const h = heard.find((x) => x.personId === r.id);
    return {
      ...r,
      voiceprints: prints.find((x) => x.personId === r.id)?.n ?? 0,
      utterances: h?.n ?? 0,
      lastHeardAt: h?.last ?? null,
    };
  });
}

/** Episodes for the API, with what was heard in them (from the utterances at hand). */
async function describeEpisodes(
  userId: string,
  rows: EpisodeRow[],
  utts: {
    startAt: Date;
    isWearer: boolean | null;
    personId: string | null;
    speakerKey: string | null;
    lang: string | null;
  }[],
) {
  const refined = await refinedIds(db, userId, rows);
  return rows.map((ep) => {
    const start = ep.startedAt.getTime();
    const end = ep.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const inside = utts.filter((u) => u.startAt.getTime() >= start && u.startAt.getTime() < end);
    return {
      id: ep.id,
      startedAt: ep.startedAt,
      endedAt: ep.endedAt,
      kind: ep.kind,
      kindSource: ep.kindSource,
      boundarySource: ep.boundarySource,
      title: ep.title,
      summary: ep.summary,
      refined: refined.has(ep.id),
      speakerCount: new Set(
        inside.map((u) => (u.isWearer ? "me" : (u.personId ?? u.speakerKey))).filter(Boolean),
      ).size,
      languages: [...new Set(inside.map((u) => u.lang).filter((l): l is string => Boolean(l)))],
    };
  });
}

/** Run an episode edit: bad edits are the client's fault; the live pipeline picks up the change. */
async function editEpisodes(userId: string, edit: () => Promise<unknown>): Promise<void> {
  try {
    await edit();
  } catch (err) {
    if (err instanceof EpisodeEditError)
      throw new ORPCError("BAD_REQUEST", { message: err.message });
    throw err;
  }
  livePipeline.episodesChanged(userId);
  invalidate(userId, ["timeline"]);
}

async function teachCall(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TeachError) throw new ORPCError("BAD_REQUEST", { message: err.message });
    throw err;
  }
}

export const router = authed.router({
  me: {
    get: authed.me.get.handler(async ({ context }) => {
      const { user } = (context as Ctx).session;
      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: (user as { role?: string | null }).role ?? null,
        },
        settings: await getSettings(user.id),
      };
    }),
  },

  settings: {
    get: authed.settings.get.handler(({ context }) => getSettings((context as Ctx).userId)),
    update: authed.settings.update.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      // Voice commands only ever act on the user's own voice: it must be taught first.
      if (input.voice?.mode && input.voice.mode !== "off") {
        const profile = await voiceProfile(userId);
        if (!profile.canEnable)
          throw new ORPCError("BAD_REQUEST", {
            message: "Teach Hearloom your voice first (Voice → Teach your voice)",
          });
      }
      const next = await updateSettings(userId, input);
      if (input.voice) livePipeline.voiceChanged(userId);
      return next;
    }),
  },

  phones: {
    register: authed.phones.register.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      const values = {
        userId,
        name: input.name,
        model: input.model ?? null,
        osVersion: input.osVersion ?? null,
        appVersion: input.appVersion ?? null,
        bundleId: input.bundleId ?? null,
        lastSeenAt: new Date(),
      };
      let phoneId: string | undefined;
      if (input.id) {
        const [row] = await db
          .update(phones)
          .set(values)
          .where(and(eq(phones.id, input.id), eq(phones.userId, userId)))
          .returning({ id: phones.id });
        phoneId = row?.id;
      }
      if (!phoneId) {
        const [row] = await db
          .insert(phones)
          .values({ ...(input.id ? { id: input.id } : {}), ...values })
          .onConflictDoNothing()
          .returning({ id: phones.id });
        if (!row) throw new ORPCError("CONFLICT", { message: "phone id already in use" });
        phoneId = row.id;
      }
      // First phone login sets the timezone used for quiet hours.
      const settings = await getSettings(userId);
      if (input.timezone && settings.timezone === "UTC") {
        await updateSettings(userId, { timezone: input.timezone });
      }
      invalidate(userId, ["phones", "status"]);
      return { phoneId };
    }),
    setPushToken: authed.phones.setPushToken.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      if (input.apnsToken) {
        // A token belongs to one install; detach it from any stale phone row.
        await db
          .update(phones)
          .set({ apnsToken: null })
          .where(eq(phones.apnsToken, input.apnsToken));
      }
      const [row] = await db
        .update(phones)
        .set({ apnsToken: input.apnsToken, apnsEnv: input.apnsEnv })
        .where(and(eq(phones.id, input.phoneId), eq(phones.userId, userId)))
        .returning({ id: phones.id });
      if (!row) throw new ORPCError("NOT_FOUND");
      invalidate(userId, ["phones"]);
      return { ok: true as const };
    }),
    list: authed.phones.list.handler(({ context }) => listPhones((context as Ctx).userId)),
    signOut: authed.phones.signOut.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      await db
        .update(captureStreams)
        .set({ endedAt: sql`coalesce(${captureStreams.lastFrameAt}, ${captureStreams.startedAt})` })
        .where(
          and(
            eq(captureStreams.userId, userId),
            eq(captureStreams.phoneId, input.id),
            isNull(captureStreams.endedAt),
          ),
        );
      await db
        .update(phones)
        .set({ apnsToken: null })
        .where(and(eq(phones.id, input.id), eq(phones.userId, userId)));
      invalidate(userId, ["phones", "status"]);
      return { ok: true as const };
    }),
    remove: authed.phones.remove.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      await db.delete(phones).where(and(eq(phones.id, input.id), eq(phones.userId, userId)));
      invalidate(userId, ["phones", "status"]);
      return { ok: true as const };
    }),
  },

  wearables: {
    list: authed.wearables.list.handler(({ context }) => listWearables((context as Ctx).userId)),
  },

  status: {
    live: authed.status.live.handler(async ({ context }) => {
      const { userId } = context as Ctx;
      const since = new Date(Date.now() - 24 * 3600_000);
      const streams = await db
        .select({
          id: captureStreams.id,
          phoneId: captureStreams.phoneId,
          wearableName: wearables.name,
          codec: captureStreams.codec,
          startedAt: captureStreams.startedAt,
          endedAt: captureStreams.endedAt,
          lastFrameAt: captureStreams.lastFrameAt,
          ackedSeq: captureStreams.ackedSeq,
          framesReceived: captureStreams.framesReceived,
        })
        .from(captureStreams)
        .leftJoin(wearables, eq(wearables.id, captureStreams.wearableId))
        .where(
          and(
            eq(captureStreams.userId, userId),
            or(isNull(captureStreams.endedAt), gte(captureStreams.startedAt, since)),
          ),
        )
        .orderBy(desc(captureStreams.startedAt))
        .limit(20);
      const now = Date.now();
      return {
        phones: await listPhones(userId),
        wearables: await listWearables(userId),
        streams: streams.map((s) => ({
          ...s,
          live:
            s.endedAt === null &&
            s.lastFrameAt !== null &&
            now - s.lastFrameAt.getTime() < LIVE_WINDOW_MS &&
            s.phoneId !== null &&
            isPhoneOnline(s.phoneId),
        })),
        serverTime: new Date(),
      };
    }),
  },

  timeline: {
    range: authed.timeline.range.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      const { from, to } = input;
      if (to.getTime() - from.getTime() > 7 * 24 * 3600_000) {
        throw new ORPCError("BAD_REQUEST", { message: "range too large (max 7 days)" });
      }

      const [chunkRows, bookmarkRows, eventRows, epRows, uttRows, soundRows] = await Promise.all([
        db
          .select()
          .from(audioChunks)
          .where(
            and(
              eq(audioChunks.userId, userId),
              lt(audioChunks.startAt, to),
              gte(audioChunks.endAt, from),
            ),
          )
          .orderBy(asc(audioChunks.startAt)),
        db
          .select()
          .from(bookmarks)
          .where(and(eq(bookmarks.userId, userId), gte(bookmarks.at, from), lte(bookmarks.at, to)))
          .orderBy(asc(bookmarks.at)),
        db
          .select()
          .from(deviceEvents)
          .where(
            and(
              eq(deviceEvents.userId, userId),
              gte(deviceEvents.at, from),
              lte(deviceEvents.at, to),
            ),
          )
          .orderBy(asc(deviceEvents.at))
          .limit(2000),
        episodesIn(db, userId, from, to),
        db
          .select({ u: utterances, personName: people.name, chainId: blocks.chainId })
          .from(utterances)
          .leftJoin(people, eq(people.id, utterances.personId))
          .leftJoin(blocks, eq(blocks.id, utterances.blockId))
          .where(
            and(
              eq(utterances.userId, userId),
              isNull(utterances.supersededAt),
              lt(utterances.startAt, to),
              gte(utterances.endAt, from),
            ),
          )
          .orderBy(asc(utterances.startAt))
          .limit(5000),
        db
          .select()
          .from(soundEvents)
          .where(
            and(
              eq(soundEvents.userId, userId),
              lt(soundEvents.startAt, to),
              gte(soundEvents.endAt, from),
            ),
          )
          .orderBy(asc(soundEvents.startAt))
          .limit(5000),
      ]);

      const media = await mediaVoices(
        db,
        userId,
        uttRows.flatMap((r) => (r.chainId ? [r.chainId] : [])),
      );
      return {
        chunks: chunkRows.map((c) => ({
          id: c.id,
          streamId: c.streamId,
          startAt: c.startAt,
          endAt: c.endAt,
          durationMs: c.durationMs,
          byteSize: c.byteSize,
          url: chunkUrl(c.id),
        })),
        bookmarks: bookmarkRows.map((b) => ({
          id: b.id,
          at: b.at,
          source: b.source,
          note: b.note,
        })),
        deviceEvents: eventRows.map((e) => ({
          id: e.id,
          kind: e.kind,
          payload: e.payload,
          at: e.at,
        })),
        episodes: await describeEpisodes(
          userId,
          epRows,
          uttRows.map(({ u }) => u),
        ),
        utterances: uttRows.map(({ u, personName, chainId }) => ({
          id: u.id,
          startAt: u.startAt,
          endAt: u.endAt,
          speakerKey: u.speakerKey,
          personId: u.personId,
          personName,
          isWearer: u.isWearer,
          text: u.text,
          lang: u.lang,
          source: u.source,
          mediaVoice:
            !u.isWearer && !u.personId && !!chainId && media.has(`${chainId}:${u.speakerKey}`),
        })),
        soundEvents: soundRows.map((s) => ({
          id: s.id,
          startAt: s.startAt,
          endAt: s.endAt,
          label: s.label,
          kind: s.kind,
          confidence: s.confidence,
        })),
      };
    }),
  },

  episodes: {
    update: authed.episodes.update.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      await editEpisodes(userId, () => updateEpisode(db, userId, input.id, input, "user"));
      return { ok: true as const };
    }),
    split: authed.episodes.split.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      await editEpisodes(userId, () => splitEpisode(db, userId, input.id, input.at, "user"));
      return { ok: true as const };
    }),
    merge: authed.episodes.merge.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      await editEpisodes(userId, () => mergeEpisodes(db, userId, input.ids, "user"));
      return { ok: true as const };
    }),
  },

  people: {
    list: authed.people.list.handler(({ context }) => listPeople((context as Ctx).userId)),
    save: authed.people.save.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      if (input.isSelf) {
        // Only one "me": unset the flag elsewhere first.
        await db.update(people).set({ isSelf: false }).where(eq(people.userId, userId));
      }
      let id = input.id;
      if (id) {
        const [row] = await db
          .update(people)
          .set({
            name: input.name,
            ...(input.isSelf !== undefined ? { isSelf: input.isSelf } : {}),
          })
          .where(and(eq(people.id, id), eq(people.userId, userId)))
          .returning({ id: people.id });
        if (!row) throw new ORPCError("NOT_FOUND");
      } else {
        const [row] = await db
          .insert(people)
          .values({ userId, name: input.name, isSelf: input.isSelf ?? false })
          .returning({ id: people.id });
        id = row!.id;
      }
      invalidate(userId, ["people"]);
      const person = (await listPeople(userId)).find((p) => p.id === id);
      if (!person) throw new ORPCError("NOT_FOUND");
      return person;
    }),
    remove: authed.people.remove.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      await db.delete(people).where(and(eq(people.id, input.id), eq(people.userId, userId)));
      livePipeline.voiceprintsChanged(userId);
      invalidate(userId, ["people"]);
      return { ok: true as const };
    }),
    enroll: authed.people.enroll.handler(async ({ context, input }) => {
      const { userId, session } = context as Ctx;
      const choices = [input.personId, input.newPersonName, input.asSelf].filter(
        (v) => v !== undefined,
      );
      if (choices.length !== 1) {
        throw new ORPCError("BAD_REQUEST", {
          message: "give one of personId, newPersonName, asSelf",
        });
      }
      let personId = input.personId;
      if (personId) {
        const [p] = await db
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.id, personId), eq(people.userId, userId)));
        if (!p) throw new ORPCError("NOT_FOUND", { message: "person not found" });
      } else if (input.asSelf) {
        const [me] = await db
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.userId, userId), eq(people.isSelf, true)));
        personId =
          me?.id ??
          (
            await db
              .insert(people)
              .values({ userId, name: session.user.name || "Me", isSelf: true })
              .returning({ id: people.id })
          )[0]!.id;
      } else {
        personId = (
          await db
            .insert(people)
            .values({ userId, name: input.newPersonName!, isSelf: false })
            .returning({ id: people.id })
        )[0]!.id;
      }
      let sampleSeconds: number;
      try {
        sampleSeconds = await livePipeline.enroll(userId, personId, input.utteranceId);
      } catch (err) {
        throw new ORPCError("BAD_REQUEST", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      invalidate(userId, ["people", "timeline"]);
      return { personId, sampleSeconds };
    }),
  },

  agent: {
    tokens: {
      list: authed.agent.tokens.list.handler(async ({ context }) => {
        const rows = await db
          .select()
          .from(apiTokens)
          .where(and(eq(apiTokens.userId, (context as Ctx).userId), isNull(apiTokens.revokedAt)))
          .orderBy(desc(apiTokens.createdAt));
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          prefix: r.prefix,
          createdAt: r.createdAt,
          lastUsedAt: r.lastUsedAt,
        }));
      }),
      create: authed.agent.tokens.create.handler(async ({ context, input }) => {
        const { token, row } = await createToken((context as Ctx).userId, input.name);
        return {
          token,
          info: {
            id: row.id,
            name: row.name,
            prefix: row.prefix,
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
          },
        };
      }),
      revoke: authed.agent.tokens.revoke.handler(async ({ context, input }) => {
        await db
          .update(apiTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiTokens.id, input.id), eq(apiTokens.userId, (context as Ctx).userId)));
        return { ok: true as const };
      }),
    },
  },

  voice: {
    status: authed.voice.status.handler(async ({ context }) => {
      const { userId } = context as Ctx;
      const [profile, settings, live] = await Promise.all([
        voiceProfile(userId),
        getSettings(userId),
        db
          .select({ phoneId: captureStreams.phoneId })
          .from(captureStreams)
          .where(
            and(
              eq(captureStreams.userId, userId),
              isNull(captureStreams.endedAt),
              gte(captureStreams.lastFrameAt, new Date(Date.now() - LIVE_WINDOW_MS)),
            ),
          ),
      ]);
      return {
        profile,
        teach: teachState(userId),
        pendantLive: live.some((s) => s.phoneId !== null && isPhoneOnline(s.phoneId)),
        pipelineRunning: livePipeline.running,
        webhookConfigured: settings.agent.webhookUrl !== "",
      };
    }),
    commands: authed.voice.commands.handler(async ({ context, input }) => {
      const rows = await listCommands((context as Ctx).userId, input.limit, input.before);
      return rows.map((r) => ({
        id: r.id,
        spokenAt: r.spokenAt,
        endedAt: r.endedAt,
        wakeName: r.wakeName,
        heardAs: r.heardAs,
        nameScore: r.nameScore,
        transcript: r.transcript,
        command: r.command,
        speakerScore: r.speakerScore,
        status: r.status,
        reason: r.reason,
        attempts: r.attempts,
        httpStatus: r.httpStatus,
        latencyMs:
          r.sentAt && r.status === "sent" ? r.sentAt.getTime() - r.endedAt.getTime() : null,
        feedback: r.feedback,
      }));
    }),
    feedback: authed.voice.feedback.handler(async ({ context, input }) => {
      try {
        await setFeedback((context as Ctx).userId, input.id, input.feedback);
      } catch (err) {
        if (err instanceof FeedbackError)
          throw new ORPCError("BAD_REQUEST", { message: err.message });
        throw err;
      }
      return { ok: true as const };
    }),
    test: authed.voice.test.handler(async ({ context }) => {
      const r = await sendTestCommand((context as Ctx).userId);
      return { status: r.status, reason: r.reason, httpStatus: r.httpStatus };
    }),
    teach: {
      start: authed.voice.teach.start.handler(async ({ context, input }) => {
        const { userId, session } = context as Ctx;
        await startTeach(userId, session.user.name, input.kind);
        return { ok: true as const };
      }),
      stop: authed.voice.teach.stop.handler(({ context }) => {
        stopTeach((context as Ctx).userId);
        return { ok: true as const };
      }),
      skip: authed.voice.teach.skip.handler(async ({ context }) => {
        await teachCall(() => skipPhrase((context as Ctx).userId));
        return { ok: true as const };
      }),
      upload: authed.voice.teach.upload.handler(async ({ context, input }) => {
        const bytes = Buffer.from(input.pcm, "base64");
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
        await teachCall(() => uploadSample((context as Ctx).userId, input.sessionId, pcm.slice()));
        return { ok: true as const };
      }),
    },
  },

  bookmarks: {
    create: authed.bookmarks.create.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      const [row] = await db
        .insert(bookmarks)
        .values({ userId, at: input.at ?? new Date(), source: "web", note: input.note ?? null })
        .returning();
      invalidate(userId, ["timeline"]);
      return { id: row!.id, at: row!.at, source: row!.source, note: row!.note };
    }),
  },

  notifications: {
    list: authed.notifications.list.handler(async ({ context, input }) => {
      const { userId } = context as Ctx;
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            input.before ? lt(notifications.createdAt, input.before) : undefined,
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(input.limit);
      return rows.map((n) => ({
        id: n.id,
        source: n.source,
        category: n.category,
        title: n.title,
        body: n.body,
        deepLink: n.deepLink,
        interruptionLevel: n.interruptionLevel,
        status: n.status,
        statusReason: n.statusReason,
        createdAt: n.createdAt,
        sentAt: n.sentAt,
        deliveredAt: n.deliveredAt,
        openedAt: n.openedAt,
      }));
    }),
    opened: authed.notifications.opened.handler(async ({ context, input }) => {
      await markOpened((context as Ctx).userId, input.id);
      return { ok: true as const };
    }),
    sendTest: authed.notifications.sendTest.handler(async ({ context, input }) => {
      const row = await notify({
        userId: (context as Ctx).userId,
        category: "test",
        title: input.title ?? "Hearloom test",
        body: input.body ?? "If you can read this, notifications work.",
        haptic: input.haptic ?? true,
        interruptionLevel: "time-sensitive",
        deepLink: "/notifications",
      });
      return { id: row.id, status: row.status };
    }),
  },
});

export type Router = typeof router;
