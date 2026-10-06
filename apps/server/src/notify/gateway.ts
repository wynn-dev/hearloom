import { readFileSync } from "node:fs";
import { schema } from "@hearloom/db";
import type { HapticPattern, NotificationSource } from "@hearloom/shared";
import { and, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { isPhoneOnline, sendToPhone } from "../ingest/phones";
import { liveState, onConversationEnd } from "../live/state";
import { invalidate } from "../realtime";
import { getSettings } from "../settings";
import { ApnsClient, type ApnsNotification } from "./apns";
import { type DeliverWhen, decide, type InterruptionLevel } from "./policy";

const { notifications, notificationDeliveries, phones } = schema;
type NotificationRow = typeof notifications.$inferSelect;

export interface NotifyInput {
  userId: string;
  source: NotificationSource;
  category: string;
  title: string;
  body: string;
  deepLink?: string;
  interruptionLevel?: InterruptionLevel;
  collapseKey?: string;
  threadId?: string;
  deliverWhen?: DeliverWhen;
  haptic?: boolean;
  metadata?: Record<string, unknown>;
}

const SOCKET_ACK_TIMEOUT_MS = 4000;

const apns: ApnsClient | null =
  env.APNS_KEY_PATH && env.APNS_KEY_ID && env.APNS_TEAM_ID
    ? new ApnsClient({
        keyPem: readFileSync(env.APNS_KEY_PATH, "utf8"),
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        bundleId: env.APNS_BUNDLE_ID,
      })
    : null;

export const apnsConfigured = apns !== null;

/** Deep links must stay inside the app: plain relative paths only (no schemes/hosts). */
export function sanitizeDeepLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  return /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(link) && !link.startsWith("//") ? link : undefined;
}

const pendingAcks = new Map<string, () => void>();

const ackKey = (notificationId: string, phoneId: string) => `${notificationId}:${phoneId}`;

/** Called by the ingest socket when the phone confirms it displayed a notification. */
export function onSocketAck(notificationId: string, phoneId: string): void {
  pendingAcks.get(ackKey(notificationId, phoneId))?.();
}

function waitForAck(notificationId: string, phoneId: string): Promise<boolean> {
  const key = ackKey(notificationId, phoneId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(key);
      resolve(false);
    }, SOCKET_ACK_TIMEOUT_MS);
    pendingAcks.set(key, () => {
      clearTimeout(timer);
      pendingAcks.delete(key);
      resolve(true);
    });
  });
}

/** Create a notification and run it through policy + delivery. */
export async function notify(input: NotifyInput): Promise<NotificationRow> {
  const interruptionLevel = input.interruptionLevel ?? "active";
  const deliverWhen = input.deliverWhen ?? "now";
  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      source: input.source,
      category: input.category,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 4000),
      deepLink: sanitizeDeepLink(input.deepLink) ?? null,
      interruptionLevel,
      collapseKey: input.collapseKey ?? null,
      threadId: input.threadId ?? null,
      deliverWhen,
      haptic: input.haptic ?? false,
      metadata: input.metadata ?? {},
    })
    .returning();
  if (!row) throw new Error("failed to create notification");

  if (row.collapseKey) {
    // A newer notification replaces any older one still waiting with the same key.
    await db
      .update(notifications)
      .set({ status: "suppressed", statusReason: "replaced" })
      .where(
        and(
          eq(notifications.userId, row.userId),
          eq(notifications.collapseKey, row.collapseKey),
          inArray(notifications.status, ["pending", "held"]),
          ne(notifications.id, row.id),
        ),
      );
  }
  return route(row);
}

async function sentInLastHour(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        ne(notifications.source, "system"),
        inArray(notifications.status, ["sent", "delivered"]),
        gte(notifications.sentAt, new Date(Date.now() - 3600_000)),
      ),
    );
  return r?.n ?? 0;
}

async function setStatus(
  id: string,
  patch: Partial<typeof notifications.$inferInsert>,
): Promise<NotificationRow> {
  const [row] = await db
    .update(notifications)
    .set(patch)
    .where(eq(notifications.id, id))
    .returning();
  return row!;
}

async function route(row: NotificationRow): Promise<NotificationRow> {
  const settings = await getSettings(row.userId);
  const decision = decide({
    settings,
    source: row.source,
    interruptionLevel: row.interruptionLevel,
    deliverWhen: row.deliverWhen,
    now: new Date(),
    sentLastHour: row.source === "system" ? 0 : await sentInLastHour(row.userId),
    inConversation: liveState(row.userId).inConversation,
  });
  let result: NotificationRow;
  if (decision.action === "suppress") {
    result = await setStatus(row.id, { status: "suppressed", statusReason: decision.reason });
  } else if (decision.action === "hold") {
    result = await setStatus(row.id, {
      status: "held",
      statusReason: decision.reason,
      scheduledFor: decision.until,
    });
  } else {
    result = await deliver(row, settings.notifications.pendantHaptic);
  }
  invalidate(row.userId, ["notifications"]);
  return result;
}

