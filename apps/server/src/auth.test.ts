import "./test-db";
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import {
  auth,
  configuredHosts,
  hasSimpleBody,
  hostnamesOf,
  needsPreflight,
  rebindSafe,
  requestOrigin,
  trustedOwnOrigin,
} from "./auth";
import { env } from "./env";
import { app } from "./http/app";
import { generateCode, mintLinkCode } from "./link/codes";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test("requestOrigin: the Host and scheme the request came in on", () => {
  expect(requestOrigin(req("http://localhost:5173/api/auth/x", { host: "localhost:5173" }))).toBe(
    "http://localhost:5173",
  );
  // No Host header: the request URL's.
  expect(requestOrigin(req("http://127.0.0.1:3000/x"))).toBe("http://127.0.0.1:3000");
  // Default ports are dropped, as browsers do in Origin.
  expect(requestOrigin(req("http://a/x", { host: "Mac.Tail1234.ts.net:80" }))).toBe(
    "http://mac.tail1234.ts.net",
  );
  expect(requestOrigin(req("http://a/x", { host: "[::1]:3000" }))).toBe("http://[::1]:3000");
});

test("requestOrigin: tailscale serve's forwarded host and scheme", () => {
  const tailnet = {
    host: "mac.tail1234.ts.net",
    "x-forwarded-host": "mac.tail1234.ts.net",
    "x-forwarded-proto": "https",
  };
  expect(requestOrigin(req("http://mac.tail1234.ts.net/x", tailnet))).toBe(
    "https://mac.tail1234.ts.net",
  );
  expect(
    requestOrigin(
      req("http://mac.tail1234.ts.net:3000/x", {
        host: "mac.tail1234.ts.net:3000",
        "x-forwarded-host": "mac.tail1234.ts.net:3000",
        "x-forwarded-proto": "https",
      }),
    ),
  ).toBe("https://mac.tail1234.ts.net:3000");
  // Over HTTPS on 443 the port is implied.
  expect(
    requestOrigin(
      req("http://a/x", {
        "x-forwarded-host": "mac.tail1234.ts.net:443",
        "x-forwarded-proto": "https",
      }),
    ),
  ).toBe("https://mac.tail1234.ts.net");
  // X-Forwarded-Host wins over Host (a proxy that rewrote Host).
  expect(
    requestOrigin(req("http://a/x", { host: "127.0.0.1:3000", "x-forwarded-host": "mac:5173" })),
  ).toBe("http://mac:5173");
});

test("requestOrigin: anything but one plain http(s) host is no origin", () => {
  for (const headers of <Record<string, string>[]>[
    { "x-forwarded-host": "a.example, b.example" },
    { host: "a.example/evil" },
    { host: "user@a.example" },
    { host: "a.example?x" },
    { host: "*.example" },
    { host: "a.example:99999999" },
    { host: "a.example", "x-forwarded-proto": "https, http" },
    { host: "a.example", "x-forwarded-proto": "ftp" },
    { host: "" },
  ]) {
    expect(requestOrigin(req("http://127.0.0.1:3000/x", headers))).toBeNull();
  }
});

test("rebindSafe: only names nobody else's DNS can point at this server", () => {
  const configured = hostnamesOf([
    "https://mac.tail1234.ts.net",
    "http://console.example.org:8080",
    "hearloom://",
    "https://*.example.net",
  ]);
  expect([...configured].sort()).toEqual(["console.example.org", "mac.tail1234.ts.net"]);
  for (const safe of [
    "localhost",
    "127.0.0.1",
    "192.168.1.20",
    "100.83.218.9",
    "[::1]",
    "[fd7a:115c:a1e0::1]",
    "macbook",
    "mac.tail1234.ts.net",
    // Another machine on PUBLIC_URL's tailnet.
    "mini.tail1234.ts.net",
    "console.example.org",
  ]) {
    expect(rebindSafe(safe, configured)).toBe(true);
  }
  for (const unsafe of [
    "evil.example",
    "127.0.0.1.evil.example",
    "localhost.evil.example",
    "mac.tail1234.ts.net.evil.example",
    // Other tailnets: anyone can have one, and a hostile resolver can answer for any *.ts.net.
    "evil.tail9999.ts.net",
    "tail1234.ts.net",
    "evil.ts.net",
    "evil-ts.net",
    "sub.console.example.org",
    "example.net",
    "mac.local",
  ]) {
    expect(rebindSafe(unsafe, configured)).toBe(false);
  }
  // No tailnet configured: no *.ts.net name is trusted by name alone.
  expect(rebindSafe("mac.tail1234.ts.net", hostnamesOf(["http://localhost:3000"]))).toBe(false);
});

