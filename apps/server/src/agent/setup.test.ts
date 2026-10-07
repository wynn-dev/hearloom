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

test("agentConfig: PUBLIC_URL without a trailing slash, MCP endpoint under it", () => {
  expect(agentConfig("https://mac.tail1234.ts.net")).toEqual({
    publicUrl: "https://mac.tail1234.ts.net",
    mcpUrl: "https://mac.tail1234.ts.net/mcp",
  });
  expect(agentConfig("https://example.com/hearloom/").mcpUrl).toBe(
    "https://example.com/hearloom/mcp",
  );
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
  expect(config).toEqual(agentConfig(env.PUBLIC_URL));
  expect(config.mcpUrl).toBe(`${env.PUBLIC_URL.replace(/\/+$/, "")}/mcp`);
});

test("agent.config needs a session", async () => {
  const anon = createRouterClient(router, { context: { headers: new Headers() } });
  await expect(anon.agent.config()).rejects.toThrow();
});

test("agent.generateWebhookSecret saves a new secret and returns it once", async () => {
  await updateSettings(userId, { agent: { webhookUrl: "http://127.0.0.1:8644/webhooks/x" } });
  const first = await client.agent.generateWebhookSecret();
  expect(isValidWebhookSecret(first.secret)).toBe(true);
  expect(first.secret.startsWith("whsec_")).toBe(true);
  expect(first.settings.agent.webhookSecret).toBe(first.secret);
  // The URL is left alone.
  expect(first.settings.agent.webhookUrl).toBe("http://127.0.0.1:8644/webhooks/x");
  expect((await getSettings(userId)).agent.webhookSecret).toBe(first.secret);

  const second = await client.agent.generateWebhookSecret();
  expect(second.secret).not.toBe(first.secret);
  expect((await getSettings(userId)).agent.webhookSecret).toBe(second.secret);
});

test("an existing hand-entered secret keeps working", async () => {
  await updateSettings(userId, { agent: { webhookSecret: "a raw secret, not whsec" } });
  expect((await client.settings.get()).agent.webhookSecret).toBe("a raw secret, not whsec");
});