async function deliver(row: NotificationRow, pendantHaptic: boolean): Promise<NotificationRow> {
  const targets = await db
    .select()
    .from(phones)
    .where(and(eq(phones.userId, row.userId), eq(phones.pushEnabled, true)));
  if (targets.length === 0) {
    return setStatus(row.id, { status: "failed", statusReason: "no_phones" });
  }

  const haptic: HapticPattern | undefined = row.haptic && pendantHaptic ? "medium" : undefined;
  const apnsMsg: ApnsNotification = {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.source === "system" ? "HL_SYSTEM" : "HL_NUDGE",
    threadId: row.threadId,
    deepLink: row.deepLink,
    interruptionLevel: row.interruptionLevel,
    collapseKey: row.collapseKey,
  };

  const outcomes = await Promise.all(
    targets.map(async (phone): Promise<"acked" | "apns" | "failed"> => {
      // 1) Live socket: fastest, and the only path that can buzz the pendant.
      if (isPhoneOnline(phone.id)) {
        const ackP = waitForAck(row.id, phone.id);
        const sent = sendToPhone(phone.id, {
          t: "notify",
          id: row.id,
          title: row.title,
          body: row.body,
          category: apnsMsg.category,
          deepLink: row.deepLink ?? undefined,
          threadId: row.threadId ?? undefined,
          interruptionLevel: row.interruptionLevel,
          haptic,
        });
        if (sent && (await ackP)) {
          await db.insert(notificationDeliveries).values({
            notificationId: row.id,
            phoneId: phone.id,
            channel: "socket",
            status: "acked",
          });
          return "acked";
        }
        pendingAcks.delete(ackKey(row.id, phone.id));
      }
      // 2) APNs fallback.
      if (!apns || !phone.apnsToken || !phone.apnsEnv) {
        await db.insert(notificationDeliveries).values({
          notificationId: row.id,
          phoneId: phone.id,
          channel: "apns",
          status: "failed",
          error: apns ? "no_push_token" : "apns_not_configured",
        });
        return "failed";
      }
      const res = await apns.send(phone.apnsToken, phone.apnsEnv, apnsMsg);
      await db.insert(notificationDeliveries).values({
        notificationId: row.id,
        phoneId: phone.id,
        channel: "apns",
        status: res.ok ? "sent" : "failed",
        apnsId: res.apnsId ?? null,
        error: res.ok ? null : `${res.status} ${res.reason ?? ""}`.trim(),
      });
      if (res.unregistered) {
        await db.update(phones).set({ apnsToken: null }).where(eq(phones.id, phone.id));
      }
      return res.ok ? "apns" : "failed";
    }),
  );

  const now = new Date();
  if (outcomes.includes("acked")) {
    return setStatus(row.id, {
      status: "delivered",
      statusReason: null,
      sentAt: now,
      deliveredAt: now,
    });
  }
  if (outcomes.includes("apns")) {
    return setStatus(row.id, { status: "sent", statusReason: null, sentAt: now });
  }
  return setStatus(row.id, { status: "failed", statusReason: "all_channels_failed" });
}

/** Re-run held notifications whose hold has expired (quiet hours) or whose condition cleared. */
export async function releaseHeld(userId?: string): Promise<void> {
  const now = new Date();
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "held"),
        userId ? eq(notifications.userId, userId) : undefined,
        or(
          lte(notifications.scheduledFor, now),
          and(
            isNull(notifications.scheduledFor),
            eq(notifications.statusReason, "in_conversation"),
          ),
        ),
      ),
    );
  for (const row of rows) {
    if (row.statusReason === "in_conversation" && liveState(row.userId).inConversation) continue;
    await route({ ...row, status: "pending" });
  }
}

/** Mark the phone's display/feedback on a notification. */
export async function recordFeedback(
  userId: string,
  id: string,
  action: "opened" | "useful" | "not_useful" | "snoozed" | "reply",
  replyText?: string,
): Promise<void> {
  const patch: Partial<typeof notifications.$inferInsert> =
    action === "opened"
      ? { openedAt: new Date() }
      : action === "reply"
        ? { replyText: replyText ?? "", openedAt: new Date() }
        : { feedback: action };
  await db
    .update(notifications)
    .set(patch)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  invalidate(userId, ["notifications"]);
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startNotificationScheduler(): void {
  schedulerTimer ??= setInterval(() => {
    void releaseHeld().catch((err) => console.error("[notify] release failed", err));
  }, 30_000);
  onConversationEnd((userId) => {
    void releaseHeld(userId).catch((err) => console.error("[notify] release failed", err));
  });
}

export function stopNotifications(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  apns?.close();
}
