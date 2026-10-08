import "./test-db";
import { expect, test } from "bun:test";
import { requestOrigin } from "./auth";
import { env } from "./env";
import { app } from "./http/app";

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

/**
 * A sign-in that better-auth origin-checks (it does so when cookies are sent), with an unknown email:
 * 401 when the origin is trusted, 403 INVALID_ORIGIN when it isn't.
 */
async function signIn(url: string, headers: Record<string, string>) {
  const res = await app.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "unrelated=1", ...headers },
      body: JSON.stringify({
        email: `nobody-${crypto.randomUUID()}@test.local`,
        password: "x".repeat(12),
      }),
    }),
  );
  const body = (await res.json().catch(() => null)) as { code?: string } | null;
  return { status: res.status, code: body?.code };
}

const SIGN_IN = "/api/auth/sign-in/email";

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
