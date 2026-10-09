import { join } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { z } from "zod";
import { verifyToken } from "../agent/tokens";
import { auth, hasSimpleBody, trustedOwnOrigin } from "../auth";
import { env } from "../env";
import { handleMcp } from "../mcp/server";
import { router } from "../rpc/router";
import { commandReplied, commandStarted } from "../voice/commands";
import { serveChunk } from "./media";

const rpc = new RPCHandler(router);

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  // Plain-text and form posts are what any web page can send here unasked; refusing them up front keeps
  // them out of auth's shared rate limits (auth.ts).
  if (c.req.method === "POST" && hasSimpleBody(c.req.raw)) {
    return c.json({ message: "Send JSON", code: "UNSUPPORTED_MEDIA_TYPE" }, 415);
  }
  // An app or console from before passwords were turned off: say why, instead of a bare 404.
  if (c.req.path.replace(/\/+$/, "") === "/api/auth/sign-in/email") {
    return c.json(
      {
        message: "Passwords are off: sign in with a Link device code (Devices → Link a device).",
        code: "PASSWORDS_OFF",
      },
      404,
    );
  }
  return auth.handler(c.req.raw);
});

app.all("/rpc/*", async (c) => {
  const { matched, response } = await rpc.handle(c.req.raw, {
    prefix: "/rpc",
    context: { headers: c.req.raw.headers, origin: trustedOwnOrigin(c.req.raw) },
  });
  return matched ? response : c.notFound();
});

// MCP endpoint for agents (Hermes etc.), authenticated with an agent token (console → Agent).
app.on(["GET", "POST", "DELETE"], "/mcp", (c) => handleMcp(c.req.raw));

// The agent's run on a voice command ended (Hermes hook, hermes/hooks/): `{"outcome": "answered"}`
// (the default: hooks from before outcomes send `{}`) or `"failed"`, the pendant's two taps or
// three. Authenticated with an agent token, like /mcp.
const replyBody = z.object({
  outcome: z.enum(["answered", "failed"]).default("answered"),
  // Only logged: cut, never refused (the hook doesn't retry a 400).
  reason: z
    .string()
    .nullish()
    .transform((r) => r?.slice(0, 200) ?? null),
});
app.post("/api/voice/commands/:id/replied", async (c) => {
  const token = await verifyToken(c.req.header("authorization") ?? null);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const body = replyBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "bad request" }, 400);
  const { outcome, reason } = body.data;
  const status = await commandReplied(token.userId, c.req.param("id"), outcome, reason);
  return c.json({ status }, status === "not_found" ? 404 : 200);
});

// The agent's run on a voice command started (Hermes hook, `agent:start`): its answer may take longer.
app.post("/api/voice/commands/:id/started", async (c) => {
  const token = await verifyToken(c.req.header("authorization") ?? null);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const status = await commandStarted(token.userId, c.req.param("id"));
  return c.json({ status }, status === "not_found" ? 404 : 200);
});

app.get("/media/chunks/:file", (c) => {
  const id = c.req.param("file").replace(/\.ogg$/, "");
  return serveChunk(c.req.raw, id);
});

// Built web console (production). In development Vite serves it and proxies here.
app.get("*", async (c) => {
  const path = c.req.path === "/" ? "/index.html" : c.req.path;
  if (path.includes("..")) return c.notFound();
  const file = Bun.file(join(env.WEB_DIST, path));
  if (await file.exists()) {
    // Vite emits content-hashed files under /assets: cache them forever.
    const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(file, { headers: { "cache-control": cache } });
  }
  // A missing asset (a tab still on the previous build asking for an old chunk) or API path is a 404,
  // not the console's HTML with a 200, which a script import or an API client would choke on.
  if (path.startsWith("/assets/") || path.startsWith("/api/")) return c.notFound();
  const index = Bun.file(join(env.WEB_DIST, "index.html"));
  if (await index.exists())
    return new Response(index, { headers: { "content-type": "text/html" } });
  return c.text(
    "Hearloom server is running. Build the web console with `pnpm --filter @hearloom/web build`.",
  );
});
