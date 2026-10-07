import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { SPEAKER_MODEL_ID, type SpeakerEmbedder, toFloat32 } from "@hearloom/inference";
import { resolveSettings, wakeTerms } from "@hearloom/shared";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { loadStreamAudio } from "../../audio/load";
import { mediaVoices } from "../../episodes/store";
import type { ChildMessage, HostMessage } from "../ipc";
import type { SpeakerDirectory } from "../speakers";
import { throughPendantCodec, transcribeClip } from "./clip";
import { commandThreshold, logLearnVerdict, VoiceDetector } from "./detector";
import type { VoiceConfig } from "./types";

/** Reload a user's voice settings at least this often (changes also reload them at once). */
const CONFIG_TTL_MS = 60_000;

export interface VoiceRuntimeDeps {
  db: Db;
  embedder: SpeakerEmbedder | null;
  speakers: SpeakerDirectory | null;
  soniox: { apiKey: string; model: string; languageHints: string[] } | null;
  send(msg: ChildMessage): void;
  log(message: string): void;
}

/** The live pipeline's side of voice commands: config cache, detector, teaching and learning. */
export class VoiceRuntime {
  readonly detector: VoiceDetector;
  private configs = new Map<string, { at: number; config: Promise<VoiceConfig> }>();
  private termCache = new Map<string, string[]>();

  constructor(private readonly deps: VoiceRuntimeDeps) {
    this.detector = new VoiceDetector({
      config: (userId) => this.config(userId),
      score: async (userId, audio) => {
        if (!deps.embedder || !deps.speakers) return null;
        return deps.speakers.compare(userId, deps.embedder.embed(audio));
      },
      isMediaVoice: async (userId, chainId, key) =>
        (await mediaVoices(deps.db, userId, [chainId])).has(`${chainId}:${key}`),
      learn: (userId, personId, audio) => this.learn(userId, personId, audio),
      detected: (detection) => deps.send({ t: "voice_command", detection }),
      taught: (userId, result) => deps.send({ t: "teach_heard", userId, result }),
      log: deps.log,
    });
  }

  config(userId: string): Promise<VoiceConfig> {
    const hit = this.configs.get(userId);
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config;
    const config = this.load(userId);
    this.configs.set(userId, { at: Date.now(), config });
    config.then(
      (c) => this.termCache.set(userId, wakeTerms(c.wake)),
      () => this.configs.delete(userId),
    );
    return config;
  }

  /** Recognition hints for the user (the agent's name), from the cache; loads it if missing. */
  terms(userId: string): string[] {
    void this.config(userId).catch((err) => this.deps.log(`voice config: ${err}`));
    return this.termCache.get(userId) ?? [];
  }

  private async load(userId: string): Promise<VoiceConfig> {
    const { db } = this.deps;
    const [row] = await db
      .select({ settings: schema.userSettings.settings })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId));
    const v = resolveSettings(row?.settings).voice;
    const s = schema.voiceSamples;
    const scores = await db
      .select({ score: s.speakerScore })
      .from(s)
      // Taught samples only: a command's score is what the gate measured, and a vouched-for one
      // must not pull the threshold down.
      .where(and(eq(s.userId, userId), isNotNull(s.speakerScore), ne(s.source, "command")))
      .orderBy(desc(s.createdAt))
      .limit(50);
    return {
      mode: v.mode,
      wake: { names: v.names, aliases: v.aliases, blocked: v.blocked },
      minScore: commandThreshold(scores.map((r) => r.score!)),
    };
  }

  /** Store a voiceprint of the user's own voice. */
  private async learn(userId: string, personId: string, audio: Float32Array): Promise<string> {
    if (!this.deps.embedder) throw new Error("speaker model not installed");
    const [row] = await this.deps.db
      .insert(schema.voiceprints)
      .values({
        userId,
        personId,
        model: SPEAKER_MODEL_ID,
        embedding: Array.from(this.deps.embedder.embed(audio)),
        sampleSeconds: audio.length / 16000,
        source: "enrollment",
      })
      .returning({ id: schema.voiceprints.id });
    this.deps.speakers?.invalidate(userId);
    return row!.id;
  }

  /** Handle a voice message from the host; false if it isn't one. */
  handle(msg: HostMessage): boolean {
    switch (msg.t) {
      case "voice_changed":
        this.configs.delete(msg.userId);
        this.deps.speakers?.invalidate(msg.userId);
        return true;
      case "teach":
        this.detector.setTeach(msg.userId, msg.prompt);
        return true;
      case "teach_audio":
        void this.teachAudio(msg).catch((err) => {
          this.deps.log(`voice teach (browser): ${err}`);
          this.deps.send({
            t: "teach_heard",
            userId: msg.userId,
            result: {
              sessionId: msg.prompt.sessionId,
              kind: msg.prompt.kind,
              index: msg.prompt.index,
              phrase: msg.prompt.phrase,
              source: "browser",
              text: "",
              ok: false,
              heardAs: null,
              nameScore: 0,
              wouldMatch: false,
              speakerScore: null,
              seconds: 0,
              voiceprintId: null,
              wouldTrigger: false,
              error: String(err?.message ?? err),
            },
          });
        });
        return true;
      case "learn_voice":
        void this.learnSpan(msg).then(
          ({ voiceprintId, seconds }) =>
            this.deps.send({
              t: "learned",
              requestId: msg.requestId,
              ok: true,
              voiceprintId,
              seconds,
            }),
          (err) =>
            this.deps.send({
              t: "learned",
              requestId: msg.requestId,
              ok: false,
              error: String(err?.message ?? err),
            }),
        );
        return true;
      default:
        return false;
    }
  }

  private async teachAudio(msg: Extract<HostMessage, { t: "teach_audio" }>): Promise<void> {
    const { soniox } = this.deps;
    if (!soniox) throw new Error("transcription is off (LIVE_ASR=off)");
    const pcm = throughPendantCodec(msg.pcm);
    const text = await transcribeClip(pcm, { ...soniox, terms: this.terms(msg.userId) });
    await this.detector.teach(msg.userId, msg.prompt, text, toFloat32(pcm), "browser");
  }

  private async learnSpan(
    msg: Extract<HostMessage, { t: "learn_voice" }>,
  ): Promise<{ voiceprintId: string; seconds: number }> {
    const pieces: Float32Array[] = [];
    for (const r of msg.ranges) {
      const a = await loadStreamAudio(this.deps.db, msg.streamId, r.startAt, r.endAt);
      if (a) pieces.push(a);
    }
    const audio = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of pieces) {
      audio.set(p, o);
      o += p.length;
    }
    if (audio.length < 16_000) throw new Error("need at least 1 s of stored audio");
    const { embedder, speakers } = this.deps;
    if (!embedder || !speakers) throw new Error("speaker model not installed");
    // The user vouched for it, but it must still sound like them (not a partner, not the TV): as
    // much as a command must to be sent.
    const { minScore } = await this.config(msg.userId);
    const refused = logLearnVerdict(
      await speakers.compare(msg.userId, embedder.embed(audio)),
      minScore,
    );
    if (refused) throw new Error(refused);
    const voiceprintId = await this.learn(msg.userId, msg.personId, audio);
    return { voiceprintId, seconds: audio.length / 16000 };
  }
}
