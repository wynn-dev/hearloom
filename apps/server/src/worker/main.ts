/**
 * Hearloom worker: background jobs from the Postgres queue (pg-boss).
 *   refine-conversation — offline diarization + voice ID after a conversation ends.
 * Run alongside the server: `pnpm --filter @hearloom/server worker`.
 */
import { createDb } from "@hearloom/db";
import { hasModel, MODEL_FILES, SpeakerEmbedder } from "@hearloom/inference";
import { env, modelsDir } from "../env";
import { publishChange } from "../events";
import { jobs, QUEUES, type RefineJob, stopJobs } from "../jobs";
import { Diarizer } from "./diarizer";
import { type RefineDeps, refineConversation } from "./refine";

const { db, client } = createDb(env.DATABASE_URL, { max: 2 });

const deps: RefineDeps = {
  db,
  embedder: hasModel(modelsDir, MODEL_FILES.speaker) ? new SpeakerEmbedder(modelsDir) : null,
  diarizer: Diarizer.available(env.DIARIZER_BIN) ? new Diarizer(env.DIARIZER_BIN) : null,
  matchThreshold: env.SPEAKER_MATCH_THRESHOLD,
  log: (m) => console.log(`[worker] ${m}`),
};

console.log(
  `[worker] refine: ${env.REFINE}, diarizer: ${deps.diarizer ? "fluidaudio" : "not built (sidecars/diarizer)"}, speakers: ${deps.embedder ? "on" : "off"}`,
);

const boss = await jobs();
if (env.REFINE === "on") {
  await boss.work<RefineJob>(QUEUES.refine, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const started = Date.now();
    const result = await refineConversation(deps, job.data.conversationId);
    console.log(`[worker] ${job.data.conversationId}: ${result} (${Date.now() - started} ms)`);
    const [conv] =
      await client`select user_id from conversations where id = ${job.data.conversationId}`;
    if (conv && result.startsWith("refined")) {
      await publishChange(client, conv.user_id as string, ["timeline", "people"], {
        type: "conversation.refined",
        conversationId: job.data.conversationId,
      });
    }
  });
}

async function shutdown() {
  await stopJobs();
  deps.diarizer?.stop();
  await client.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
