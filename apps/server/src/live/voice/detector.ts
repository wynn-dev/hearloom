import { alignTeach, matchWake, nearWake, textSimilarity } from "@hearloom/shared";
import type { PartialUtterance } from "../asr/types";
import {
  type AssembledCommand,
  CommandAssembler,
  DEFAULT_LIMITS,
  type HeardUtterance,
  type Step,
} from "./assembler";
import type {
  IgnoreReason,
  TeachHeard,
  TeachPrompt,
  VoiceConfig,
  VoiceCueEvent,
  VoiceDetection,
} from "./types";

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
  /** Audio time of the end of the audio heard so far. */
  heardUntil(): number;
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
  /** A voiceprint embedding of the audio (stored by the host, with the sample it came from). */
  embed(audio: Float32Array): Promise<number[]>;
  detected(d: VoiceDetection): void;
  /** Buzz the pendant (the wake phrase was heard, or how the command went). */
  cue(e: VoiceCueEvent): void;
  taught(userId: string, r: TeachHeard): void;
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

/**
 * The running transcript's last word is only taken as the whole name once this much audio after
 * it has been recognized without the word growing ("Adri" → "Adrian").
 */
export const NAME_SETTLE_MS = 400;
/**
 * A wake phrase buzzed from the running transcript must be in a finished utterance this long after
 * the recognizer last showed its utterance. (Wall clock: a live pipeline more than 10 s behind
 * would say "no command" for a command it then sends. Accepted: it's far behind by then anyway.)
 */
export const CUE_CONFIRM_MS = 10_000;
/**
 * A cue still waiting for its command after this long went wrong somewhere (the longest command
 * takes 8 s to start, 30 s to say and 4 s to wait for): tell it failed.
 */
const CUE_MAX_MS = 60_000;
/**
 * Wake phrases already told are remembered this long, so the same words heard by another stream
 * (or slot) don't buzz again.
 */
const TOLD_MS = 45_000; // longer than a stream can lag (30 s of audio still counts as fresh)
/** The own-voice check of a running transcript uses at most this much audio after the name. */
const PARTIAL_AUDIO_AFTER_MS = 1_500;

/** A wake phrase the user was told (by a buzz) was heard: its outcome is told too. */
interface Cue {
  /** The stream it was heard on: only that stream's own utterances can say it wasn't one. */
  streamId: string;
  /** Audio time the greeting started, and the name ended. */
  startAt: number;
  nameEndAt: number;
  /** When it was buzzed (wall clock). */
  at: number;
  /** When the recognizer last showed its utterance, still unfinished (wall clock). */
  seenAt: number;
  /** A finished utterance has the wake phrase (else it was the running transcript's guess). */
  confirmed: boolean;
}

type Span = { startAt: number; nameEndAt: number };

/** Does an utterance contain the cued wake phrase? (Touching isn't overlapping.) */
function covers(u: { startAt: number; endAt: number }, c: Span): boolean {
  return u.startAt < c.nameEndAt && u.endAt > c.startAt;
}

