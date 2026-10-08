import { schema } from "@hearloom/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer } from "better-auth/plugins";
import { db } from "./db";
import { env } from "./env";

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

export const auth = betterAuth({
  appName: "Hearloom",
  baseURL: env.PUBLIC_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  // Invite-only: accounts are created by an admin (console) or `pnpm create-user`.
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },
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
  // 3 sign-ins (and password or email changes) per 10 s, 100 requests per 10 s on other auth paths.
  // Only requests that need a CORS preflight count (needsPreflight); the auth route already refused
  // plain-text and form bodies (hasSimpleBody). The limiter runs before better-auth's content-type and
  // origin checks, and its buckets are shared (below), so otherwise any web page could keep them full
  // for everyone: plain-text sign-in POSTs would hold sign-in at 429, and image loads of /get-session
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
  plugins: [admin(), bearer()],
});

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** Resolve a session from cookies or an `Authorization: Bearer` header. */
export async function getSession(headers: Headers): Promise<AuthSession | null> {
  return auth.api.getSession({ headers });
}
