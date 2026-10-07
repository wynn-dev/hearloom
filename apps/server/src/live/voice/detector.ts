import { alignTeach, matchWake, nearWake, textSimilarity } from "@hearloom/shared";
import {
  type AssembledCommand,
  CommandAssembler,
  DEFAULT_LIMITS,
  type HeardUtterance,
} from "./assembler";
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
  return Math.min(0.75, Math.max(THRESHOLD_FLOOR, p20 - 0.05));
}

/** The lowest own-voice bar a command can ever need. */
export const THRESHOLD_FLOOR = 0.55;

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
/** Transcripts sent to the agent are capped (the command itself at 500 by the assembler). */
export const MAX_TRANSCRIPT_CHARS = 1_000;
/**
 * A teaching sample must be at least this close to the user's voice (once there is one): never
 * below the lowest bar a command could need, so learned samples can't pull the threshold under it.
 */
export const TEACH_MIN_SELF = THRESHOLD_FLOOR;
/** Before the user has a voiceprint: a sample this close to someone else's is theirs, not the user's. */
const TEACH_OTHER_MATCH = 0.6;

/**
 * May a teaching sample with this voice score be learned as the user's voice? Null if so, else why
 * not. Teaching must not enrol whoever happens to be talking while the Voice page is open.
 */
export function teachVoiceVerdict(score: VoiceScore | null): string | null {
  if (!score) return "Too short to check it's your voice — say the whole phrase.";
  if (score.self === null) {
    return score.other >= TEACH_OTHER_MATCH
      ? "That sounded like someone else you've named, not you — not learned."
      : null;
  }
  if (score.self < TEACH_MIN_SELF || score.other > score.self)
    return "That didn't sound like you — not learned.";
  return null;
}

/**
 * May audio from the command log (👍 / Missed) be learned as the user's voice? It must clear the
 * same bar a command needs to be sent; otherwise one click could enrol a family member whose
 * voice is merely similar, and their commands would be sent from then on.
 */
export function logLearnVerdict(score: VoiceScore, minScore: number): string | null {
  if (score.self === null) return "Teach your voice on this page first.";
  if (score.self < minScore || score.other > score.self)
    return "That didn't sound enough like you to learn from.";
  return null;
}

/**
 * After a teaching session stops, speech that started up to this long after is still treated as
 * teaching: the recognizer finalizes the last phrase a second or two after it's said, and it must
 * not become a command.
 */
export const TEACH_GRACE_MS = 10_000;

/** Audio of the parts only (not the silence or other speech between a wake word and command). */
function partsAudio(source: AudioSource | null, parts: HeardUtterance[]): Float32Array | null {
  if (!source) return null;
  const pieces = parts.flatMap((p) => source.audio(p.startAt, p.endAt) ?? []);
  if (pieces.length === 0) return null;
  const out = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pieces) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface UserState {
  assembler: CommandAssembler;
  source: AudioSource | null;
  teach: TeachPrompt | null;
  /** Speech starting before this (ms) is still teaching (the session just stopped). */
  teachGraceUntil: number;
  /** Accepted (sent or shadow) commands, newest last, for dedupe and rate limits. */
  recent: { spokenAt: number; acceptedAt: number; command: string }[];
}

/** Forget idle users after this long (their processors are gone too). */
const USER_IDLE_MS = 3600_000;

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
      s = {
        assembler: new CommandAssembler(),
        source: null,
        teach: null,
        teachGraceUntil: 0,
        recent: [],
      };
      this.users.set(userId, s);
    }
    return s;
  }

  setTeach(userId: string, prompt: TeachPrompt | null): void {
    const s = this.user(userId);
    if (s.teach && !prompt) s.teachGraceUntil = this.now() + TEACH_GRACE_MS;
    s.teach = prompt;
  }

  /** A stream processor was disposed: drop references to its audio, and users with nothing going on. */
  dropSource(streamId: string): void {
    const now = this.now();
    for (const [userId, s] of this.users) {
      if (s.source?.streamId === streamId) s.source = null;
      s.recent = s.recent.filter((r) => now - r.acceptedAt < USER_IDLE_MS);
      if (
        !s.source &&
        !s.teach &&
        !s.assembler.busy &&
        s.recent.length === 0 &&
        now >= s.teachGraceUntil
      )
        this.users.delete(userId);
    }
  }

  /** Users with state (tests). */
  get userCount(): number {
    return this.users.size;
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
    // Said while teaching (or just after): never a command.
    if (u.startAt < s.teachGraceUntil) return;
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
    // Own voice, over all parts together (a short "Hey Hermes" has no embedding of its own).
    const audio = partsAudio(s.source, c.parts);
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
      parts: c.parts.map((p) => ({ startAt: p.startAt, endAt: p.endAt })),
      detectedAt: this.now(),
      wakeName: c.wake.name,
      heardAs: c.wake.heardAs,
      nameScore: c.wake.score,
      transcript: c.transcript.slice(0, MAX_TRANSCRIPT_CHARS),
      command: c.command.slice(0, DEFAULT_LIMITS.maxChars),
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
    let ok = prompt.kind === "test" ? wake !== null : align.ok;
    let speakerScore: number | null = null;
    let voiceprintId: string | null = null;
    let error: string | undefined;
    const seconds = (audio?.length ?? 0) / 16_000;
    if (ok) {
      const score =
        audio && audio.length >= MIN_VERIFY_SAMPLES ? await this.deps.score(userId, audio) : null;
      speakerScore = score?.self ?? null;
      const refused = prompt.kind === "sample" ? teachVoiceVerdict(score) : null;
      if (refused) {
        ok = false;
        error = refused;
      } else if (prompt.kind === "sample" && audio && audio.length >= MIN_PRINT_SAMPLES) {
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
      ...(error ? { error } : {}),
    });
  }
}
