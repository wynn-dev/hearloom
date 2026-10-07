import { readFileSync } from "node:fs";
import { schema } from "@hearloom/db";
import type { HapticPattern } from "@hearloom/shared";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { isPhoneOnline, sendToPhone } from "../ingest/phones";
import { invalidate } from "../realtime";
import { getSettings } from "../settings";
import { ApnsClient, type ApnsNotification } from "./apns";
import { decide, type InterruptionLevel } from "./policy";

const { notifications, notificationDeliveries, phones } = schema;
type NotificationRow = typeof notifications.$inferSelect;

/** A system alert (capture health, the test button). */
export interface NotifyInput {
  userId: string;
  category: string;
  title: string;
  body: string;
  deepLink?: string;
  interruptionLevel?: InterruptionLevel;
  collapseKey?: string;
  /** Buzz the pendant. Defaults to true for time-sensitive; never for notifications delivered silently. */
  haptic?: boolean;
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

/** Create a notification, apply policy (which can only make it quieter or refuse it) and deliver it now. */
export async function notify(input: NotifyInput): Promise<NotificationRow> {
  const settings = await getSettings(input.userId);
  const requested = input.interruptionLevel ?? "active";
  const decision = decide(settings, requested, new Date());
  const level = decision.action === "send" ? decision.level : requested;
  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      source: "system",
      category: input.category,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 4000),
      deepLink: sanitizeDeepLink(input.deepLink) ?? null,
      interruptionLevel: level,
      collapseKey: input.collapseKey ?? null,
      // Time-sensitive buzzes the pendant unless the caller says otherwise; silent never does.
      haptic: level !== "passive" && (input.haptic ?? level === "time-sensitive"),
      status: decision.action === "refuse" ? "suppressed" : "pending",
      statusReason: decision.action === "refuse" ? decision.reason : decision.quietedBy,
    })
    .returning();
  if (!row) throw new Error("failed to create notification");
  const result =
    decision.action === "refuse" ? row : await deliver(row, settings.notifications.pendantHaptic);
  invalidate(row.userId, ["notifications"]);
  return result;
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

export type PhoneOutcome = "acked" | "apns" | "socket" | "failed";

/**
 * One copy per phone. Apple push goes first: it reaches a suspended app, and nothing follows it, so a
 * late socket ack can't put a second banner on the phone. The live socket is the fallback when push
 * isn't set up or fails, and the only way to buzz the pendant.
 */
export async function deliverToPhone(channels: {
  push: (() => Promise<boolean>) | null;
  socket: (() => Promise<"acked" | "unacked" | "failed">) | null;
  buzz: (() => void) | null;
}): Promise<PhoneOutcome> {
  if (channels.push && (await channels.push())) {
    channels.buzz?.();
    return "apns";
  }
  if (channels.socket) {
    const sent = await channels.socket();
    if (sent !== "failed") return sent === "acked" ? "acked" : "socket";
  }
  return "failed";
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
    category: "HL_SYSTEM",
    deepLink: row.deepLink,
    interruptionLevel: row.interruptionLevel,
    collapseKey: row.collapseKey,
  };
  const record = (
    phoneId: string,
    delivery: Omit<typeof notificationDeliveries.$inferInsert, "notificationId" | "phoneId">,
  ) => db.insert(notificationDeliveries).values({ notificationId: row.id, phoneId, ...delivery });

  const outcomes = await Promise.all(
    targets.map(async (phone) => {
      const { apnsToken, apnsEnv } = phone;
      const online = isPhoneOnline(phone.id);
      const outcome = await deliverToPhone({
        push:
          apns && apnsToken && apnsEnv
            ? async () => {
                const res = await apns.send(apnsToken, apnsEnv, apnsMsg);
                await record(phone.id, {
                  channel: "apns",
                  status: res.ok ? "sent" : "failed",
                  apnsId: res.apnsId ?? null,
                  error: res.ok ? null : `${res.status} ${res.reason ?? ""}`.trim(),
                });
                if (res.unregistered) {
                  await db.update(phones).set({ apnsToken: null }).where(eq(phones.id, phone.id));
                }
                return res.ok;
              }
            : null,
        socket: online
          ? async () => {
              const ackP = waitForAck(row.id, phone.id);
              const sent = sendToPhone(phone.id, {
                t: "notify",
                id: row.id,
                title: row.title,
                body: row.body,
                category: apnsMsg.category,
                deepLink: row.deepLink ?? undefined,
                interruptionLevel: row.interruptionLevel,
                haptic,
              });
              if (!sent) {
                pendingAcks.delete(ackKey(row.id, phone.id));
                return "failed";
              }
              const acked = await ackP;
              await record(phone.id, { channel: "socket", status: acked ? "acked" : "sent" });
              return acked ? "acked" : "unacked";
            }
          : null,
        buzz:
          haptic && online
            ? () => void sendToPhone(phone.id, { t: "haptic", pattern: haptic })
            : null,
      });
      if (outcome === "failed" && !(apns && apnsToken && apnsEnv)) {
        await record(phone.id, {
          channel: "apns",
          status: "failed",
          error: apns ? "no_push_token" : "apns_not_configured",
        });
      }
      return outcome;
    }),
  );

  const now = new Date();
  if (outcomes.includes("acked")) {
    return setStatus(row.id, { status: "delivered", sentAt: now, deliveredAt: now });
  }
  if (outcomes.includes("apns") || outcomes.includes("socket")) {
    return setStatus(row.id, { status: "sent", sentAt: now });
  }
  return setStatus(row.id, { status: "failed", statusReason: "all_channels_failed" });
}

/** The user opened a notification (tapped it on the phone). */
export async function markOpened(userId: string, id: string): Promise<void> {
  await db
    .update(notifications)
    .set({ openedAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  invalidate(userId, ["notifications"]);
}

export function stopNotifications(): void {
  apns?.close();
}
