/**
 * Live pipeline worker process (spawned by the server, see host.ts). Holds the native models
 * (sherpa-onnx) so a crash here can't take down audio ingest. Receives stored Opus frames over IPC,
 * writes utterances / sound events / blocks / episodes to Postgres, and reports state back.
 */
import { createDb } from "@hearloom/db";
import {
  hasModel,
  MODEL_FILES,
  SoundTagger,
  SPEAKER_MODEL_ID,
  SpeakerEmbedder,
} from "@hearloom/inference";
import type { AudioFrame } from "@hearloom/shared";
import { loadStreamAudio } from "../audio/load";
import { env, modelsDir } from "../env";
import { BlockTracker } from "./blocks";
import { type EnrollResult, enrollUtterance } from "./enroll";
import { EpisodeTracker } from "./episodes";
import type { ChildMessage, HostMessage } from "./ipc";
import { type LiveDeps, type StreamInfo, StreamProcessor } from "./processor";
import { SpeakerDirectory } from "./speakers";
import { VoiceRuntime } from "./voice/runtime";

const send = (msg: ChildMessage) => process.send?.(msg);
const log = (message: string) => send({ t: "log", message });
const fail = (err: unknown) => log(`episodes: ${err}`);

/** Can't run with this configuration: exit code 2 tells the host not to restart us. */
function fatal(message: string): never {
  console.error(`[live] ${message}`);
  process.exit(2);
}

if (!hasModel(modelsDir, MODEL_FILES.vad))
  fatal(`models missing in ${modelsDir}; run: pnpm --filter @hearloom/server download-models`);
if (env.LIVE_ASR === "soniox" && !env.SONIOX_API_KEY)
  fatal("SONIOX_API_KEY is not set (set it, or LIVE_ASR=off to run without transcription)");

const { db, client } = createDb(env.DATABASE_URL, { max: 3 });

const embedder = hasModel(modelsDir, MODEL_FILES.speaker) ? new SpeakerEmbedder(modelsDir) : null;
const speakers = embedder
  ? new SpeakerDirectory(db, SPEAKER_MODEL_ID, env.SPEAKER_MATCH_THRESHOLD)
  : null;
const episodes = new EpisodeTracker(
  db,
  {
    activity: (userId, activity) => send({ t: "activity", userId, activity }),
    changed: (userId) => send({ t: "invalidate", userId, keys: ["timeline"] }),
  },
  async (userId) => (await speakers?.hasSelf(userId)) ?? false,
);
const sonioxConfig =
  env.LIVE_ASR === "soniox" && env.SONIOX_API_KEY
    ? {
        apiKey: env.SONIOX_API_KEY,
        model: env.SONIOX_MODEL,
        asyncModel: env.SONIOX_ASYNC_MODEL,
        languageHints: env.LANGUAGE_HINTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }
    : null;
const voice = new VoiceRuntime({ db, embedder, speakers, soniox: sonioxConfig, send, log });
const deps: LiveDeps = {
  db,
  modelsDir,
  tagger: hasModel(modelsDir, MODEL_FILES.tagger) ? new SoundTagger(modelsDir) : null,
  embedder,
  speakers,
  episodes,
  blocks: new BlockTracker(
    db,
    {
      chainStarted: (userId, chainId, at) =>
        void episodes.chainStarted(userId, chainId, at).catch(fail),
      chainEnded: (userId, chainId, live, endAt, startAt) => {
        const done = live
          ? episodes.chainEnded(userId, chainId, startAt, endAt)
          : episodes.segmentChain(userId, chainId);
        void done.catch(fail);
        send({ t: "invalidate", userId, keys: ["timeline"] });
      },
      blockClosed: (userId, blockId) => send({ t: "block_closed", userId, blockId }),
    },
    env.SPEAKER_CLUSTER_THRESHOLD,
  ),
  soniox: sonioxConfig,
  voice: voice.detector,
  terms: (userId) => voice.terms(userId),
  ownerBar: async (userId) => (await voice.config(userId)).minScore,
  invalidate: (userId, keys) => send({ t: "invalidate", userId, keys }),
  asrHealth: (userId, ok, message) => send({ t: "asr_health", userId, ok, message }),
  log,
};

// A previous child may have died with episodes and chains open; close them before taking new
// audio (closed chains are segmented into episodes again).
await episodes.closeOrphans();
const orphans = await deps.blocks.closeOrphans();
if (orphans > 0) log(`closed ${orphans} chain(s) of speech left open by a previous run`);

log(
  `ready: asr=${env.LIVE_ASR}, tagger=${deps.tagger ? "ced-base" : "off"}, speakers=${embedder ? SPEAKER_MODEL_ID : "off"}`,
);

const processors = new Map<string, StreamProcessor>();

function processorFor(info: StreamInfo): StreamProcessor {
  let p = processors.get(info.id);
  if (!p) {
    p = new StreamProcessor(info, deps);
    processors.set(info.id, p);
  }
  return p;
}

process.on("message", (raw) => {
  const msg = raw as HostMessage;
  if (voice.handle(msg)) return;
  if (msg.t === "frames") {
    void processorFor(msg.stream).push(msg.frames as AudioFrame[], msg.receivedAt);
  } else if (msg.t === "voiceprints_changed") {
    deps.speakers?.invalidate(msg.userId);
  } else if (msg.t === "episodes_changed") {
    void episodes.reload(msg.userId).catch(fail);
  } else if (msg.t === "enroll") {
    void enroll(msg).then(
      ({ sampleSeconds, note }) =>
        send({ t: "enrolled", requestId: msg.requestId, ok: true, sampleSeconds, note }),
      (err) =>
        send({
          t: "enrolled",
          requestId: msg.requestId,
          ok: false,
          error: String(err?.message ?? err),
        }),
    );
  }
});

/** Learn a voiceprint from an utterance's stored audio and attribute the utterance. */
async function enroll(msg: Extract<HostMessage, { t: "enroll" }>): Promise<EnrollResult> {
  const model = embedder;
  if (!model) throw new Error("speaker model not installed");
  const result = await enrollUtterance(
    {
      db,
      embed: (audio) => model.embed(audio),
      loadAudio: (streamId, from, to) => loadStreamAudio(db, streamId, from, to),
      minScore: async (userId) => (await voice.config(userId)).minScore,
    },
    msg,
  );
  deps.speakers?.invalidate(msg.userId);
  return result;
}

// Close runs after silence, idle Soniox sessions, quiet chains and blocks; classify episodes; drop
// idle processors.
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of processors) {
    void p.tick(now);
    if (now - p.lastActivity > 10 * 60_000) {
      processors.delete(id);
      voice.detector.dropSource(id);
      void p.dispose();
    }
  }
  void deps.blocks.tick(now).catch((err) => log(`blocks: ${err}`));
  void episodes.tick(now).catch(fail);
  void voice.detector.tick().catch((err) => log(`voice: ${err}`));
}, 1000);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...processors.values()].map((p) => p.dispose()));
  await deps.blocks.closeAll();
  // The episodes of the chains just closed are still being written.
  await episodes.idle();
  await client.end({ timeout: 3 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
// Ctrl-C (or turbo stopping the server) signals the whole process group: shut down cleanly too
// rather than die mid-write. The server doesn't restart us while it is shutting down.
process.on("SIGINT", () => void shutdown());
process.on("disconnect", () => void shutdown());
send({ t: "ready" });
