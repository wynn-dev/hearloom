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

const configuredHosts = hostnamesOf([env.PUBLIC_URL, ...extraOrigins]);

/**
 * Whether a host name can't be pointed at this server by someone else's DNS (DNS rebinding): an IP
 * literal, localhost, a single-label name (no public DNS), a Tailscale MagicDNS name (`*.ts.net`,
 * whose DNS Tailscale runs), or a host this server is configured with. `hostname` is as `URL`
 * normalizes it (lower case, IPv6 in brackets).
 */
export function rebindSafe(hostname: string, configured: Set<string>): boolean {
  return (
    hostname === "localhost" ||
    IPV4.test(hostname) ||
    hostname.startsWith("[") ||
    !hostname.includes(".") ||
    hostname.endsWith(".ts.net") ||
    configured.has(hostname)
  );
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
  // Checked under `bun test` too (better-auth skips it there by default), so tests see what runs.
  advanced: { disableOriginCheck: false },
  plugins: [admin(), bearer()],
});

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** Resolve a session from cookies or an `Authorization: Bearer` header. */
export async function getSession(headers: Headers): Promise<AuthSession | null> {
  return auth.api.getSession({ headers });
}
