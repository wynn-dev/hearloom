import { contract } from "@hearloom/api";
import { schema } from "@hearloom/db";
import { implement, ORPCError } from "@orpc/server";
import { and, asc, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { type AuthSession, getSession } from "../auth";
import { db } from "../db";
import { chunkUrl } from "../http/media";
import { isPhoneOnline } from "../ingest/phones";
import { notify, recordFeedback } from "../notify/gateway";
import { invalidate } from "../realtime";
import { getSettings, updateSettings } from "../settings";

const {
  phones,
  wearables,
  captureStreams,
  audioChunks,
  bookmarks,
  deviceEvents,
  notifications,
  conversations,
  utterances,
  soundEvents,
  people,
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
    update: authed.settings.update.handler(({ context, input }) =>
      updateSettings((context as Ctx).userId, input),
    ),
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

      const [chunkRows, bookmarkRows, eventRows, convRows, uttRows, soundRows] = await Promise.all([
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
        db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.userId, userId),
              lt(conversations.startedAt, to),
              or(isNull(conversations.endedAt), gte(conversations.endedAt, from)),
            ),
          )
          .orderBy(asc(conversations.startedAt)),
        db
          .select({ u: utterances, personName: people.name })
          .from(utterances)
          .leftJoin(people, eq(people.id, utterances.personId))
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
        conversations: convRows.map((c) => ({
          id: c.id,
          startedAt: c.startedAt,
          endedAt: c.endedAt,
          status: c.status,
          languages: c.languages,
          speakerCount: c.speakerCount,
          title: c.title,
        })),
        utterances: uttRows.map(({ u, personName }) => ({
          id: u.id,
          conversationId: u.conversationId,
          startAt: u.startAt,
          endAt: u.endAt,
          speakerKey: u.speakerKey,
          personId: u.personId,
          personName,
          isWearer: u.isWearer,
          text: u.text,
          lang: u.lang,
          source: u.source,
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
        feedback: n.feedback,
        replyText: n.replyText,
        metadata: n.metadata,
      }));
    }),
    feedback: authed.notifications.feedback.handler(async ({ context, input }) => {
      await recordFeedback((context as Ctx).userId, input.id, input.action, input.replyText);
      return { ok: true as const };
    }),
    sendTest: authed.notifications.sendTest.handler(async ({ context, input }) => {
      const row = await notify({
        userId: (context as Ctx).userId,
        source: "system",
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
