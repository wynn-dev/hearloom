import { schema } from "@hearloom/db";
import { type BetterAuthPlugin, betterAuth, type DBAdapter, type Where } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { admin, bearer } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { env } from "./env";
import { attachLinkSession, consumeLinkCode, sha256Hex } from "./link/codes";
import { invalidate } from "./realtime";
import { clientKind, closeSockets, releasePhones } from "./sessions";

const extraOrigins = env.TRUSTED_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const staticOrigins = [env.PUBLIC_URL, `${env.APP_SCHEME}://`, ...extraOrigins];

/** host[:port] as a Host header carries it: a name or IPv4, or a bracketed IPv6 literal. */
const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Host names of http(s) origins in a list (PUBLIC_URL, TRUSTED_ORIGINS); others are skipped. */
export function hostnamesOf(origins: string[]): Set<string> {
  const names = new Set<string>();
  for (const o of origins) {
    // better-auth patterns ("https://*.example.com") name no one host.
    if (o.includes("*") || o.includes("?")) continue;
    try {
      const u = new URL(o);
      if (u.protocol === "http:" || u.protocol === "https:") names.add(u.hostname);
    } catch {
      // A custom scheme or a pattern: no host to add.
    }
  }
  return names;
}

/** Hosts of PUBLIC_URL and TRUSTED_ORIGINS. Exported for tests, which add hosts as if configured. */
export const configuredHosts = hostnamesOf([env.PUBLIC_URL, ...extraOrigins]);

/** `.<tailnet>.ts.net` for a Tailscale MagicDNS name (`<machine>.<tailnet>.ts.net`), else null. */
function tailnetOf(hostname: string): string | null {
  return /(\.[a-z0-9-]+\.ts\.net)$/.exec(hostname)?.[1] ?? null;
}

/**
 * Whether a host name can't be pointed at this server by someone else's DNS (DNS rebinding): an IP
 * literal, localhost, a host this server is configured with (PUBLIC_URL, TRUSTED_ORIGINS), a machine
 * on the same tailnet as one of those (`*.<tailnet>.ts.net`), or a single-label name (no public DNS,
 * and `http://macbook:3000` needs it). The residual risk is single-label names and tailnet names
 * resolved by a hostile resolver (a network's DNS or search domain), which could hand out an
 * attacker's address for them first. `hostname` is as `URL` normalizes it (lower case, IPv6 in brackets).
 */
export function rebindSafe(hostname: string, configured: Set<string>): boolean {
  if (
    hostname === "localhost" ||
    IPV4.test(hostname) ||
    hostname.startsWith("[") ||
    !hostname.includes(".") ||
    configured.has(hostname)
  ) {
    return true;
  }
  const tailnet = tailnetOf(hostname);
  return tailnet !== null && [...configured].some((c) => tailnetOf(c) === tailnet);
}

/**
 * The origin a request was addressed to, as the client saw it. `tailscale serve` keeps the Host header
 * and sets X-Forwarded-Host and (over HTTPS) X-Forwarded-Proto; Vite's dev proxy keeps Host. Null
 * unless the headers name exactly one plain http(s) origin.
 */
