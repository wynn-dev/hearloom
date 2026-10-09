import "../test-db";
import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import type { Contract } from "@hearloom/api";
import { schema } from "@hearloom/db";
import type { ContractRouterClient } from "@orpc/contract";
import { createRouterClient } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../db";
import { app } from "../http/app";
import { linkServer, type RpcContext, router } from "../rpc/router";
import { clientKind, describeBrowser } from "../sessions";
import {
  CODE_LENGTH,
  formatCode,
  generateCode,
  linkUrls,
  mintLinkCode,
  normalizeCode,
  sha256Hex,
} from "./codes";

const BASE = "http://127.0.0.1:3000";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const APP_UA = "Hearloom/42 CFNetwork/3860.100.1 Darwin/25.0.0";

const users: string[] = [];
afterEach(() => setSystemTime());
afterAll(async () => {
  if (users.length) await db.delete(schema.user).where(inArray(schema.user.id, users));
});

async function makeUser(role: "admin" | "user" = "user") {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    { email: `link-${crypto.randomUUID()}@test.local`, name: "link", emailVerified: true, role },
    { method: "admin" },
  );
  users.push(user.id);
  return user;
}

/** Redeem a code the way the app and the /link page do: a JSON POST. */
function redeem(code: string, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`${BASE}/api/auth/link/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": APP_UA, ...headers },
      body: JSON.stringify({ code }),
    }),
  );
}

async function sessionFor(headers: Record<string, string>) {
  const res = await app.fetch(new Request(`${BASE}/api/auth/get-session`, { headers }));
  return (await res.json()) as { user: { id: string }; session: { id: string } } | null;
}

/** An RPC client authenticated as a device holding `token` (as the app sends it). */
function rpcAs(token: string): ContractRouterClient<Contract> {
  return createRouterClient(router, {
    context: (): RpcContext => ({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
  }) as unknown as ContractRouterClient<Contract>;
}

/** Sign a device in with a fresh code for `userId`; returns its bearer token. */
async function link(userId: string, userAgent = APP_UA): Promise<string> {
  const { code } = await mintLinkCode(userId, null);
  const res = await redeem(code, { "user-agent": userAgent });
  expect(res.status).toBe(200);
  return res.headers.get("set-auth-token")!;
}

test("codes: 12 symbols of Crockford base32, read back however they're typed", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    expect(normalizeCode(code)).toBe(code);
    expect(normalizeCode(formatCode(code).toLowerCase())).toBe(code);
    seen.add(code);
  }
  expect(seen.size).toBe(200);
  expect(CODE_LENGTH).toBe(12);
  expect(formatCode("ABCD0123WXYZ")).toBe("ABCD-0123-WXYZ");
  // Look-alikes: O is 0, I and L are 1.
  expect(normalizeCode("abcd-o1il-wxyz")).toBe("ABCD0111WXYZ");
  expect(normalizeCode(" ABCD 0123 WXYZ ")).toBe("ABCD0123WXYZ");
  for (const bad of ["", "ABCD-0123-WXY", "ABCD-0123-WXYZ0", "ABCD-0123-WXYU", "ABCD#0123WXYZ"]) {
    expect(normalizeCode(bad)).toBeNull();
  }
});

test("link URLs: the app's carries the server; the browser's keeps the code after #", () => {
  const urls = linkUrls("https://mac.tail1234.ts.net/", "ABCD0123WXYZ");
  expect(urls.server).toBe("https://mac.tail1234.ts.net");
  expect(urls.webUrl).toBe("https://mac.tail1234.ts.net/link#code=ABCD-0123-WXYZ");
  const app = new URL(urls.appUrl);
  expect(app.protocol).toBe("hearloom:");
  expect(app.host).toBe("link");
  expect(app.searchParams.get("server")).toBe("https://mac.tail1234.ts.net");
  expect(app.searchParams.get("code")).toBe("ABCD-0123-WXYZ");
});

test("linkServer: PUBLIC_URL, or the console's address when PUBLIC_URL is loopback", () => {
  expect(linkServer("https://mac.tail1234.ts.net", "http://192.168.1.20:3000")).toBe(
    "https://mac.tail1234.ts.net",
  );
  expect(linkServer("http://localhost:3000", "https://mac.tail1234.ts.net")).toBe(
    "https://mac.tail1234.ts.net",
  );
  expect(linkServer("http://localhost:3000", "http://127.0.0.1:5173")).toBe(
    "http://localhost:3000",
  );
  expect(linkServer("http://localhost:3000", null)).toBe("http://localhost:3000");
});

test("clientKind / describeBrowser", () => {
  expect(clientKind(SAFARI)).toBe("browser");
  expect(clientKind(APP_UA)).toBe("app");
  expect(clientKind(null)).toBe("app");
  expect(describeBrowser(SAFARI)).toBe("Safari on macOS");
  expect(
    describeBrowser(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ),
  ).toBe("Chrome on Windows");
  expect(
    describeBrowser(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    ),
  ).toBe("Safari on iPhone");
});

test("a code signs a device in as the user it was minted for, once", async () => {
  const alice = await makeUser();
  const bob = await makeUser();
  const { code } = await mintLinkCode(bob.id, alice.id);

  const res = await redeem(formatCode(code).toLowerCase());
  expect(res.status).toBe(200);
  expect(((await res.json()) as { user: { id: string } }).user.id).toBe(bob.id);
  // The app gets a bearer token, a browser the cookie.
  const token = res.headers.get("set-auth-token");
  expect(token).toBeTruthy();
  expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=");
  expect((await sessionFor({ authorization: `Bearer ${token}` }))?.user.id).toBe(bob.id);

  // Single use.
  const again = await redeem(code);
  expect(again.status).toBe(401);
  expect(((await again.json()) as { code?: string }).code).toBe("INVALID_LINK_CODE");
  expect(again.headers.get("set-auth-token")).toBeNull();

  // Only the hash is stored.
  const [row] = await db.select().from(schema.linkCodes).where(eq(schema.linkCodes.userId, bob.id));
  expect(row?.codeHash).toBe(sha256Hex(code));
  expect(row?.redeemedAt).toBeInstanceOf(Date);
  expect(row?.sessionId).toBe((await sessionFor({ authorization: `Bearer ${token}` }))!.session.id);
});

test("two devices racing with one code: only one gets in", async () => {
  const user = await makeUser();
  const { code } = await mintLinkCode(user.id, null);
  const statuses = (await Promise.all(Array.from({ length: 5 }, () => redeem(code)))).map(
    (r) => r.status,
  );
  expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  expect(statuses.filter((s) => s === 401)).toHaveLength(4);
});

test("a code expires after 5 minutes", async () => {
  const user = await makeUser();
  const fresh = await mintLinkCode(user.id, null);
  const stale = await mintLinkCode(user.id, null);
  expect(stale.expiresAt.getTime() - Date.now()).toBeGreaterThan(4.9 * 60_000);
  expect(stale.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  setSystemTime(new Date(Date.now() + 4.5 * 60_000));
  expect((await redeem(fresh.code)).status).toBe(200);
  setSystemTime(new Date(Date.now() + 5 * 60_000 + 1000));
  expect((await redeem(stale.code)).status).toBe(401);
});

test("wrong, malformed and missing codes are refused", async () => {
  expect((await redeem(generateCode())).status).toBe(401);
  expect((await redeem("not a code")).status).toBe(401);
  const missing = await app.fetch(
    new Request(`${BASE}/api/auth/link/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(missing.status).toBe(400);
});

