import "../test-db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@hearloom/db";
import { eq } from "drizzle-orm";
import { createToken } from "../agent/tokens";
import { db } from "../db";
import { handleMcp } from "./server";

const userId = `test-${crypto.randomUUID()}`;
let token = "";

beforeAll(async () => {
  await db.insert(schema.user).values({ id: userId, name: "test", email: `${userId}@test.local` });
  token = (await createToken(userId, "Hermes")).token;
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

let nextId = 1;
function rpc(method: string, params: unknown, auth: string | null = `Bearer ${token}`) {
  return handleMcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await rpc("tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolResult; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!;
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

describe("auth", () => {
  test("no, malformed or unknown token: 401", async () => {
    for (const auth of [null, "Basic abc", "Bearer hl_unknownunknownunknownunknown"]) {
      const res = await rpc("tools/list", {}, auth);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  test("a revoked token stops working", async () => {
    const { token: old, row } = await createToken(userId, "Old");
    expect((await rpc("tools/list", {}, `Bearer ${old}`)).status).toBe(200);
    await db
      .update(schema.apiTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiTokens.id, row.id));
    expect((await rpc("tools/list", {}, `Bearer ${old}`)).status).toBe(401);
  });
});

test("every token gets the read and episode-editing tools, and nothing else", async () => {
  const res = await rpc("tools/list", {});
  const { result } = (await res.json()) as { result: { tools: { name: string }[] } };
  expect(result.tools.map((t) => t.name).sort()).toEqual([
    "get_audio_clip_url",
    "get_current_context",
    "get_episode",
    "get_timeline",
    "list_episodes",
    "list_people",
    "list_sound_events",
    "merge_episodes",
    "search_transcripts",
    "split_episode",
    "update_episode",
  ]);
});

describe("input validation", () => {
  test("dates that don't parse are rejected before any query", async () => {
    for (const [name, args] of [
      ["search_transcripts", { query: "hi", from: "yesterday-ish" }],
      ["search_transcripts", { query: "hi", to: "2026-13-45" }],
      ["get_timeline", { from: "not a date" }],
      ["list_episodes", { from: "2026-10-06T09:00:00Z", to: "soon" }],
      ["get_audio_clip_url", { from: "nope", to: "2026-10-06T09:00:00Z" }],
      ["split_episode", { id: crypto.randomUUID(), at: "noon" }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("not a valid date-time");
    }
  });

  test("`to` before `from` is rejected", async () => {
    const from = "2026-10-06T10:00:00Z";
    const to = "2026-10-06T09:00:00Z";
    for (const [name, args] of [
      ["search_transcripts", { query: "hi", from, to }],
      ["get_timeline", { from, to }],
      ["list_sound_events", { from, to }],
      ["get_audio_clip_url", { from, to }],
    ] as const) {
      const r = await call(name, args);
      expect(textOf(r)).toContain("`to` is before `from`");
    }
  });

  test("ranges are capped", async () => {
    const r = await call("get_audio_clip_url", {
      from: "2026-10-06T09:00:00Z",
      to: "2026-10-06T10:30:00Z",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("max 1 hour");
    const t = await call("get_timeline", { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00Z" });
    expect(textOf(t)).toContain("max 7 days");
  });

  test("LIKE wildcards and backslashes in a search are literal", async () => {
    for (const query of ["100%", "a_b", "back\\slash", "\\"]) {
      const r = await call("search_transcripts", { query, speaker: "50%\\" });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe("No matches.");
    }
  });
});

test("valid calls work for a user with no data", async () => {
  expect(textOf(await call("get_timeline", { from: "2026-10-06T09:00:00Z" }))).toBe(
    "Nothing recorded in this range.",
  );
  expect(textOf(await call("list_people", {}))).toBe("No known people yet.");
  expect(textOf(await call("get_current_context", {}))).toContain("Local time:");
});
