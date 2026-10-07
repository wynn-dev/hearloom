import { alignTeach, matchWake, nearWake, textSimilarity } from "@hearloom/shared";
import { type AssembledCommand, CommandAssembler, type HeardUtterance } from "./assembler";
import type { IgnoreReason, TeachPrompt, TeachResult, VoiceConfig, VoiceDetection } from "./types";

/** Default own-voice threshold before the user's samples say otherwise. */
export const DEFAULT_MIN_SCORE = 0.65;

/**
 * Own-voice threshold from the similarity of the user's teaching samples to their voice: a bit
 * under the low end of what their real voice scores, within sane bounds.
 */
export function commandThreshold(sampleScores: number[]): number {
  const scores = sampleScores.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  if (scores.length < 3) return DEFAULT_MIN_SCORE;
  const p20 = scores[Math.floor((scores.length - 1) * 0.2)]!;
  return Math.min(0.75, Math.max(0.55, p20 - 0.05));
}

/** Where a user's utterances come from (one stream processor). */
export interface AudioSource {
  streamId: string;
  /** 16 kHz audio between two absolute times, if still retained. */
  audio(from: number, to: number): Float32Array | null;
  /** Audio time of the latest speech heard on this stream. */
  lastSpeechAt(): number;
}

export interface VoiceScore {
  /** Best similarity to the user's own voiceprints; null if they have none. */
  self: number | null;
  /** Best similarity to anyone else's. */
  other: number;
}

export interface DetectorDeps {
  config(userId: string): Promise<VoiceConfig>;
  /** Embed audio and compare it to the user's voiceprints (null: no speaker model). */
  score(userId: string, audio: Float32Array): Promise<VoiceScore | null>;
  /** Is this chain's speaker a TV/radio voice? */
  isMediaVoice(userId: string, chainId: string, speakerKey: string): Promise<boolean>;
  /** Learn a voiceprint for the user's own person from audio; returns its id. */
  learn(userId: string, personId: string, audio: Float32Array): Promise<string>;
  detected(d: VoiceDetection): void;
  taught(userId: string, r: TeachResult): void;
  log(message: string): void;
  now?(): number;
}

/** Commands need at least this much audio for the own-voice check (the wake word plus a bit). */
const MIN_VERIFY_SAMPLES = 12_800; // 0.8 s
/** A teaching sample becomes a voiceprint only if it's this long (short ones would blur matching). */
export const MIN_PRINT_SAMPLES = 24_000; // 1.5 s
const PAD_MS = 250;
/** Accepted commands: at least this far apart, at most so many per minute / hour. */
const COOLDOWN_MS = 2_000;
const MAX_PER_MINUTE = 6;
const MAX_PER_HOUR = 30;
/** The same speech captured by two streams: start within this, text this similar. */
const DUPLICATE_MS = 1_500;
const DUPLICATE_SIMILARITY = 0.8;

interface UserState {
  assembler: CommandAssembler;
  source: AudioSource | null;
  teach: TeachPrompt | null;
  /** Accepted (sent or shadow) commands, newest last, for dedupe and rate limits. */
  recent: { spokenAt: number; acceptedAt: number; command: string }[];
}

/**
 * Voice commands and voice teaching in the live pipeline: fed every fresh, final utterance; finds
 * "hey <name>, …", checks it's the user's own voice (not the TV, not someone else, not a
 * duplicate), and reports it. While the user is teaching on the Voice page, their utterances are
 * matched against the prompted phrase instead (and never become commands).
 */
export class VoiceDetector {
  private users = new Map<string, UserState>();