test("trustedOwnOrigin: the request's origin, unless its host could be rebound", () => {
  const configured = new Set(["mac.tail1234.ts.net", "hearloom.example.com"]);
  const own = (host: string, extra: Record<string, string> = {}) =>
    trustedOwnOrigin(req("http://127.0.0.1:3000/x", { host, ...extra }), configured);
  expect(own("evil.example:3000")).toBeNull();
  expect(own("evil.example", { "x-forwarded-proto": "https" })).toBeNull();
  expect(own("evil.tail9999.ts.net", { "x-forwarded-proto": "https" })).toBeNull();
  expect(own("192.168.1.20:3000")).toBe("http://192.168.1.20:3000");
  expect(own("macbook:3000")).toBe("http://macbook:3000");
  expect(own("mac.tail1234.ts.net", { "x-forwarded-proto": "https" })).toBe(
    "https://mac.tail1234.ts.net",
  );
  expect(own("mini.tail1234.ts.net:3000")).toBe("http://mini.tail1234.ts.net:3000");
  // A configured host on any port or scheme (e.g. a second serve handler).
  expect(own("hearloom.example.com:8443", { "x-forwarded-proto": "https" })).toBe(
    "https://hearloom.example.com:8443",
  );
});

// The requests below are made as if PUBLIC_URL were https://mac.tail1234.ts.net.
const TAILNET_HOST = "mac.tail1234.ts.net";
let tailnetWasConfigured = false;
beforeAll(() => {
  tailnetWasConfigured = configuredHosts.has(TAILNET_HOST);
  configuredHosts.add(TAILNET_HOST);
});
afterAll(() => {
  if (!tailnetWasConfigured) configuredHosts.delete(TAILNET_HOST);
  setSystemTime();
});

/** How devices sign in ("Link device"; there are no passwords). */
const SIGN_IN = "/api/auth/link/redeem";

/** A sign-in POST with a code nobody minted. */
function postSignIn(url: string, headers: Record<string, string>) {
  return app.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ code: generateCode() }),
    }),
  );
}

/** Moves the clock past the rate limit's 10 s window, so each check below starts fresh. */
function nextRateLimitWindow() {
  setSystemTime(new Date(Date.now() + 11_000));
}

/**
 * A sign-in that better-auth origin-checks (it does so when cookies are sent), with an unknown code:
 * 401 when the origin is trusted, 403 INVALID_ORIGIN when it isn't.
 */
async function signIn(url: string, headers: Record<string, string>) {
  nextRateLimitWindow();
  const res = await postSignIn(url, { cookie: "unrelated=1", ...headers });
  const body = (await res.json().catch(() => null)) as { code?: string } | null;
  return { status: res.status, code: body?.code };
}

test("auth trusts the origin a request came in on (tailscale serve, Vite, the app)", async () => {
  // Console or app at https://<machine>.ts.net via `tailscale serve --https=443`.
  expect(
    await signIn(`http://mac.tail1234.ts.net${SIGN_IN}`, {
      host: "mac.tail1234.ts.net",
      "x-forwarded-host": "mac.tail1234.ts.net",
      "x-forwarded-proto": "https",
      origin: "https://mac.tail1234.ts.net",
    }),
  ).toMatchObject({ status: 401 });
  // The same on another port (an extra --https=3000 handler).
  expect(
    await signIn(`http://mac.tail1234.ts.net:3000${SIGN_IN}`, {
      host: "mac.tail1234.ts.net:3000",
      "x-forwarded-host": "mac.tail1234.ts.net:3000",
      "x-forwarded-proto": "https",
      origin: "https://mac.tail1234.ts.net:3000",
    }),
  ).toMatchObject({ status: 401 });
  // Vite's dev proxy on localhost (keeps Host, adds no forwarded headers).
  expect(
    await signIn(`http://localhost:5173${SIGN_IN}`, {
      host: "localhost:5173",
      origin: "http://localhost:5173",
    }),
  ).toMatchObject({ status: 401 });
  // Plain HTTP straight to the server (the app over the tailnet without serve).
  expect(
    await signIn(`http://mac.tail1234.ts.net:3000${SIGN_IN}`, {
      host: "mac.tail1234.ts.net:3000",
      origin: "http://mac.tail1234.ts.net:3000",
    }),
  ).toMatchObject({ status: 401 });
});

