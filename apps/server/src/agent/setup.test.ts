import "../test-db";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Contract } from "@hearloom/api";
import { schema } from "@hearloom/db";
import { isValidWebhookSecret, settingsPatchSchema } from "@hearloom/shared";
import type { ContractRouterClient } from "@orpc/contract";
import { createRouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { app } from "../http/app";
import { agentConfig, type RpcContext, router } from "../rpc/router";
import { getSettings, updateSettings } from "../settings";
import { generateWebhookSecret, webhookSignature } from "./webhooks";

test("generated webhook secrets: whsec_ + base64 of 32 random bytes, accepted on save", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const key = secret.slice("whsec_".length);
    const bytes = Buffer.from(key, "base64");
    expect(bytes.length).toBe(32);
    // Round-trips, so it is canonical base64 (what Hermes's base64 decode accepts).
    expect(bytes.toString("base64")).toBe(key);
    expect(isValidWebhookSecret(secret)).toBe(true);
    expect(settingsPatchSchema.safeParse({ agent: { webhookSecret: secret } }).success).toBe(true);
    // Signs with the decoded key, like any whsec_ secret.
    expect(webhookSignature(secret, "evt", 1, "{}")).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/);
    seen.add(secret);
  }
  expect(seen.size).toBe(50);
});

test("agentConfig: PUBLIC_URL without a trailing slash, MCP endpoint under it and on loopback", () => {
  expect(agentConfig("https://mac.tail1234.ts.net", 3000)).toEqual({
    publicUrl: "https://mac.tail1234.ts.net",
    mcpUrl: "https://mac.tail1234.ts.net/mcp",
    localMcpUrl: "http://127.0.0.1:3000/mcp",
  });
  expect(agentConfig("https://example.com/hearloom/", 3000).mcpUrl).toBe(
    "https://example.com/hearloom/mcp",
  );
  expect(agentConfig("https://example.com", 8080).localMcpUrl).toBe("http://127.0.0.1:8080/mcp");
});

const userId = `test-${crypto.randomUUID()}`;
const sessionToken = `test-session-${crypto.randomUUID()}`;
let client: ContractRouterClient<Contract>;