test("redeeming needs JSON and the server's own origin, like sign-in", async () => {
  const user = await makeUser();
  const { code } = await mintLinkCode(user.id, null);
  for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
    const res = await app.fetch(
      new Request(`${BASE}/api/auth/link/redeem`, {
        method: "POST",
        headers: { "content-type": type },
        body: JSON.stringify({ code }),
      }),
    );
    expect(res.status).toBe(415);
  }
  // A page elsewhere, in a browser that has cookies for this server.
  const res = await redeem(code, { origin: "https://evil.example", cookie: "unrelated=1" });
  expect(res.status).toBe(403);
  // The code is still good.
  expect((await redeem(code, { origin: BASE, cookie: "unrelated=1" })).status).toBe(200);
});

test("a banned user's code doesn't sign anyone in", async () => {
  const user = await makeUser();
  await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, user.id));
  const { code } = await mintLinkCode(user.id, null);
  const res = await redeem(code);
  expect(res.status).toBe(403);
  expect(res.headers.get("set-auth-token")).toBeNull();
});

test("session tokens are stored hashed; the device's token keeps working", async () => {
  const user = await makeUser();
  const token = await link(user.id);
  const raw = token.split(".")[0]!;
  const [row] = await db.select().from(schema.session).where(eq(schema.session.userId, user.id));
  expect(row?.token).toBe(sha256Hex(raw));
  // The stored hash is no credential.
  expect(await sessionFor({ authorization: `Bearer ${row!.token}` })).toBeNull();
  expect((await sessionFor({ authorization: `Bearer ${raw}` }))?.user.id).toBe(user.id);
});