interface UserState {
  assembler: CommandAssembler;
  source: AudioSource | null;
  teach: TeachPrompt | null;
  /** Speech starting before this (ms) is still teaching (the session just stopped). */
  teachGraceUntil: number;
  /** Accepted (sent or shadow) commands, newest last, for dedupe and rate limits. */
  recent: { spokenAt: number; acceptedAt: number; command: string }[];
  /** Buzzed wake phrases whose outcome hasn't been told yet. */
  cues: Cue[];
  /** Wake phrases whose outcome was told, recently (`at`: when). */
  told: (Span & { at: number })[];
  /** Per stream: start of the running utterance last decided on (it isn't checked again). */
  partialDecided: Map<string, number>;
  /** Per stream: the newest running transcript, waiting to be checked. */
  partials: Map<string, { p: PartialUtterance; source: AudioSource }>;
  /** Serializes this user's utterances and running transcripts. */
  chain: Promise<void>;
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
        cues: [],
        told: [],
        partialDecided: new Map(),
        partials: new Map(),
        chain: Promise.resolve(),
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
      s.partials.delete(streamId);
      s.partialDecided.delete(streamId);
      s.recent = s.recent.filter((r) => now - r.acceptedAt < USER_IDLE_MS);
      if (
        !s.source &&
        !s.teach &&
        !s.assembler.busy &&
        s.recent.length === 0 &&
        s.cues.length === 0 &&
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
  heard(userId: string, u: HeardUtterance, source: AudioSource): Promise<void> {
    const s = this.user(userId);
    const run = s.chain.then(() => this.heardNow(userId, s, u, source));
    s.chain = run.catch((err) => this.deps.log(`voice: ${err}`));
    return run;
  }

  /**
   * The utterance being spoken, as the recognizer has it so far: buzz as soon as it starts with
   * the wake phrase in the user's own voice, rather than when the utterance is finished (a second
   * or two later). Only the newest one waiting is checked.
   */
  partial(userId: string, p: PartialUtterance, source: AudioSource): Promise<void> {
    const s = this.user(userId);
    const now = this.now();
    // Its utterance is still being recognized.
    for (const c of s.cues)
      if (!c.confirmed && covers({ startAt: p.startAt, endAt: p.audioAt }, c)) c.seenAt = now;
    const key = source.streamId;
    const queued = s.partials.has(key);
    s.partials.set(key, { p, source });
    if (queued) return s.chain;
    s.chain = s.chain
      .then(() => {
        const next = s.partials.get(key);
        s.partials.delete(key);
        return next ? this.checkPartial(userId, s, next.p, next.source) : undefined;
      })
      .catch((err) => this.deps.log(`voice: ${err}`));
    return s.chain;
  }

  private async checkPartial(
    userId: string,
    s: UserState,
    p: PartialUtterance,
    source: AudioSource,
  ): Promise<void> {
    const key = source.streamId;
    if (s.teach || p.startAt < s.teachGraceUntil || p.startAt <= (s.partialDecided.get(key) ?? 0))
      return;
    // One wake phrase at a time; one in a finished utterance is handled there.
    if (s.cues.length > 0 || s.assembler.busy) return;
    const cfg = await this.deps.config(userId);
    if (cfg.mode !== "on" || !cfg.haptics) return;
    const wake = matchWake(p.text, cfg.wake);
    if (!wake) return;
    // The wake phrase's own times: the running utterance may still start with earlier words that
    // the recognizer hasn't split off yet ("I'm off. Hey Adri, …").
    const greeting = p.tokens.find((t) => t.offset > wake.start);
    if (!greeting) return;
    const span = {
      startAt: greeting.startAt,
      nameEndAt: p.tokens.find((t) => t.offset >= wake.end)?.endAt ?? p.audioAt,
    };
    // The name is the last word so far: it may still be the start of a longer one.
    if (!/\S/.test(p.text.slice(wake.end)) && p.audioAt - span.nameEndAt < NAME_SETTLE_MS) return;
    const audio = source.audio(
      span.startAt - PAD_MS,
      Math.min(
        Math.max(span.nameEndAt + PAD_MS, p.audioAt),
        span.nameEndAt + PARTIAL_AUDIO_AFTER_MS,
      ),
    );
    if (!audio || audio.length < MIN_VERIFY_SAMPLES) return; // more audio with the next one
    s.partialDecided.set(key, p.startAt);
    // Another stream heard (and buzzed) the same words.
    if (this.told(s, span)) return;
    if (!(await this.ownVoice(userId, cfg, audio))) return;
    this.cueHeard(userId, s, { ...span, streamId: key, confirmed: false }, "partial");
  }

  /** Was the user already buzzed about the wake phrase in this span (still open, or recently)? */
  private told(s: UserState, span: Span): boolean {
    const u = { startAt: span.startAt, endAt: span.nameEndAt };
    const now = this.now();
    return (
      s.cues.some((c) => covers(u, c)) || s.told.some((c) => now - c.at < TOLD_MS && covers(u, c))
    );
  }

  private async ownVoice(userId: string, cfg: VoiceConfig, audio: Float32Array): Promise<boolean> {
    if (audio.length < MIN_VERIFY_SAMPLES) return false;
    const score = await this.deps.score(userId, audio);
    return (
      !!score && score.self !== null && score.self >= cfg.minScore && score.other <= score.self
    );
  }

  private cueHeard(
    userId: string,
    s: UserState,
    c: Omit<Cue, "at" | "seenAt">,
    via: "partial" | "final",
  ): void {
    const at = this.now();
    s.cues.push({ ...c, at, seenAt: at });
    this.deps.log(
      `voice: wake phrase heard (${via}) ${at - c.nameEndAt} ms after the ${via === "partial" ? "name" : "utterance"} ended`,
    );
    this.deps.cue({ userId, cue: "heard", nameEndAt: c.nameEndAt, via, at });
  }

  /** Tell the outcome of the cued wake phrase in this utterance, if there is one. */
  private cueOutcome(
    userId: string,
    s: UserState,
    u: { startAt: number; endAt: number },
    cue: "no_command" | "failed" | null,
  ): void {
    const i = s.cues.findIndex((c) => covers(u, c));
    if (i < 0) return;
    const [c] = s.cues.splice(i, 1);
    const now = this.now();
    s.told = s.told.filter((t) => now - t.at < TOLD_MS);
    s.told.push({ startAt: c!.startAt, nameEndAt: c!.nameEndAt, at: now });
    if (cue) this.deps.cue({ userId, cue, nameEndAt: null, via: null, at: now });
  }

  private async heardNow(
    userId: string,
    s: UserState,
    u: HeardUtterance,
    source: AudioSource,
  ): Promise<void> {
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
    const step = s.assembler.push(
      u,
      cfg.wake,
      source.lastSpeechAt(),
      this.now(),
      source.heardUntil(),
    );
    await this.handle(userId, s, cfg, step, u);
    if (step.done.length === 0 && !s.assembler.busy && u.isSelf) this.nearMiss(userId, u, cfg);
  }

  /** Once a second: finish commands whose continuation didn't come. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const [userId, s] of this.users) {
      // A wake phrase in the running transcript that no finished utterance had.
      for (const c of [...s.cues]) {
        const span = { startAt: c.startAt, endAt: c.nameEndAt };
        if (!c.confirmed && now - c.seenAt > CUE_CONFIRM_MS)
          this.cueOutcome(userId, s, span, "no_command");
        else if (now - c.at > CUE_MAX_MS) this.cueOutcome(userId, s, span, "failed");
      }
      if (!s.assembler.busy) continue;
      // Without a stream (it ended), nothing more is coming: finish now.
      const step = s.source
        ? s.assembler.tick(s.source.lastSpeechAt(), now, s.source.heardUntil())
        : s.assembler.tick(0, now);
      if (step.done.length === 0 && step.abandoned.length === 0) continue;
      await this.handle(userId, s, await this.deps.config(userId), step);
    }
  }

  /** `u`: the utterance that made this step (none when time passed). */
  private async handle(
    userId: string,
    s: UserState,
    cfg: VoiceConfig,
    step: Step,
    u?: HeardUtterance,
  ): Promise<void> {
    for (const a of step.abandoned) {
      this.cueOutcome(userId, s, a.utterance, "no_command");
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
    const woke = step.woke?.utterance;
    // Earlier commands this utterance completed are told before its own wake phrase.
    for (const c of step.done) if (c.parts[0] !== woke) await this.finish(userId, s, cfg, c);
    if (u && cfg.mode === "on" && cfg.haptics) await this.cueWake(userId, s, cfg, step, u);
    for (const c of step.done) if (c.parts[0] === woke) await this.finish(userId, s, cfg, c);
  }

  private async finish(
    userId: string,
    s: UserState,
    cfg: VoiceConfig,
    c: AssembledCommand,
  ): Promise<void> {
    const sent = await this.gate(userId, s, cfg, c);
    // Sent: the server tells how the delivery went.
    this.cueOutcome(userId, s, c.parts[0]!, sent === false ? "failed" : null);
  }

  /**
   * A finished utterance: confirm the wake phrase buzzed from the running transcript, or tell
   * that it wasn't one after all; buzz for a wake phrase the running transcript didn't show.
   */
  private async cueWake(
    userId: string,
    s: UserState,
    cfg: VoiceConfig,
    step: Step,
    u: HeardUtterance,
  ): Promise<void> {
    const woke = step.woke?.utterance;
    for (const c of s.cues.filter((c) => !c.confirmed && covers(u, c))) {
      if (woke === u) c.confirmed = true;
      // Another stream may hear the same words differently: only the cue's own stream says it
      // wasn't the wake phrase (otherwise the confirm timeout does).
      else if (u.streamId === c.streamId)
        this.cueOutcome(userId, s, { startAt: c.startAt, endAt: c.nameEndAt }, "no_command");
    }
    if (!woke || this.told(s, { startAt: woke.startAt, nameEndAt: woke.endAt })) return;
    // With the command in it: the audio its own-voice gate checks. A bare wake phrase: padded
    // (the gate checks it together with the command, later).
    const audio = step.woke!.wake.command
      ? partsAudio(s.source, [woke])
      : (s.source?.audio(woke.startAt - PAD_MS, woke.endAt + PAD_MS) ?? null);
    if (!audio || !(await this.ownVoice(userId, cfg, audio))) return;
    this.cueHeard(
      userId,
      s,
      { startAt: woke.startAt, nameEndAt: woke.endAt, streamId: woke.streamId, confirmed: true },
      "final",
    );
  }

  /** Report a command: true if accepted, false if ignored, null if it was a duplicate. */
  private async gate(
    userId: string,
    s: UserState,
    cfg: VoiceConfig,
    c: AssembledCommand,
  ): Promise<boolean | null> {
    // Voice commands were turned off meanwhile: not sent.
    if (cfg.mode === "off") return false;
    const now = this.now();
    // Own voice, over all parts together (a short "Hey Hermes" has no embedding of its own).
    const audio = partsAudio(s.source, c.parts);
    let score: VoiceScore | null = null;
    if (audio && audio.length >= MIN_VERIFY_SAMPLES) score = await this.deps.score(userId, audio);
    if (!score || score.self === null) {
      this.report(userId, cfg, c, "ignored", "no_voiceprint", null);
      return false;
    }
    if (score.self < cfg.minScore || score.other > score.self) {
      this.report(userId, cfg, c, "ignored", "not_own_voice", score.self);
      return false;
    }
    const first = c.parts[0]!;
    if (
      first.speakerKey &&
      (await this.deps.isMediaVoice(userId, first.chainId, first.speakerKey))
    ) {
      this.report(userId, cfg, c, "ignored", "media_voice", score.self);
      return false;
    }
    // Two streams (or slots) heard the same thing: keep one, silently.
    if (
      s.recent.some(
        (r) =>
          Math.abs(r.spokenAt - c.spokenAt) <= DUPLICATE_MS &&
          textSimilarity(r.command, c.command) >= DUPLICATE_SIMILARITY,
      )
    )
      return null;
    s.recent = s.recent.filter((r) => now - r.acceptedAt < 3600_000);
    const last = s.recent.at(-1);
    const lastMinute = s.recent.filter((r) => now - r.acceptedAt < 60_000).length;
    if (
      (last && now - last.acceptedAt < COOLDOWN_MS) ||
      lastMinute >= MAX_PER_MINUTE ||
      s.recent.length >= MAX_PER_HOUR
    ) {
      this.report(userId, cfg, c, "ignored", "rate_limited", score.self);
      return false;
    }
    s.recent.push({ spokenAt: c.spokenAt, acceptedAt: now, command: c.command });
    this.report(userId, cfg, c, cfg.mode === "on" ? "pending" : "shadow", null, score.self);
    return true;
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
    source: TeachHeard["source"],
  ): Promise<void> {
    const cfg = await this.deps.config(userId);
    const align = alignTeach(text, prompt.phrase, cfg.wake);
    const wake = matchWake(text, cfg.wake);
    let ok = prompt.kind === "test" ? wake !== null : align.ok;
    let speakerScore: number | null = null;
    let embedding: number[] | null = null;
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
          embedding = await this.deps.embed(audio);
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
      embedding,
      wouldTrigger: wake !== null && speakerScore !== null && speakerScore >= cfg.minScore,
      ...(error ? { error } : {}),
    });
  }
}
