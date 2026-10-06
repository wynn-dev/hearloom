import type { RealtimeEvent } from "@hearloom/api";
import type { ServerWebSocket } from "bun";
import { getSession } from "./auth";
import { sql } from "./db";
import { env } from "./env";
import { app } from "./http/app";
import type { IngestSocketData } from "./ingest/phones";
import { dbChunkSink } from "./ingest/sink";
import { flushAllWriters, ingestHandlers, SPOOL_DIR, setFrameListener } from "./ingest/socket";
import { recoverSpool } from "./ingest/stream-writer";
import { livePipeline } from "./live/host";
import { startNotificationScheduler, stopNotifications } from "./notify/gateway";
import { attachRealtimeServer, topicFor } from "./realtime";

interface RealtimeSocketData {
  kind: "realtime";
  userId: string;
}
type SocketData = IngestSocketData | RealtimeSocketData;

const recovered = await recoverSpool(SPOOL_DIR, dbChunkSink);
if (recovered.size > 0)
  console.log(`[ingest] recovered spooled audio for ${recovered.size} stream(s)`);

const server = Bun.serve<SocketData>({
  hostname: env.HOST,
  port: env.PORT,
  idleTimeout: 60,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ingest" || url.pathname === "/realtime") {
      const session = await getSession(req.headers);
      if (!session) return new Response("unauthorized", { status: 401 });
      const data: SocketData =
        url.pathname === "/ingest"
          ? {
              kind: "ingest",
              userId: session.user.id,
              phoneId: null,
              slots: new Map(),
              queue: Promise.resolve(),
              closed: false,
            }
          : { kind: "realtime", userId: session.user.id };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    perMessageDeflate: false,
    maxPayloadLength: 4 * 1024 * 1024,
    idleTimeout: 120,
    sendPings: true,
    open(ws) {
      if (ws.data.kind === "ingest")
        return ingestHandlers.open(ws as ServerWebSocket<IngestSocketData>);
      ws.subscribe(topicFor(ws.data.userId));
      const hello: RealtimeEvent = { t: "hello", serverTime: Date.now() };
      ws.send(JSON.stringify(hello));
    },
    message(ws, message) {
      if (ws.data.kind === "ingest") {
        ingestHandlers.message(ws as ServerWebSocket<IngestSocketData>, message);
      }
    },
    close(ws) {
      if (ws.data.kind === "ingest") ingestHandlers.close(ws as ServerWebSocket<IngestSocketData>);
    },
  },
});

attachRealtimeServer(server as never);
startNotificationScheduler();
livePipeline.start();
setFrameListener((meta, frames) => livePipeline.push(meta, frames));
console.log(`[hearloom] listening on http://${env.HOST}:${env.PORT} (public: ${env.PUBLIC_URL})`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[hearloom] ${signal}: flushing audio and shutting down`);
  await server.stop();
  await flushAllWriters();
  await livePipeline.stop();
  stopNotifications();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
