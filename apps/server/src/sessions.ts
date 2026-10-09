/**
 * Signed-in devices: every better-auth session of a user (the iPhone app's bearer token, a browser's
 * cookie), listed in the console under Devices and revocable there. Revoking ends the session for good:
 * its row is deleted, its open sockets close, and a phone on it stops getting pushes.
 */
import { schema } from "@hearloom/db";
import type { ServerWebSocket } from "bun";
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { db } from "./db";
import { invalidate } from "./realtime";

const { session, phones, captureStreams } = schema;

/**
 * Whether a session belongs to a browser or to the app, from the user agent it was created with
 * (stored by better-auth, never updated). Browsers all send "Mozilla/5.0 …"; the iPhone app's requests
 * carry CFNetwork's "Hearloom/<build> CFNetwork/… Darwin/…".
 */
export function clientKind(userAgent: string | null | undefined): "browser" | "app" {
  return userAgent?.startsWith("Mozilla/") ? "browser" : "app";
}

/** "Safari on macOS", "Chrome on Windows", … from a user agent; "Browser" if unrecognized. */
export function describeBrowser(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /(?:Firefox|FxiOS)\//.test(ua)
      ? "Firefox"
      : /(?:Chrome|CriOS)\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return os ? `${browser} on ${os}` : browser;
}

// Open WebSockets (ingest from the app, realtime from the console) by the session they authenticated
// with: a revoked session's sockets are closed, not left streaming until they happen to reconnect.
const sockets = new Map<string, Set<ServerWebSocket<unknown>>>();

export function trackSocket(sessionId: string, ws: ServerWebSocket<unknown>): void {
  const set = sockets.get(sessionId) ?? new Set();
  set.add(ws);
  sockets.set(sessionId, set);
}

export function untrackSocket(sessionId: string, ws: ServerWebSocket<unknown>): void {
  const set = sockets.get(sessionId);
  set?.delete(ws);
  if (set?.size === 0) sockets.delete(sessionId);
}

export function closeSockets(sessionId: string): void {
  // 1008 (policy violation): the app reconnects, gets a 401 and pauses until signed in again; audio
  // it hasn't uploaded stays buffered on the phone.
  for (const ws of sockets.get(sessionId) ?? []) ws.close(1008, "session revoked");
  sockets.delete(sessionId);
}

/**
 * A phone is signing out (or its sign-in was revoked): end its open capture streams and stop pushing
 * to it. Audio it already uploaded is kept.
 */
export async function releasePhones(userId: string, which: SQL | undefined): Promise<void> {
  const ids = (
    await db
      .select({ id: phones.id })
      .from(phones)
      .where(and(eq(phones.userId, userId), which))
  ).map((p) => p.id);
  if (ids.length === 0) return;
  await db
    .update(captureStreams)
    .set({ endedAt: sql`coalesce(${captureStreams.lastFrameAt}, ${captureStreams.startedAt})` })
    .where(
      and(
        eq(captureStreams.userId, userId),
        inArray(captureStreams.phoneId, ids),
        isNull(captureStreams.endedAt),
      ),
    );
  await db.update(phones).set({ apnsToken: null }).where(inArray(phones.id, ids));
}

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await db
    .select({
      id: session.id,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      phoneId: phones.id,
      phoneName: phones.name,
      phoneModel: phones.model,
    })
    .from(session)
    .leftJoin(phones, eq(phones.sessionId, session.id))
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
    .orderBy(asc(session.createdAt));
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    if (seen.has(r.id)) return [];
    seen.add(r.id);
    const kind = clientKind(r.userAgent);
    return [
      {
        id: r.id,
        kind,
        name:
          kind === "browser"
            ? describeBrowser(r.userAgent)
            : (r.phoneName ?? "Hearloom app (not registered yet)"),
        detail: kind === "app" ? r.phoneModel : null,
        ipAddress: r.ipAddress || null,
        phoneId: r.phoneId,
        current: r.id === currentSessionId,
        createdAt: r.createdAt,
        lastActiveAt: r.updatedAt,
        expiresAt: r.expiresAt,
      },
    ];
  });
}

/** Banned now (a ban past its expiry no longer counts, as in better-auth's admin plugin). */
export function isBanned(user: { banned?: boolean | null; banExpires?: Date | null }): boolean {
  return !!user.banned && (!user.banExpires || user.banExpires.getTime() > Date.now());
}

/**
 * Sign a session out for good. False if the user has no such session. `keepPhone`: the phone on it is
 * signing in again (its streams and push token carry over to the new session).
 */
export async function revokeSession(
  userId: string,
  sessionId: string,
  { keepPhone = false } = {},
): Promise<boolean> {
  const [own] = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId)));
  if (!own) return false;
  if (!keepPhone) await releasePhones(userId, eq(phones.sessionId, sessionId));
  await db.delete(session).where(eq(session.id, sessionId));
  closeSockets(sessionId);
  invalidate(userId, ["sessions", "phones", "status"]);
  return true;
}
