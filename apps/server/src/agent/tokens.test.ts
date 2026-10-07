import "../test-db";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@hearloom/db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { createToken, generateToken, verifyToken } from "./tokens";

const userId = `test-${crypto.randomUUID()}`;

beforeAll(async () => {
  await db.insert(schema.user).values({ id: userId, name: "test", email: `${userId}@test.local` });
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

test("tokens are hl_ plus 256 random bits", () => {
  const a = generateToken();
  expect(a).toMatch(/^hl_[A-Za-z0-9_-]{43}$/);
  expect(generateToken()).not.toBe(a);
});

test("only a hash and a prefix are stored; the token resolves to its user", async () => {
  const { token, row } = await createToken(userId, "Hermes");
  expect(row.prefix).toBe(token.slice(0, 10));
  expect(row.tokenHash).not.toContain(token.slice(3));
  expect(await verifyToken(`Bearer ${token}`)).toEqual({ userId, id: row.id });
  expect(await verifyToken(`bearer  ${token}`)).toEqual({ userId, id: row.id });
});

test("missing, malformed, unknown and revoked tokens are refused", async () => {
  const { token, row } = await createToken(userId, "Old");
  expect(await verifyToken(null)).toBeNull();
  expect(await verifyToken(token)).toBeNull();
  expect(await verifyToken("Bearer hl_short")).toBeNull();
  expect(await verifyToken(`Bearer ${generateToken()}`)).toBeNull();
  await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiTokens.id, row.id));
  expect(await verifyToken(`Bearer ${token}`)).toBeNull();
});
