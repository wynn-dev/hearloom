import type { RealtimeEvent } from "@hearloom/api";
import type { ServerWebSocket } from "bun";
import { getSession } from "./auth";
import { sql } from "./db";
import { env } from "./env";
import { relayChanges } from "./events";
import { app } from "./http/app";
import type { IngestSocketData } from "./ingest/phones";
import { dbChunkSink } from "./ingest/sink";
import { flushAllWriters, ingestHandlers, SPOOL_DIR, setFrameListener } from "./ingest/socket";
import { recoverSpool } from "./ingest/stream-writer";
import { enqueueRefine, stopJobs } from "./jobs";
import { livePipeline } from "./live/host";
import { stopNotifications } from "./notify/gateway";
import { attachRealtimeServer, topicFor } from "./realtime";
import { trackSocket, untrackSocket } from "./sessions";
import { shutdownDeadline, stopServer } from "./shutdown";
import { onCue, onDetection, recoverPending } from "./voice/commands";
import { onTeachHeard, replayTeach } from "./voice/teach";

interface RealtimeSocketData {
  kind: "realtime";
  userId: string;
  sessionId: string;
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
              sessionId: session.session.id,
              phoneId: null,
              slots: new Map(),
              queue: Promise.resolve(),
              closed: false,
            }
          : { kind: "realtime", userId: session.user.id, sessionId: session.session.id };
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
      trackSocket(ws.data.sessionId, ws as ServerWebSocket<unknown>);
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
      untrackSocket(ws.data.sessionId, ws as ServerWebSocket<unknown>);
      if (ws.data.kind === "ingest") ingestHandlers.close(ws as ServerWebSocket<IngestSocketData>);
    },
  },
});

attachRealtimeServer(server as never);
livePipeline.start();
setFrameListener((meta, frames) => livePipeline.push(meta, frames));
// "Hey <agent>, …": store what was heard, deliver commands to the agent; teaching samples.
livePipeline.onVoiceCommand((d) => {
  void onDetection(d).catch((err) => console.error("[voice] command failed", err));
});
// The pendant buzzes as soon as the wake phrase is heard, and when nothing came of it.
livePipeline.onVoiceCue((e) => {
  void onCue(e).catch((err) => console.error("[voice] buzz failed", err));
});
// A restarted pipeline forgets teaching prompts: without them, read phrases would be commands.
livePipeline.onReady(replayTeach);
// Deliveries cut off by the last shutdown.
void recoverPending()
  .then(({ retried, expired }) => {
    if (retried + expired > 0)
      console.log(`[voice] after restart: ${retried} command(s) retried, ${expired} expired`);
  })
  .catch((err) => console.error("[voice] recovering pending commands failed", err));
livePipeline.onTeachHeard((userId, result) => {
  void onTeachHeard(userId, result).catch((err) => console.error("[voice] teach failed", err));
});
// Finished blocks get an offline refine pass (worker process).
livePipeline.onBlockClosed((_userId, blockId) => {
  if (env.REFINE === "on")
    void enqueueRefine(blockId).catch((err) => console.error("[jobs] enqueue failed", err));
});
await relayChanges(sql);
console.log(`[hearloom] listening on http://${env.HOST}:${env.PORT} (public: ${env.PUBLIC_URL})`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[hearloom] ${signal}: flushing audio and shutting down`);
  shutdownDeadline(30_000);
  await stopServer(server);
  await flushAllWriters();
  await livePipeline.stop();
  await stopJobs();
  stopNotifications();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
