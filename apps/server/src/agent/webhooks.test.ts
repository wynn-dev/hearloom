import "../test-db";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@hearloom/db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { updateSettings } from "../settings";
import { sendWebhook, webhookSignature } from "./webhooks";

test("signs like Standard Webhooks (spec test vector, whsec_ key)", () => {
  expect(
    webhookSignature(
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1614265330,
      '{"test": 2432232314}',
    ),
  ).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("a secret without whsec_ is used as raw UTF-8 bytes (as Hermes does)", () => {
  // Computed with Hermes's _validate_svix_signature algorithm (Python hmac + base64).
  expect(
    webhookSignature(
      "a raw secret, not whsec",
      "evt_1",
      1791380000,
      '{"id":"evt_1","type":"x","note":"héllo"}',
    ),
  ).toBe("v1,fXwsytrHwwF4fBVgr0ik51YHH1bo5TmEW8XzEh9ffy8=");
});

const userId = `test-${crypto.randomUUID()}`;
const received: Request[] = [];
const bodies: string[] = [];
let status = 202;
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    received.push(req);
    bodies.push(await req.text());
    return new Response("{}", { status });
  },
});

beforeAll(async () => {
  await db.insert(schema.user).values({ id: userId, name: "test", email: `${userId}@test.local` });
});
afterAll(async () => {
  receiver.stop(true);
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

test("without a webhook URL nothing is sent", async () => {
  expect(await sendWebhook(userId, { id: "evt_0", type: "example" })).toEqual({
    ok: false,
    status: 0,
    error: "no webhook configured",
  });
  expect(received).toHaveLength(0);
});

test("posts the event with Standard Webhooks headers the receiver can verify", async () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  await updateSettings(userId, {
    agent: { webhookUrl: `http://127.0.0.1:${receiver.port}/hook`, webhookSecret: secret },
  });
  const result = await sendWebhook(userId, { id: "evt_1", type: "example", text: "hi" });
  expect(result).toEqual({ ok: true, status: 202, error: null });
  const req = received.at(-1)!;
  const body = bodies.at(-1)!;
  expect(req.headers.get("webhook-id")).toBe("evt_1");
  const ts = Number(req.headers.get("webhook-timestamp"));
  expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(5);
  expect(req.headers.get("webhook-signature")).toBe(webhookSignature(secret, "evt_1", ts, body));
  expect(JSON.parse(body)).toMatchObject({ id: "evt_1", type: "example", text: "hi", userId });

  status = 401;
  expect(await sendWebhook(userId, { id: "evt_2", type: "example" })).toMatchObject({
    ok: false,
    status: 401,
  });
});

test("no secret: sent unsigned", async () => {
  status = 202;
  await updateSettings(userId, { agent: { webhookSecret: "" } });
  await sendWebhook(userId, { id: "evt_3", type: "example" });
  expect(received.at(-1)!.headers.get("webhook-signature")).toBeNull();
});