test("sessions stored before hashing keep working and are hashed when used", async () => {
  const user = await makeUser();
  const raw = "Legacy0123456789abcdefghijklmnop";
  const id = crypto.randomUUID();
  await db.insert(schema.session).values({
    id,
    userId: user.id,
    token: raw,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  expect((await sessionFor({ authorization: `Bearer ${raw}` }))?.user.id).toBe(user.id);
  const [row] = await db.select().from(schema.session).where(eq(schema.session.id, id));
  expect(row?.token).toBe(sha256Hex(raw));
  expect((await sessionFor({ authorization: `Bearer ${raw}` }))?.session.id).toBe(id);
});

test("a session sliding forward keeps the device's own token in the cookie", async () => {
  const user = await makeUser();
  const token = await link(user.id, SAFARI);
  const raw = token.split(".")[0]!;
  // Past updateAge (a day): get-session extends the session and sets the cookie again.
  setSystemTime(new Date(Date.now() + 2 * 86_400_000));
  const res = await app.fetch(
    new Request(`${BASE}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toContain(`better-auth.session_token=${raw}.`);
  expect(cookie).not.toContain(sha256Hex(raw));
  const [row] = await db.select().from(schema.session).where(eq(schema.session.userId, user.id));
  expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 179 * 86_400_000);
  setSystemTime();
  expect((await sessionFor({ authorization: `Bearer ${raw}` }))?.user.id).toBe(user.id);
});

test("signing out deletes the hashed session", async () => {
  const user = await makeUser();
  const token = await link(user.id);
  const res = await app.fetch(
    new Request(`${BASE}/api/auth/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: BASE },
    }),
  );
  expect(res.status).toBe(200);
  expect(await db.select().from(schema.session).where(eq(schema.session.userId, user.id))).toEqual(
    [],
  );
});