test("auth still trusts PUBLIC_URL and TRUSTED_ORIGINS from any address", async () => {
  expect(
    await signIn(`http://127.0.0.1:3000${SIGN_IN}`, {
      host: "127.0.0.1:3000",
      origin: new URL(env.PUBLIC_URL).origin,
    }),
  ).toMatchObject({ status: 401 });
});

test("auth rejects an origin other than the request's own", async () => {
  const rejected = { status: 403, code: "INVALID_ORIGIN" };
  const tailnet = {
    host: "mac.tail1234.ts.net",
    "x-forwarded-host": "mac.tail1234.ts.net",
    "x-forwarded-proto": "https",
  };
  expect(
    await signIn(`http://mac.tail1234.ts.net${SIGN_IN}`, {
      ...tailnet,
      origin: "https://evil.example",
    }),
  ).toMatchObject(rejected);
  // Same host, other scheme or port.
  expect(
    await signIn(`http://mac.tail1234.ts.net${SIGN_IN}`, {
      ...tailnet,
      origin: "http://mac.tail1234.ts.net",
    }),
  ).toMatchObject(rejected);
  expect(
    await signIn(`http://mac.tail1234.ts.net${SIGN_IN}`, {
      ...tailnet,
      origin: "https://mac.tail1234.ts.net:5173",
    }),
  ).toMatchObject(rejected);
  // A look-alike host.
  expect(
    await signIn(`http://mac.tail1234.ts.net${SIGN_IN}`, {
      ...tailnet,
      origin: "https://mac.tail1234.ts.net.evil.example",
    }),
  ).toMatchObject(rejected);
  // Unparseable forwarded headers trust nothing extra.
  expect(
    await signIn(`http://127.0.0.1:3000${SIGN_IN}`, {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "evil.example, 127.0.0.1:3000",
      origin: "http://evil.example",
    }),
  ).toMatchObject(rejected);
});

test("auth trusts LAN addresses and single-label names it came in on", async () => {
  expect(
    await signIn(`http://192.168.1.20:3000${SIGN_IN}`, {
      host: "192.168.1.20:3000",
      origin: "http://192.168.1.20:3000",
    }),
  ).toMatchObject({ status: 401 });
  expect(
    await signIn(`http://macbook:3000${SIGN_IN}`, {
      host: "macbook:3000",
      origin: "http://macbook:3000",
    }),
  ).toMatchObject({ status: 401 });
});

test("DNS rebinding: a page on a name re-resolved to this machine isn't trusted", async () => {
  // http://evil.example:3000 rebound to the Mac's LAN IP or 127.0.0.1: Origin and Host agree, but
  // evil.example is someone else's name.
  for (const host of ["evil.example:3000", "evil.example", "127.0.0.1.nip.example:3000"]) {
    expect(
      await signIn(`http://${host}${SIGN_IN}`, { host, origin: `http://${host}` }),
    ).toMatchObject({ status: 403, code: "INVALID_ORIGIN" });
  }
});

test("auth trusts other machines on PUBLIC_URL's tailnet, not other tailnets", async () => {
  expect(
    await signIn(`http://mini.tail1234.ts.net:3000${SIGN_IN}`, {
      host: "mini.tail1234.ts.net:3000",
      origin: "http://mini.tail1234.ts.net:3000",
    }),
  ).toMatchObject({ status: 401 });
  expect(
    await signIn(`http://evil.tail9999.ts.net${SIGN_IN}`, {
      host: "evil.tail9999.ts.net",
      "x-forwarded-host": "evil.tail9999.ts.net",
      "x-forwarded-proto": "https",
      origin: "https://evil.tail9999.ts.net",
    }),
  ).toMatchObject({ status: 403, code: "INVALID_ORIGIN" });
});