  constructor(private readonly deps: DetectorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private user(userId: string): UserState {
    let s = this.users.get(userId);
    if (!s) {
      s = { assembler: new CommandAssembler(), source: null, teach: null, recent: [] };
      this.users.set(userId, s);
    }
    return s;
  }

  setTeach(userId: string, prompt: TeachPrompt | null): void {
    this.user(userId).teach = prompt;
  }

  /**
   * A fresh final utterance. `audio` is its audio when the processor has it; `isSelf` comes from
   * its own embedding (null when it was too short).
   */
  async heard(userId: string, u: HeardUtterance, source: AudioSource): Promise<void> {
    const s = this.user(userId);
    s.source = source;
    if (s.teach) {
      const audio = source.audio(u.startAt - PAD_MS, u.endAt + PAD_MS);
      await this.teach(userId, s.teach, u.text, audio, "pendant");
      return;
    }
    const cfg = await this.deps.config(userId);
    if (cfg.mode === "off") return;
    const step = s.assembler.push(u, cfg.wake, source.lastSpeechAt(), this.now());
    await this.handle(userId, s, cfg, step);
    if (step.done.length === 0 && !s.assembler.busy && u.isSelf) this.nearMiss(userId, u, cfg);
  }

  /** Once a second: finish commands whose continuation didn't come. */
  async tick(): Promise<void> {
    for (const [userId, s] of this.users) {
      if (!s.assembler.busy || !s.source) continue;
      const step = s.assembler.tick(s.source.lastSpeechAt(), this.now());
      if (step.done.length === 0 && step.abandoned.length === 0) continue;
      await this.handle(userId, s, await this.deps.config(userId), step);
    }
  }

  private async handle(
    userId: string,
    s: UserState,
    cfg: VoiceConfig,
    step: ReturnType<CommandAssembler["push"]>,
  ): Promise<void> {
    for (const a of step.abandoned) {
      this.report(
        userId,
        cfg,
        {
          parts: [a.utterance],
          wake: a.wake,
          command: "",
          transcript: a.utterance.text,
          spokenAt: a.utterance.startAt,
          endedAt: a.utterance.endAt,
        },
        "ignored",
        a.reason,
        null,
      );
    }
    for (const c of step.done) await this.gate(userId, s, cfg, c);
  }

  private async gate(
    userId: string,
    s: UserState,
    cfg: VoiceConfig,
    c: AssembledCommand,
  ): Promise<void> {
    const now = this.now();
    // Own voice, over the whole span (a short "Hey Hermes" has no embedding of its own).
    const audio = s.source?.audio(c.spokenAt, c.endedAt) ?? null;
    let score: VoiceScore | null = null;
    if (audio && audio.length >= MIN_VERIFY_SAMPLES) score = await this.deps.score(userId, audio);
    if (!score || score.self === null) {
      this.report(userId, cfg, c, "ignored", "no_voiceprint", null);
      return;
    }
    if (score.self < cfg.minScore || score.other > score.self) {
      this.report(userId, cfg, c, "ignored", "not_own_voice", score.self);
      return;
    }
    const first = c.parts[0]!;
    if (
      first.speakerKey &&
      (await this.deps.isMediaVoice(userId, first.chainId, first.speakerKey))
    ) {
      this.report(userId, cfg, c, "ignored", "media_voice", score.self);
      return;
    }
    // Two streams (or slots) heard the same thing: keep one, silently.
    if (
      s.recent.some(
        (r) =>
          Math.abs(r.spokenAt - c.spokenAt) <= DUPLICATE_MS &&
          textSimilarity(r.command, c.command) >= DUPLICATE_SIMILARITY,
      )
    )
      return;
    s.recent = s.recent.filter((r) => now - r.acceptedAt < 3600_000);
    const last = s.recent.at(-1);
    const lastMinute = s.recent.filter((r) => now - r.acceptedAt < 60_000).length;
    if (
      (last && now - last.acceptedAt < COOLDOWN_MS) ||
      lastMinute >= MAX_PER_MINUTE ||
      s.recent.length >= MAX_PER_HOUR
    ) {
      this.report(userId, cfg, c, "ignored", "rate_limited", score.self);
      return;
    }
    s.recent.push({ spokenAt: c.spokenAt, acceptedAt: now, command: c.command });
    this.report(userId, cfg, c, cfg.mode === "on" ? "pending" : "shadow", null, score.self);
  }

  /** The user said a greeting and something name-like that didn't match: maybe a missed command. */
  private nearMiss(userId: string, u: HeardUtterance, cfg: VoiceConfig): void {
    const wake = nearWake(u.text, cfg.wake);
    if (!wake) return;
    const c = {
      parts: [u],
      wake,
      command: wake.command,
      transcript: u.text,
      spokenAt: u.startAt,
      endedAt: u.endAt,
    };
    this.report(userId, cfg, c, "ignored", "near_miss", null);
  }

  private report(
    userId: string,
    cfg: VoiceConfig,
    c: AssembledCommand,
    status: VoiceDetection["status"],
    reason: IgnoreReason | null,
    speakerScore: number | null,
  ): void {
    if (cfg.mode === "off") return;
    const first = c.parts[0]!;
    this.deps.detected({
      id: crypto.randomUUID(),
      userId,
      streamId: first.streamId,
      chainId: first.chainId,
      spokenAt: c.spokenAt,
      endedAt: c.endedAt,
      detectedAt: this.now(),
      wakeName: c.wake.name,
      heardAs: c.wake.heardAs,
      nameScore: c.wake.score,
      transcript: c.transcript,
      command: c.command,
      lang: first.lang,
      speakerScore,
      status,
      reason,
    });
  }

  /** A teaching utterance (from the pendant, or recorded in the browser). */
  async teach(
    userId: string,
    prompt: TeachPrompt,
    text: string,
    audio: Float32Array | null,
    source: TeachResult["source"],
  ): Promise<void> {
    const cfg = await this.deps.config(userId);
    const align = alignTeach(text, prompt.phrase, cfg.wake);
    const wake = matchWake(text, cfg.wake);
    const ok = prompt.kind === "test" ? wake !== null : align.ok;
    let speakerScore: number | null = null;
    let voiceprintId: string | null = null;
    const seconds = (audio?.length ?? 0) / 16_000;
    if (ok && audio && audio.length >= MIN_VERIFY_SAMPLES) {
      const score = await this.deps.score(userId, audio);
      speakerScore = score?.self ?? null;
      if (prompt.kind === "sample" && audio.length >= MIN_PRINT_SAMPLES) {
        try {
          voiceprintId = await this.deps.learn(userId, prompt.personId, audio);
        } catch (err) {
          this.deps.log(`voice teach: ${err}`);
        }
      }
    }
    this.deps.taught(userId, {
      sessionId: prompt.sessionId,
      kind: prompt.kind,
      index: prompt.index,
      phrase: prompt.phrase,
      source,
      text,
      ok,
      heardAs: prompt.kind === "test" ? (wake?.heardAs ?? align.heardAs) : align.heardAs,
      nameScore: prompt.kind === "test" ? (wake?.score ?? 0) : align.nameScore,
      wouldMatch: wake !== null,
      speakerScore,
      seconds,
      voiceprintId,
      wouldTrigger: wake !== null && speakerScore !== null && speakerScore >= cfg.minScore,
    });
  }
}