export function requestOrigin(req: Request): string | null {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  if (!host || !HOST.test(host) || (proto !== "http" && proto !== "https")) return null;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/** The request's own origin, if it may be trusted as such: only on a host name that can't be rebound. */
export function trustedOwnOrigin(req: Request, configured = configuredHosts): string | null {
  const origin = requestOrigin(req);
  return origin && rebindSafe(new URL(origin).hostname, configured) ? origin : null;
}

/** Content types any page can POST anywhere without a CORS preflight. */
const SIMPLE_CONTENT_TYPES = new Set([
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
]);

const contentTypeOf = (req: Request) =>
  req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

/**
 * Whether a request's body is of a type any page can send anywhere without a CORS preflight: plain
 * text, a form or multipart. better-auth takes form posts for sign-in (no-JS forms); Hearloom's
 * clients only send JSON, so the auth route refuses these before they reach the rate limiter.
 */
export function hasSimpleBody(req: Request): boolean {
  const type = contentTypeOf(req);
  return type !== undefined && SIMPLE_CONTENT_TYPES.has(type);
}

/**
 * Whether a page on another origin can't send this request without a CORS preflight (which this
 * server never grants): it has a body of a type other than the simple ones. True for every real auth
 * call with a body (JSON, and lookalikes like `application/jsonx` that better-auth also parses);
 * false for GETs and bodiless POSTs, which any page can send and which carry no credentials.
 */
export function needsPreflight(req: Request): boolean {
  const type = contentTypeOf(req);
  return !!type && !SIMPLE_CONTENT_TYPES.has(type);
}

/** A stored session token: the SHA-256 (hex) of the token the client holds. */
const STORED_TOKEN = /^[0-9a-f]{64}$/;

/**
 * Store session tokens hashed, so a copy of the database (a backup, a dump) can't be used to sign in
 * as anyone. better-auth reads and writes the session row by its token; this adapter hashes the token
 * on the way in and hands the caller's own token back on the way out (better-auth sets it as the cookie
 * again when a session slides forward). Rows found by listing (findMany) carry the hash, so endpoints
 * that take a token from such a list are disabled below (disabledPaths); Devices revokes by session id.
 *
 * Rows still holding a plain token (stored before migration 0009 hashed them, or by an older server
 * against the same database) are found by it once and hashed then. A 64-hex token is never looked up
 * plainly: that is what a stored hash looks like, and presenting one must not match its row.
 */
export function hashSessionTokens(adapter: DBAdapter): DBAdapter {
  const isSession = (args: { model: string }) => args.model === "session";
  const hashWhere = (where: Where[] | undefined) =>
    where?.map((w) => {
      if (w.field !== "token") return w;
      const value = Array.isArray(w.value)
        ? (w.value as unknown[]).map((v) => (typeof v === "string" ? sha256Hex(v) : v))
        : typeof w.value === "string"
          ? sha256Hex(w.value)
          : w.value;
      return { ...w, value } as Where;
    });
  /** The token a where clause looks a single row up by, which is handed back in place of the hash. */
  const tokenOf = (where: Where[] | undefined) => {
    const w = where?.find((w) => w.field === "token" && (w.operator ?? "eq") === "eq");
    return typeof w?.value === "string" ? w.value : undefined;
  };
  const withToken = <T>(row: T, token: string | undefined): T =>
    row && token !== undefined && typeof row === "object" && "token" in row
      ? { ...row, token }
      : row;
  const hashUpdate = <U>(update: U): U => {
    const u = update as Record<string, unknown>;
    return typeof u?.token === "string" ? ({ ...u, token: sha256Hex(u.token) } as U) : update;
  };
  const whereOnly = <K extends "findMany" | "count" | "updateMany" | "delete" | "deleteMany">(
    key: K,
  ) =>
    (async (args: { model: string; where?: Where[] }) =>
      (adapter[key] as (a: unknown) => Promise<unknown>)(
        isSession(args) ? { ...args, where: hashWhere(args.where) } : args,
      )) as unknown as DBAdapter[K];

  const wrapped: DBAdapter = {
    ...adapter,
    create: (async (args: Parameters<DBAdapter["create"]>[0]) => {
      const token = args.data.token;
      if (!isSession(args) || typeof token !== "string") return adapter.create(args);
      return withToken(
        await adapter.create({ ...args, data: { ...args.data, token: sha256Hex(token) } }),
        token,
      );
    }) as DBAdapter["create"],
    findOne: (async (args: Parameters<DBAdapter["findOne"]>[0]) => {
      if (!isSession(args)) return adapter.findOne(args);
      const token = tokenOf(args.where);
      const row = await adapter.findOne({ ...args, where: hashWhere(args.where) ?? [] });
      if (row || token === undefined || STORED_TOKEN.test(token)) return withToken(row, token);
      // A row from before hashing: find it by its plain token once, and hash it.
      const legacy = await adapter.findOne<{ id: string; token: string }>(args);
      if (!legacy || legacy.token !== token) {
        // A concurrent request may have just hashed it.
        return withToken(
          await adapter.findOne({ ...args, where: hashWhere(args.where) ?? [] }),
          token,
        );
      }
      await adapter.update({
        model: "session",
        where: [{ field: "id", value: legacy.id }],
        update: { token: sha256Hex(token) },
      });
      return legacy;
    }) as DBAdapter["findOne"],
    update: (async (args: Parameters<DBAdapter["update"]>[0]) => {
      if (!isSession(args)) return adapter.update(args);
      const update = args.update as Record<string, unknown>;
      const token = typeof update.token === "string" ? update.token : tokenOf(args.where);
      return withToken(
        await adapter.update({
          ...args,
          where: hashWhere(args.where) ?? [],
          update: hashUpdate(args.update),
        }),
        token,
      );
    }) as DBAdapter["update"],
    updateMany: (async (args: Parameters<DBAdapter["updateMany"]>[0]) =>
      adapter.updateMany(
        isSession(args)
          ? { ...args, where: hashWhere(args.where) ?? [], update: hashUpdate(args.update) }
          : args,
      )) as DBAdapter["updateMany"],
    findMany: whereOnly("findMany"),
    count: whereOnly("count"),
    delete: whereOnly("delete"),
    deleteMany: whereOnly("deleteMany"),
    consumeOne: (async (args: Parameters<DBAdapter["consumeOne"]>[0]) => {
      if (!isSession(args)) return adapter.consumeOne(args);
      return withToken(
        await adapter.consumeOne({ ...args, where: hashWhere(args.where) ?? [] }),
        tokenOf(args.where),
      );
    }) as DBAdapter["consumeOne"],
    incrementOne: (async (args: Parameters<DBAdapter["incrementOne"]>[0]) =>
      adapter.incrementOne(
        isSession(args) ? { ...args, where: hashWhere(args.where) ?? [] } : args,
      )) as DBAdapter["incrementOne"],
    // Work done in a transaction goes through the adapter it is handed: hash there too.
    transaction: ((cb: (trx: DBAdapter) => Promise<unknown>) =>
      adapter.transaction((trx) =>
        cb(hashSessionTokens(trx as DBAdapter)),
      )) as DBAdapter["transaction"],
  };
  return wrapped;
}

const pgAdapter = drizzleAdapter(db, {
  provider: "pg",
  schema: {
    user: schema.user,
    session: schema.session,
    account: schema.account,
    verification: schema.verification,
  },
});

/**
 * "Link device": a device signs in with a single-use code (link/codes.ts) instead of a password. It
 * gets a session of its own, like a password sign-in: a cookie for a browser, and `set-auth-token`
 * (bearer plugin) for the app. Same protections as sign-in: JSON only (http/app.ts), origin-checked.
 */
const linkDevice = () =>
  ({
    id: "link-device",
    endpoints: {
      redeemLinkCode: createAuthEndpoint(
        "/link/redeem",
        {
          method: "POST",
          body: z.object({ code: z.string().max(64) }),
        },
        async (ctx) => {
          const code = await consumeLinkCode(ctx.body.code);
          if (!code) {
            throw new APIError("UNAUTHORIZED", {
              message: "That code is wrong, expired or already used. Make a new one.",
              code: "INVALID_LINK_CODE",
            });
          }
          const user = await ctx.context.internalAdapter.findUserById(code.userId);
          if (!user)
            throw new APIError("UNAUTHORIZED", { message: "That account no longer exists." });
          // Refused for a banned user (admin plugin's session hook).
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await attachLinkSession(code.id, session.id);
          await setSessionCookie(ctx, { session, user });
          invalidate(user.id, ["sessions"]);
          return ctx.json({ user: { id: user.id, email: user.email, name: user.name } });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

export const auth = betterAuth({
  appName: "Hearloom",
  baseURL: env.PUBLIC_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: (options) => hashSessionTokens(pgAdapter(options)),
  // No passwords: devices sign in with "Link device" codes (linkDevice below). Accounts are created by
  // an admin (console → Users) or `pnpm link-device --create`; old password hashes stay unused.
  emailAndPassword: { enabled: false },
  disabledPaths: [
    // Passwords (better-auth keeps some of these routes with email/password off; a stale client asking
    // for sign-in gets a clear 404 from http/app.ts first).
    "/sign-in/email",
    "/sign-up/email",
    "/change-password",
    "/verify-password",
    "/request-password-reset",
    "/reset-password",
    "/admin/set-user-password",
    // These take a session token from a list of sessions, which holds hashes (hashSessionTokens).
    // Devices in the console lists and revokes sessions by id instead (rpc: sessions.*).
    "/list-sessions",
    "/revoke-session",
    "/revoke-other-sessions",
    "/admin/list-user-sessions",
    "/admin/revoke-user-session",
  ],
  session: {
    // The phone stays signed in for months; sessions slide forward on use.
    expiresIn: 60 * 60 * 24 * 180,
    updateAge: 60 * 60 * 24,
  },
  // Same-origin requests are trusted too: an Origin equal to the address the request came in on (the
  // console served by this server or by Vite, the app signed in with any URL that reaches it), so
  // TRUSTED_ORIGINS is only for genuinely cross-origin setups. A page on another origin can't make
  // the two agree by itself: browsers set Host, and custom X-Forwarded-* headers need a CORS preflight
  // this server never grants. It can by DNS rebinding, though: evil.example re-resolved to this
  // machine makes Origin and Host both evil.example. So only host names nobody else's DNS can point
  // here count (trustedOwnOrigin); any other name has to be PUBLIC_URL's or in TRUSTED_ORIGINS.
  trustedOrigins: (request) => {
    const own = request ? trustedOwnOrigin(request) : null;
    return own ? [...staticOrigins, own] : staticOrigins;
  },
  // On whatever NODE_ENV says (`pnpm start` sets none; better-auth would only limit in production):
  // 100 requests per 10 s per auth path, link-code sign-in included (60-bit codes can't be guessed at
  // that rate). Only requests that need a CORS preflight count (needsPreflight); the auth route already refused
  // plain-text and form bodies (hasSimpleBody). The limiter runs before better-auth's content-type and
  // origin checks, and its buckets are shared (below), so otherwise any web page could keep them full
  // for everyone: plain-text POSTs would hold sign-in at 429, and image loads of /get-session
  // would make the console report the server unreachable. Every real auth call (console, app) is JSON
  // or a GET or bodiless POST without credentials.
  rateLimit: {
    enabled: true,
    customRules: { "/**": (req, current) => (needsPreflight(req) ? current : false) },
  },
  advanced: {
    // Checked under `bun test` too (better-auth skips it there by default), so tests see what runs.
    disableOriginCheck: false,
    // No client IP header is trusted, so every client shares one bucket per path. Per-IP buckets would
    // come from a header the client sends (X-Forwarded-For), and a guesser could pick a new address for
    // every try. On a personal server one bucket is fine: the limit only slows sign-ins (existing
    // sessions don't sign in again), and the rest of the auth paths have plenty of room. The one-time
    // better-auth warning about "a single shared per-path bucket" is this, on purpose.
    ipAddress: { ipAddressHeaders: [] },
  },
  hooks: {
    // Managing users and signing every device out are for the console: an admin's phone token (stolen
    // with the phone) must not impersonate someone (which would get it a browser session to mint link
    // codes with) or sign the owner's browsers out.
    before: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith("/admin/") && ctx.path !== "/revoke-sessions") return;
      // No passwords: an account made with one would only store a hash nobody can use.
      if (ctx.path === "/admin/create-user" && (ctx.body as { password?: unknown })?.password) {
        throw new APIError("BAD_REQUEST", {
          message: "Passwords are off: create the account without one, then link a device.",
        });
      }
      // From the request (this runs before the bearer plugin turns a token into a cookie).
      const headers = ctx.request?.headers ?? ctx.headers;
      const session = headers ? await auth.api.getSession({ headers }) : null;
      if (session && clientKind(session.session.userAgent) !== "browser") {
        throw new APIError("FORBIDDEN", { message: "Use the web console for this." });
      }
    }),
  },
  databaseHooks: {
    session: {
      delete: {
        // However a session ends (sign-out, ban, user removed, all devices signed out): its phone stops
        // getting pushes and its open sockets close. Before the delete, which unsets phones.session_id.
        before: async (s) => {
          await releasePhones(s.userId, eq(schema.phones.sessionId, s.id));
        },
        after: async (s) => {
          closeSockets(s.id);
          invalidate(s.userId, ["sessions", "phones", "status"]);
        },
      },
    },
  },
  plugins: [admin(), bearer(), linkDevice()],
});

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** Resolve a session from cookies or an `Authorization: Bearer` header. */
export async function getSession(headers: Headers): Promise<AuthSession | null> {
  return auth.api.getSession({ headers });
}