test("token-taking session endpoints are off (they'd see hashes)", async () => {
  const user = await makeUser();
  const token = await link(user.id, SAFARI);
  for (const path of ["/list-sessions", "/revoke-session", "/revoke-other-sessions"]) {
    const res = await app.fetch(
      new Request(`${BASE}/api/auth${path}`, {
        method: path === "/list-sessions" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          origin: BASE,
        },
        body: path === "/list-sessions" ? undefined : JSON.stringify({ token: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  }
});

test("only a browser session can mint codes; an admin can mint for someone else", async () => {
  const admin = await makeUser("admin");
  const member = await makeUser();
  const adminBrowser = rpcAs(await link(admin.id, SAFARI));
  const adminPhone = rpcAs(await link(admin.id, APP_UA));
  const memberBrowser = rpcAs(await link(member.id, SAFARI));

  await expect(adminPhone.sessions.createLink({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(memberBrowser.sessions.createLink({ userId: admin.id })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });

  const own = await memberBrowser.sessions.createLink({});
  expect(own.email).toBe(member.email);
  expect(own.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(own.webUrl).toEndWith(`/link#code=${own.code}`);

  const forMember = await adminBrowser.sessions.createLink({ userId: member.id });
  expect(forMember.email).toBe(member.email);
  const res = await redeem(forMember.code);
  expect(((await res.json()) as { user: { id: string } }).user.id).toBe(member.id);
  // The admin sees it was used, not the member's device.
  expect(await adminBrowser.sessions.linkStatus({ id: forMember.id })).toEqual({
    status: "redeemed",
    device: null,
  });
  await expect(adminBrowser.sessions.createLink({ userId: "nobody" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("linkStatus: pending, then the device that used it; only for its minter", async () => {
  const user = await makeUser();
  const other = await makeUser();
  const browser = rpcAs(await link(user.id, SAFARI));
  const minted = await browser.sessions.createLink({});
  expect(await browser.sessions.linkStatus({ id: minted.id })).toEqual({
    status: "pending",
    device: null,
  });
  await expect(
    rpcAs(await link(other.id, SAFARI)).sessions.linkStatus({ id: minted.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await redeem(minted.code)).status).toBe(200);
  const status = await browser.sessions.linkStatus({ id: minted.id });
  expect(status.status).toBe("redeemed");
  expect(status.device).toMatchObject({ kind: "app", current: false });
  setSystemTime(new Date(Date.now() + 6 * 60_000));
  const late = await browser.sessions.createLink({});
  setSystemTime(new Date(Date.now() + 12 * 60_000));
  expect((await browser.sessions.linkStatus({ id: late.id })).status).toBe("expired");
});

test("Devices lists every session; revoking one signs that device out for good", async () => {
  const user = await makeUser();
  const browserToken = await link(user.id, SAFARI);
  const phoneToken = await link(user.id, APP_UA);
  const browser = rpcAs(browserToken);
  const phone = rpcAs(phoneToken);
  const { phoneId } = await phone.phones.register({ name: "Wynn's iPhone", model: "iPhone 17" });

  const list = await browser.sessions.list();
  expect(list).toHaveLength(2);
  expect(list.find((s) => s.current)).toMatchObject({ kind: "browser", name: "Safari on macOS" });
  const phoneSession = list.find((s) => !s.current)!;
  expect(phoneSession).toMatchObject({
    kind: "app",
    name: "Wynn's iPhone",
    detail: "iPhone 17",
    phoneId,
  });

  await browser.sessions.revoke({ id: phoneSession.id });
  expect(await sessionFor({ authorization: `Bearer ${phoneToken}` })).toBeNull();
  await expect(phone.phones.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(await browser.sessions.list()).toHaveLength(1);
  // Someone else's session can't be revoked.
  const stranger = rpcAs(await link((await makeUser()).id, SAFARI));
  await expect(stranger.sessions.revoke({ id: list[0]!.id })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect((await sessionFor({ authorization: `Bearer ${browserToken}` }))?.user.id).toBe(user.id);
});

test("removing a phone in the console ends its app's session", async () => {
  const user = await makeUser();
  const browser = rpcAs(await link(user.id, SAFARI));
  const phoneToken = await link(user.id, APP_UA);
  const { phoneId } = await rpcAs(phoneToken).phones.register({ name: "iPhone" });
  await db
    .update(schema.phones)
    .set({ apnsToken: "ab".repeat(32) })
    .where(eq(schema.phones.id, phoneId));

  await browser.phones.remove({ id: phoneId });
  expect(await sessionFor({ authorization: `Bearer ${phoneToken}` })).toBeNull();
  expect(await db.select().from(schema.phones).where(eq(schema.phones.id, phoneId))).toEqual([]);
});

test("a phone signing in again retires its previous sign-in", async () => {
  const user = await makeUser();
  const first = await link(user.id, APP_UA);
  const { phoneId } = await rpcAs(first).phones.register({ name: "iPhone" });
  const second = await link(user.id, APP_UA);
  await rpcAs(second).phones.register({ id: phoneId, name: "iPhone" });
  expect(await sessionFor({ authorization: `Bearer ${first}` })).toBeNull();
  expect((await sessionFor({ authorization: `Bearer ${second}` }))?.user.id).toBe(user.id);
  const [phone] = await db.select().from(schema.phones).where(eq(schema.phones.id, phoneId));
  expect(phone?.sessionId).toBe(
    (await sessionFor({ authorization: `Bearer ${second}` }))!.session.id,
  );
});

test("deleting a user removes their codes", async () => {
  const user = await makeUser();
  await mintLinkCode(user.id, null);
  await db.delete(schema.user).where(eq(schema.user.id, user.id));
  expect(
    await db.select().from(schema.linkCodes).where(eq(schema.linkCodes.userId, user.id)),
  ).toEqual([]);
});

/** An auth API call as a device holding `token`. */
function authCall(path: string, token: string, body: unknown, userAgent = APP_UA) {
  return app.fetch(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": userAgent,
        origin: BASE,
      },
      body: JSON.stringify(body),
    }),
  );
}

test("an admin's phone token can't use admin endpoints or sign every device out", async () => {
  const admin = await makeUser("admin");
  const member = await makeUser();
  const phoneToken = await link(admin.id, APP_UA);
  const browserToken = await link(admin.id, SAFARI);
  for (const [path, body] of [
    ["/admin/set-role", { userId: admin.id, role: "admin" }],
    ["/admin/impersonate-user", { userId: member.id }],
    ["/admin/ban-user", { userId: member.id }],
    ["/revoke-sessions", {}],
  ] as const) {
    // Even claiming to be a browser now: what counts is what signed in.
    expect((await authCall(path, phoneToken, body, SAFARI)).status).toBe(403);
  }
  expect((await sessionFor({ authorization: `Bearer ${browserToken}` }))?.user.id).toBe(admin.id);
  // The console can.
  const res = await authCall(
    "/admin/set-role",
    browserToken,
    { userId: member.id, role: "admin" },
    SAFARI,
  );
  expect(res.status).toBe(200);
});

test("a phone's token can sign itself out, not other devices", async () => {
  const user = await makeUser();
  const browserToken = await link(user.id, SAFARI);
  const phoneToken = await link(user.id, APP_UA);
  const otherPhoneToken = await link(user.id, APP_UA);
  const phone = rpcAs(phoneToken);
  const { phoneId: otherPhoneId } = await rpcAs(otherPhoneToken).phones.register({ name: "B" });
  const sessions = await rpcAs(browserToken).sessions.list();
  const browserSession = sessions.find((s) => s.kind === "browser")!;
  await expect(phone.sessions.revoke({ id: browserSession.id })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(phone.phones.remove({ id: otherPhoneId })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect((await sessionFor({ authorization: `Bearer ${browserToken}` }))?.user.id).toBe(user.id);
  expect((await sessionFor({ authorization: `Bearer ${otherPhoneToken}` }))?.user.id).toBe(user.id);
  const own = (await phone.sessions.list()).find((s) => s.current)!;
  await phone.sessions.revoke({ id: own.id });
  expect(await sessionFor({ authorization: `Bearer ${phoneToken}` })).toBeNull();
});

test("a register still in flight from the replaced sign-in leaves the phone with the new one", async () => {
  const user = await makeUser();
  const first = await link(user.id, APP_UA);
  const { phoneId } = await rpcAs(first).phones.register({ name: "iPhone" });
  await db
    .update(schema.phones)
    .set({ apnsToken: "cd".repeat(32) })
    .where(eq(schema.phones.id, phoneId));
  // Signed in again a moment later; the old sign-in's register lands after the new one's.
  setSystemTime(new Date(Date.now() + 1000));
  const second = await link(user.id, APP_UA);
  setSystemTime();
  const stale = rpcAs(first);
  await rpcAs(second).phones.register({ id: phoneId, name: "iPhone" });
  // The old session is gone, so a stale call can't even authenticate…
  await expect(stale.phones.register({ id: phoneId, name: "iPhone" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect((await sessionFor({ authorization: `Bearer ${second}` }))?.user.id).toBe(user.id);
  const [phone] = await db.select().from(schema.phones).where(eq(schema.phones.id, phoneId));
  // …and the phone kept its push token across the re-sign-in.
  expect(phone?.apnsToken).toBe("cd".repeat(32));
  expect(phone?.sessionId).toBe(
    (await sessionFor({ authorization: `Bearer ${second}` }))!.session.id,
  );
});

test("a register that passed auth before a newer sign-in registered is a no-op", async () => {
  const user = await makeUser();
  const first = await link(user.id, APP_UA);
  const { phoneId } = await rpcAs(first).phones.register({ name: "iPhone" });
  setSystemTime(new Date(Date.now() + 1000));
  const second = await link(user.id, APP_UA);
  setSystemTime();
  const secondId = (await sessionFor({ authorization: `Bearer ${second}` }))!.session.id;
  // The newer session has registered, but the older one still exists (its handler raced ahead of
  // the revoke): simulate by pointing the phone at the newer session directly.
  await db.update(schema.phones).set({ sessionId: secondId }).where(eq(schema.phones.id, phoneId));
  expect(await rpcAs(first).phones.register({ id: phoneId, name: "iPhone" })).toEqual({ phoneId });
  expect((await sessionFor({ authorization: `Bearer ${second}` }))?.user.id).toBe(user.id);
  const [phone] = await db.select().from(schema.phones).where(eq(schema.phones.id, phoneId));
  expect(phone?.sessionId).toBe(secondId);
});

test("however a session ends, its phone stops getting pushes", async () => {
  const admin = await makeUser("admin");
  const member = await makeUser();
  const adminBrowser = await link(admin.id, SAFARI);
  const memberPhone = await link(member.id, APP_UA);
  const { phoneId } = await rpcAs(memberPhone).phones.register({ name: "iPhone" });
  await db
    .update(schema.phones)
    .set({ apnsToken: "ef".repeat(32) })
    .where(eq(schema.phones.id, phoneId));
  expect(
    (await authCall("/admin/ban-user", adminBrowser, { userId: member.id }, SAFARI)).status,
  ).toBe(200);
  expect(await sessionFor({ authorization: `Bearer ${memberPhone}` })).toBeNull();
  const [phone] = await db.select().from(schema.phones).where(eq(schema.phones.id, phoneId));
  expect(phone?.apnsToken).toBeNull();
});

test("an expired ban doesn't stop an admin linking that user", async () => {
  const admin = await makeUser("admin");
  const member = await makeUser();
  await db
    .update(schema.user)
    .set({ banned: true, banExpires: new Date(Date.now() - 60_000) })
    .where(eq(schema.user.id, member.id));
  const minted = await rpcAs(await link(admin.id, SAFARI)).sessions.createLink({
    userId: member.id,
  });
  expect((await redeem(minted.code)).status).toBe(200);
});