test("sign-in is rate limited in one bucket for everyone: client IP headers don't split it", async () => {
  nextRateLimitWindow();
  const statuses: number[] = [];
  for (let i = 1; i <= 102; i++) {
    // A guesser rotating addresses in every header a server might trust.
    const ip = `203.0.113.${i}`;
    const res = await postSignIn(`http://127.0.0.1:3000${SIGN_IN}`, {
      "x-forwarded-for": ip,
      "x-real-ip": ip,
      "cf-connecting-ip": ip,
      "x-hearloom-unset": ip,
    });
    statuses.push(res.status);
  }
  // 100 per 10 s: 60-bit codes can't be guessed at that rate, and nobody else is locked out for long.
  expect(statuses.slice(0, 100).every((s) => s === 401)).toBe(true);
  expect(statuses.slice(100)).toEqual([429, 429]);
  // Open again after the window.
  nextRateLimitWindow();
  expect((await postSignIn(`http://127.0.0.1:3000${SIGN_IN}`, {})).status).toBe(401);
});

test("hasSimpleBody / needsPreflight: bodies any page can send vs ones that need a preflight", () => {
  const simple = (type?: string) =>
    hasSimpleBody(req("http://127.0.0.1:3000/x", type ? { "content-type": type } : {}));
  for (const type of ["text/plain", "TEXT/PLAIN; a=application/json", "multipart/form-data; b=x"]) {
    expect(simple(type)).toBe(true);
  }
  expect(simple("application/x-www-form-urlencoded")).toBe(true);
  for (const type of [undefined, "application/json", "application/jsonx"]) {
    expect(simple(type)).toBe(false);
  }

  const typed = (type?: string) =>
    needsPreflight(req("http://127.0.0.1:3000/x", type ? { "content-type": type } : {}));
  for (const type of ["application/json", "Application/JSON; charset=utf-8", "application/jsonx"]) {
    expect(typed(type)).toBe(true);
  }
  for (const type of [
    undefined,
    "",
    "text/plain",
    "text/plain;charset=UTF-8",
    "TEXT/PLAIN; a=application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
  ]) {
    expect(typed(type)).toBe(false);
  }
});

test("requests any page can send don't count toward the shared limits", async () => {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    { email: `limit-${crypto.randomUUID()}@test.local`, name: "limit", emailVerified: true },
    { method: "admin" },
  );
  try {
    nextRateLimitWindow();
    const url = `http://127.0.0.1:3000${SIGN_IN}`;
    const body = JSON.stringify({ code: generateCode() });
    // What a page elsewhere can send with no-cors, well past the limit: plain-text and form POSTs
    // (refused), POSTs with no body or an untyped one.
    for (let i = 0; i < 30; i++) {
      for (const type of [
        "text/plain;charset=UTF-8",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
        "text/plain",
      ]) {
        const res = await app.fetch(
          new Request(url, { method: "POST", headers: { "content-type": type }, body }),
        );
        expect(res.status).toBe(415);
      }
    }
    expect((await app.fetch(new Request(url, { method: "POST" }))).status).not.toBe(429);
    const untyped = new Request(url, { method: "POST", body: new Blob([body]) });
    expect((await app.fetch(untyped)).status).toBe(415);
    // And image loads of /get-session, well past its 100 per 10 s.
    for (let i = 0; i < 120; i++) {
      await app.fetch(new Request("http://127.0.0.1:3000/api/auth/get-session"));
    }
    const session = await app.fetch(new Request("http://127.0.0.1:3000/api/auth/get-session"));
    expect(session.status).toBe(200);
    // The owner still signs in.
    const { code } = await mintLinkCode(user.id, null);
    const res = await app.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }),
    );
    expect(res.status).toBe(200);
  } finally {
    await ctx.internalAdapter.deleteUser(user.id);
  }
});

test("passwords are off: no password sign-in, sign-up or password changes", async () => {
  for (const path of [
    "/sign-in/email",
    "/sign-up/email",
    "/change-password",
    "/set-password",
    "/verify-password",
    "/request-password-reset",
    "/reset-password",
    "/admin/set-user-password",
  ]) {
    nextRateLimitWindow();
    const res = await app.fetch(
      new Request(`http://127.0.0.1:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@test.local", password: "x".repeat(12) }),
      }),
    );
    expect(res.status).toBe(404);
  }
});

test("no CORS preflight is granted, so a page elsewhere can't send X-Forwarded-* to auth", async () => {
  const res = await app.fetch(
    new Request(`http://mac.tail1234.ts.net${SIGN_IN}`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-forwarded-host,x-forwarded-proto",
      },
    }),
  );
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(res.headers.get("access-control-allow-headers")).toBeNull();
});
