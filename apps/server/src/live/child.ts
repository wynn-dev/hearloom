/**
 * Live pipeline worker process (spawned by the server, see host.ts). Holds the native models
 * (sherpa-onnx) so a crash here can't take down audio ingest. Receives stored Opus frames over IPC,
 * writes utterances / sound events / conversations to Postgres, and reports state back.
 */
import { createDb, schema } from "@hearloom/db";
import {
  hasModel,
  LocalAsr,
  MODEL_FILES,
  SoundTagger,
  SPEAKER_MODEL_ID,
  SpeakerEmbedder,
} from "@hearloom/inference";
import type { AudioFrame } from "@hearloom/shared";
import { and, eq } from "drizzle-orm";
import { loadStreamAudio } from "../audio/load";
import { env, modelsDir } from "../env";
import { ConversationTracker } from "./conversations";
import type { ChildMessage, HostMessage } from "./ipc";
import { type LiveDeps, type StreamInfo, StreamProcessor } from "./processor";
import { SpeakerDirectory } from "./speakers";

const send = (msg: ChildMessage) => process.send?.(msg);
const log = (message: string) => send({ t: "log", message });

if (!hasModel(modelsDir, MODEL_FILES.vad)) {
  log(`models missing in ${modelsDir}; run: pnpm --filter @hearloom/server download-models`);
  process.exit(2);
}

const { db, client } = createDb(env.DATABASE_URL, { max: 4 });

const asrMode = env.LIVE_ASR === "auto" ? (env.SONIOX_API_KEY ? "soniox" : "local") : env.LIVE_ASR;
const wantLocalAsr =
  asrMode !== "off" && hasModel(modelsDir, `${MODEL_FILES.parakeetDir}/encoder.int8.onnx`);

const embedder = hasModel(modelsDir, MODEL_FILES.speaker) ? new SpeakerEmbedder(modelsDir) : null;
const deps: LiveDeps = {
  db,
  modelsDir,
  tagger: hasModel(modelsDir, MODEL_FILES.tagger) ? new SoundTagger(modelsDir) : null,
  embedder,
  // Local ASR transcribes backlog audio, and everything when there's no Soniox key.
  localAsr: wantLocalAsr ? new LocalAsr(modelsDir) : null,
  speakers: embedder
    ? new SpeakerDirectory(db, SPEAKER_MODEL_ID, env.SPEAKER_MATCH_THRESHOLD)
    : null,
  conversations: new ConversationTracker(
    db,
    {
      started: (userId) => send({ t: "state", userId, patch: { inConversation: true } }),
      ended: (userId, conversationId) => {
        send({ t: "state", userId, patch: { inConversation: false, conversationId: null } });
        send({ t: "conversation_ended", userId, conversationId });
      },
    },
    env.SPEAKER_CLUSTER_THRESHOLD,
  ),
  soniox:
    asrMode === "soniox" && env.SONIOX_API_KEY
      ? {
          apiKey: env.SONIOX_API_KEY,
          model: env.SONIOX_MODEL,
          languageHints: env.LANGUAGE_HINTS.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : null,
  invalidate: (userId, keys) => send({ t: "invalidate", userId, keys }),
  log,
};

log(
  `ready: asr=${asrMode}${deps.localAsr ? " (+local parakeet)" : ""}, tagger=${deps.tagger ? "ced-base" : "off"}, speakers=${embedder ? SPEAKER_MODEL_ID : "off"}`,
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
  if (msg.t === "frames") {
    void processorFor(msg.stream).push(msg.frames as AudioFrame[]);
  } else if (msg.t === "voiceprints_changed") {
    deps.speakers?.invalidate(msg.userId);
  } else if (msg.t === "enroll") {
    void enroll(msg).then(
      (sampleSeconds) => send({ t: "enrolled", requestId: msg.requestId, ok: true, sampleSeconds }),
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
async function enroll(msg: Extract<HostMessage, { t: "enroll" }>): Promise<number> {
  if (!embedder) throw new Error("speaker model not installed");
  const [u] = await db
    .select()
    .from(schema.utterances)
    .where(
      and(eq(schema.utterances.id, msg.utteranceId), eq(schema.utterances.userId, msg.userId)),
    );
  if (!u) throw new Error("utterance not found");
  if (!u.streamId) throw new Error("utterance has no audio");
  const audio = await loadStreamAudio(db, u.streamId, u.startAt.getTime(), u.endAt.getTime());
  if (!audio || audio.length < 16_000) throw new Error("need at least 1 s of stored audio");
  const embedding = embedder.embed(audio);
  const [person] = await db
    .select({ isSelf: schema.people.isSelf })
    .from(schema.people)
    .where(eq(schema.people.id, msg.personId));
  await db.insert(schema.voiceprints).values({
    userId: msg.userId,
    personId: msg.personId,
    model: SPEAKER_MODEL_ID,
    embedding: Array.from(embedding),
    sampleSeconds: audio.length / 16000,
    source: "confirmed",
  });
  await db
    .update(schema.utterances)
    .set({ personId: msg.personId, isWearer: person?.isSelf ?? false })
    .where(eq(schema.utterances.id, u.id));
  deps.speakers?.invalidate(msg.userId);
  return audio.length / 16000;
}

// Close runs after silence, idle Soniox sessions, quiet conversations; drop idle processors.
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of processors) {
    void p.tick(now);
    if (now - p.lastActivity > 10 * 60_000) {
      processors.delete(id);
      void p.dispose();
    }
  }
  void deps.conversations.tick(now).catch((err) => log(`conversations: ${err}`));
}, 1000);

async function shutdown() {
  await Promise.all([...processors.values()].map((p) => p.dispose()));
  await deps.conversations.closeAll();
  await client.end({ timeout: 3 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("disconnect", () => void shutdown());
send({ t: "ready" });
