import { join } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { auth } from "../auth";
import { env } from "../env";
import { handleMcp } from "../mcp/server";
import { router } from "../rpc/router";
import { serveChunk } from "./media";

const rpc = new RPCHandler(router);

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.all("/rpc/*", async (c) => {
  const { matched, response } = await rpc.handle(c.req.raw, {
    prefix: "/rpc",
    context: { headers: c.req.raw.headers },
  });
  return matched ? response : c.notFound();
});

// MCP endpoint for agents (Hermes etc.), authenticated with an agent token (console → Agent).
app.on(["GET", "POST", "DELETE"], "/mcp", (c) => handleMcp(c.req.raw));

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