beforeAll(async () => {
  await db.insert(schema.user).values({ id: userId, name: "test", email: `${userId}@test.local` });
  await db.insert(schema.session).values({
    id: crypto.randomUUID(),
    userId,
    token: sessionToken,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  client = createRouterClient(router, {
    context: (): RpcContext => ({
      headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
    }),
  }) as unknown as ContractRouterClient<Contract>;
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

test("agent.config exposes the server's PUBLIC_URL (not the console's origin)", async () => {
  const config = await client.agent.config();
  expect(config).toEqual(agentConfig(env.PUBLIC_URL, env.PORT));
  expect(config.mcpUrl).toBe(`${env.PUBLIC_URL.replace(/\/+$/, "")}/mcp`);
  expect(config.localMcpUrl).toBe(`http://127.0.0.1:${env.PORT}/mcp`);
});

test("agent.config needs a session", async () => {
  const anon = createRouterClient(router, { context: { headers: new Headers() } });
  await expect(anon.agent.config()).rejects.toThrow();
});

/** Every response that carries settings, as the console and the phone would see them. */
async function settingsResponses() {
  return {
    get: await client.settings.get(),
    me: (await client.me.get()).settings,
    update: await client.settings.update({ timezone: "Europe/Amsterdam" }),
    // Over HTTP, through the RPC handler, as raw text.
    wire: await (
      await app.request("/rpc/settings/get", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: "{}",
      })
    ).text(),
  };
}

function expectNoSecret(r: Awaited<ReturnType<typeof settingsResponses>>, secret: string) {
  for (const [name, value] of Object.entries(r)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    expect({ name, leaks: text.includes(secret) }).toEqual({ name, leaks: false });
    expect({ name, field: text.includes('"webhookSecret"') }).toEqual({ name, field: false });
  }
}

test("settings responses never contain the webhook secret, only whether one is set", async () => {
  await updateSettings(userId, { agent: { webhookUrl: "", webhookSecret: "" } });
  let r = await settingsResponses();
  expect(r.get.agent).toEqual({ webhookUrl: "", webhookSecretSet: false, webhookSecretHint: null });
  expect(r.wire).toContain('"webhookSecretSet":false');

  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  await updateSettings(userId, { agent: { webhookSecret: secret } });
  r = await settingsResponses();
  expectNoSecret(r, secret);
  for (const s of [r.get, r.me, r.update]) {
    expect(s.agent).toEqual({ webhookUrl: "", webhookSecretSet: true, webhookSecretHint: "LaSw" });
  }
  expect(r.wire).toContain('"webhookSecretSet":true');
});

test("a short secret gets no hint (4 characters would give too much away)", async () => {
  await updateSettings(userId, { agent: { webhookSecret: "s3cret" } });
  const s = await client.settings.get();
  expect(s.agent.webhookSecretSet).toBe(true);
  expect(s.agent.webhookSecretHint).toBeNull();
  expectNoSecret(await settingsResponses(), "s3cret");
});

test("a secret saved through settings.update is stored and used, but not returned", async () => {
  const own = "my own hand-entered secret, not whsec";
  const res = await client.settings.update({ agent: { webhookSecret: own } });
  expect(JSON.stringify(res)).not.toContain(own);
  expect(res.agent.webhookSecretSet).toBe(true);
  // The server keeps the full secret for signing.
  expect((await getSettings(userId)).agent.webhookSecret).toBe(own);
  expectNoSecret(await settingsResponses(), own);
  // A whsec_ secret that isn't base64 is still refused.
  await expect(
    client.settings.update({ agent: { webhookSecret: "whsec_not base64!" } }),
  ).rejects.toThrow();
  expect((await getSettings(userId)).agent.webhookSecret).toBe(own);
  // Saving something else leaves the secret alone.
  await client.settings.update({ agent: { webhookUrl: "http://127.0.0.1:8644/webhooks/x" } });
  expect((await getSettings(userId)).agent.webhookSecret).toBe(own);
});

test("agent.generateWebhookSecret saves a new secret and returns it once", async () => {
  await updateSettings(userId, { agent: { webhookUrl: "http://127.0.0.1:8644/webhooks/x" } });
  const first = await client.agent.generateWebhookSecret();
  expect(isValidWebhookSecret(first.secret)).toBe(true);
  expect(first.secret.startsWith("whsec_")).toBe(true);
  expect(first.secret.endsWith("=")).toBe(true);
  // The settings in the same response are redacted like any other.
  expect(first.settings.agent).toEqual({
    webhookUrl: "http://127.0.0.1:8644/webhooks/x",
    webhookSecretSet: true,
    // Generated secrets end in "=" padding; the hint is the 4 characters before it.
    webhookSecretHint: first.secret.slice(-5, -1),
  });
  expect(JSON.stringify(first.settings)).not.toContain(first.secret);
  expect((await getSettings(userId)).agent.webhookSecret).toBe(first.secret);
  // Once: nothing returns it afterwards.
  expectNoSecret(await settingsResponses(), first.secret);

  const second = await client.agent.generateWebhookSecret();
  expect(second.secret).not.toBe(first.secret);
  expect((await getSettings(userId)).agent.webhookSecret).toBe(second.secret);
  expectNoSecret(await settingsResponses(), second.secret);
});

test("an existing hand-entered secret keeps working (stored, used for signing)", async () => {
  await updateSettings(userId, { agent: { webhookSecret: "a raw secret, not whsec" } });
  expect((await getSettings(userId)).agent.webhookSecret).toBe("a raw secret, not whsec");
  expect((await client.settings.get()).agent.webhookSecretSet).toBe(true);
});
