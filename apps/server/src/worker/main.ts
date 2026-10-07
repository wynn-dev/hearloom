/**
 * Hearloom worker: background jobs from the Postgres queue (pg-boss).
 *   refine-block — offline diarization + voice ID after a block of speech ends; once a whole
 *   chain of speech is refined, its speaker keys are consolidated.
 * Run alongside the server: `pnpm --filter @hearloom/server worker`.
 */
import { createDb } from "@hearloom/db";
import { hasModel, MODEL_FILES, SpeakerEmbedder } from "@hearloom/inference";
import { env, modelsDir } from "../env";
import { episodesRefinedBy, refinedEpisodesOfChain } from "../episodes/store";
import { publishChange } from "../events";
import {
  enqueueRefine,
  jobs,
  type LegacyRefineJob,
  QUEUES,
  type RefineJob,
  stopJobs,
} from "../jobs";
import { Diarizer } from "./diarizer";
import { finishChain, type RefineDeps, refineBlock } from "./refine";

const { db, client } = createDb(env.DATABASE_URL, { max: 2 });
const diarizer = Diarizer.available(env.DIARIZER_BIN) ? new Diarizer(env.DIARIZER_BIN) : null;

const deps: RefineDeps = {
  db,
  embedder: hasModel(modelsDir, MODEL_FILES.speaker) ? new SpeakerEmbedder(modelsDir) : null,
  diarizer,
  matchThreshold: env.SPEAKER_MATCH_THRESHOLD,
  clusterThreshold: env.SPEAKER_CLUSTER_THRESHOLD,
  log: (m) => console.log(`[worker] ${m}`),
};

console.log(
  `[worker] refine: ${env.REFINE}, diarizer: ${deps.diarizer ? "fluidaudio" : "not built (sidecars/diarizer)"}, speakers: ${deps.embedder ? "on" : "off"}`,
);

async function refine(blockId: string): Promise<void> {
  const started = Date.now();
  const r = await refineBlock(deps, blockId);
  console.log(`[worker] block ${blockId}: ${r.message} (${Date.now() - started} ms)`);
  if (!r.chainId) return;
  const [row] = await client`select user_id from blocks where id = ${blockId}`;
  const userId = row?.user_id as string | undefined;
  if (!userId) return;
  // Also after "already refined": a run that failed after refining must still finish the chain.
  const done = await finishChain(deps, r.chainId);
  if (done.finished) console.log(`[worker] chain ${r.chainId}: ${done.message}`);
  if (!r.refined && !done.finished) return;
  await publishChange(client, userId, ["timeline", "people"]);
  // Episodes whose speech is all refined now.
  const refined = r.refined ? await episodesRefinedBy(db, blockId) : null;
  for (const ep of refined?.episodes ?? []) {
    await publishChange(client, userId, ["timeline"], {
      type: "episode.refined",
      episodeId: ep.id,
      kind: ep.kind,
      again: false,
    });
  }
  // Merging speaker keys across the chain renamed speakers its episodes were refined with.
  if (done.renamed > 0) {
    const chain = await refinedEpisodesOfChain(db, r.chainId);
    for (const ep of chain?.episodes ?? []) {
      if (refined?.episodes.some((x) => x.id === ep.id)) continue;
      await publishChange(client, userId, ["timeline"], {
        type: "episode.refined",
        episodeId: ep.id,
        kind: ep.kind,
        again: true,
      });
    }
  }
}

/**
 * Blocks that should be refined but have no job (the server was down when they closed, or a
 * worker died mid-pass): queue them again. Duplicates are harmless ("already refined").
 */
async function sweep(): Promise<void> {
  const rows = await client`
    update blocks set status = 'closed'
    where status = 'refining' and updated_at < now() - interval '1 hour'
    returning id`;
  const stale = await client`
    select id from blocks
    where status = 'closed' and ended_at > now() - interval '7 days'
      and updated_at < now() - interval '10 minutes'
    order by started_at limit 500`;
  for (const b of [...rows, ...stale]) await enqueueRefine(b.id as string);
  if (rows.length + stale.length > 0)
    console.log(`[worker] queued ${rows.length + stale.length} block(s) left without a refine job`);
}

const boss = await jobs();
if (env.REFINE === "on") {
  await boss.work<RefineJob>(QUEUES.refine, { batchSize: 1 }, async ([job]) => {
    if (job) await refine(job.data.blockId);
  });
  await boss.work<LegacyRefineJob>(QUEUES.refineLegacy, { batchSize: 1 }, async ([job]) => {
    if (job) await refine(job.data.conversationId);
  });
  if (diarizer) await sweep().catch((err) => console.error("[worker] sweep failed", err));
}

async function shutdown() {
  await stopJobs();
  diarizer?.stop();
  await client.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
