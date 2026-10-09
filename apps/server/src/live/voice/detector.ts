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
 * The lowest own-voice bar a command can ever need. Below it a voice is clearly not the user's
 * (people on file score at most ~0.31 against them); from it up to the bar, a command is a near
 * miss: probably theirs, but too short or noisy to be sure.
 */
export const THRESHOLD_FLOOR = 0.45;

/**
 * Teaching samples at most this long are like commands (the gate scores padded clips of 1.5–3 s):
 * the bar is tuned on them when there are enough, as long clips score higher than short ones.
 */
export const COMMAND_LIKE_SECONDS = 2.5;

/**
 * Own-voice threshold from the similarity of the user's teaching samples to their voice: a bit
 * under the low end of what their real voice scores on command-length clips, within sane bounds.
 */
export function commandThreshold(samples: { score: number; seconds: number }[]): number {
  // A clip taught twice scores ~1 against its own voiceprint: it says nothing about the voice.
  const valid = samples.filter((s) => Number.isFinite(s.score) && s.score < DUPLICATE_PRINT);
  const short = valid.filter((s) => s.seconds > 0 && s.seconds <= COMMAND_LIKE_SECONDS);
  const scores = (short.length >= 3 ? short : valid).map((s) => s.score).sort((a, b) => a - b);
  if (scores.length < 3) return DEFAULT_MIN_SCORE;
  const p20 = scores[Math.floor((scores.length - 1) * 0.2)]!;
  return Math.min(0.75, Math.max(THRESHOLD_FLOOR, p20 - 0.05));
}

/** Where a user's utterances come from (one stream processor). */
export interface AudioSource {
  streamId: string;
  /** 16 kHz audio between two absolute times, if still retained. */
  audio(from: number, to: number): Float32Array | null;
  /** Audio time of the latest speech heard on this stream. */
  lastSpeechAt(): number;
  /** Audio time of the end of the audio heard so far. */
  heardUntil(): number;
  /**
   * The audio stopped arriving mid-speech: "waiting" for it to resume, or "cut" (given up: what was
   * being said is cut off). null: no stall.
   */
  stall?(): "waiting" | "cut" | null;
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

/** Commands need at least this much (padded) audio for the own-voice check. */
const MIN_VERIFY_SAMPLES = 12_800; // 0.8 s
/** A teaching sample becomes a voiceprint only if it's this long (short ones would blur matching). */
export const MIN_PRINT_SAMPLES = 24_000; // 1.5 s
/** Speech is scored with this much audio around it (as teaching samples are: alike clips). */
export const PAD_MS = 250;
/**
 * For calibration, a near miss is also scored after up to this much of the user's recent speech
 * from the same stream (speech already recognized as theirs), and logged. Never used to decide:
 * the user's speech would lift anyone's command over the bar.
 */
const PRIOR_OWN_MS = 3_000;
/** …speech that ended at most this long before the command (still in the stream's audio). */
const PRIOR_OWN_MAX_AGE_MS = 90_000;
/** Accepted commands: at least this far apart, at most so many per minute / hour. */
const COOLDOWN_MS = 2_000;
const MAX_PER_MINUTE = 6;
const MAX_PER_HOUR = 30;
/** The same speech captured by two streams: start within this, text this similar. */
const DUPLICATE_MS = 1_500;
const DUPLICATE_SIMILARITY = 0.8;
/**
 * A failed cue for a command that wasn't tapped is held this long (to the next tick after it):
 * another stream's copy of the same words, a moment behind, may still be accepted.
 */
export const FAIL_HOLD_MS = DUPLICATE_MS;
/** Transcripts sent to the agent are capped (the command itself at 500 by the assembler). */
export const MAX_TRANSCRIPT_CHARS = 1_000;
/**
 * A teaching sample must be at least this close to the user's voice (once there is one): never
 * below the lowest bar a command could need, so learned samples can't pull the threshold under it.
 * Teaching clips are long and said with care: stricter than that bar.
 */
export const TEACH_MIN_SELF = 0.55;
/** Before the user has a voiceprint: a sample this close to someone else's is theirs, not the user's. */
const TEACH_OTHER_MATCH = 0.6;
/** A clip this close to one of the user's voiceprints is already learned (the same audio again). */
export const DUPLICATE_PRINT = 0.98;

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
 * May a clip of a second or more the user says is their own voice ("This is me", 👍, Missed)
 * become one of their voiceprints? The first one may (unless it's clearly someone else on file);
 * later ones must sound like the voice learned so far (an outlier loosens the gate for everyone)
 * and not copy a voiceprint already learned (the same clip learned twice). "Sound like" is the
 * command bar, but never stricter than teaching's: with few samples the bar is a cautious default,
 * and a long clip scores at least as well as a command.
 */
export function selfPrintVerdict(score: VoiceScore, minScore: number): string | null {
  if (score.self === null)
    return score.other >= TEACH_OTHER_MATCH
      ? "That sounded like someone else you've named, not you."
      : null;
  if (score.self >= DUPLICATE_PRINT) return "Already learned from this clip.";
  return logLearnVerdict(score, Math.min(minScore, TEACH_MIN_SELF));
}

/**
 * After a teaching session stops, speech that started up to this long after is still treated as
 * teaching: the recognizer finalizes the last phrase a second or two after it's said, and it must
 * not become a command.
 */
export const TEACH_GRACE_MS = 10_000;

function concat(pieces: Float32Array[]): Float32Array {
  const out = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pieces) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A stretch of speech on one stream. */
type Spoken = { streamId: string; startAt: number; endAt: number };

/**
 * The own-voice check's verdict on a clip:
 * - own: the user's voice (at least the bar, and closer to them than to anyone else on file);
 * - near: probably theirs but not sure enough to send (at least the floor, closer to them);
 * - other: someone else;
 * - unchecked: no clip to check, or nothing to check it against.
 */
type Verdict =
  | { kind: "own" | "near" | "other"; score: number }
  | { kind: "unchecked"; reason: "no_voiceprint" | "clip_missing" | "clip_too_short" };

/** Why a command wasn't sent, and whether to tell it (failed buzz) even without a heard tap. */
type GateResult = { sent: boolean | null; tell: boolean };

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
  /** The stream of the latest utterance (whether more speech is coming). */
  source: AudioSource | null;
  /** Every live stream of the user, by id: each utterance's audio comes from its own stream. */
  sources: Map<string, AudioSource>;
  /** Recent speech recognized as the user's (newest last), to score a near miss with. */
  own: Spoken[];
  teach: TeachPrompt | null;
  /** Speech starting before this (ms) is still teaching (the session just stopped). */
  teachGraceUntil: number;
  /** Accepted (sent or shadow) commands, newest last, for dedupe and rate limits. */
  recent: { spokenAt: number; acceptedAt: number; command: string }[];
  /** Buzzed wake phrases whose outcome hasn't been told yet. */
  cues: Cue[];
  /** Wake phrases whose outcome was told, recently (`at`: when). */
  told: (Span & { at: number })[];
  /** Failed cues waiting to be told (`at`: since when), see tellFailed. */
  heldFails: (Span & { at: number })[];
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
        sources: new Map(),
        own: [],
        teach: null,
        teachGraceUntil: 0,
        recent: [],
        cues: [],
        told: [],
        heldFails: [],
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
      s.sources.delete(streamId);
      s.own = s.own.filter((o) => o.streamId !== streamId);
      s.partials.delete(streamId);
      s.partialDecided.delete(streamId);
      s.recent = s.recent.filter((r) => now - r.acceptedAt < USER_IDLE_MS);
      if (
        !s.source &&
        s.sources.size === 0 &&
        !s.teach &&
        !s.assembler.busy &&
        s.recent.length === 0 &&
        s.cues.length === 0 &&
        s.heldFails.length === 0 &&
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
    s.sources.set(source.streamId, source);
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
    const verdict = await this.judge(userId, cfg, audio);
    // Only a sure one taps this early: a near miss is told by the gate, once it's decided.
    if (verdict.kind !== "own") return;
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

  /**
   * The audio of utterances, each from its own stream (a command can span a reconnect), padded
   * like teaching samples: null if none of it is retained.
   */
  private clip(s: UserState, parts: Spoken[]): Float32Array | null {
    const pieces: Float32Array[] = [];
    let prev: Spoken | null = null;
    for (const p of parts) {
      // Padding doesn't take the previous part's audio twice.
      const from =
        prev?.streamId === p.streamId
          ? Math.max(p.startAt - PAD_MS, prev.endAt + PAD_MS)
          : p.startAt - PAD_MS;
      const a = s.sources.get(p.streamId)?.audio(from, p.endAt + PAD_MS);
      if (a && a.length > 0) pieces.push(a);
      prev = p;
    }
    return pieces.length > 0 ? concat(pieces) : null;
  }

  /** The user's own speech that ended shortly before `at` on its stream: up to PRIOR_OWN_MS of it. */
  private priorOwn(s: UserState, at: Spoken): Float32Array | null {
    const source = s.sources.get(at.streamId);
    if (!source) return null;
    const pieces: Float32Array[] = [];
    let ms = 0;
    for (let i = s.own.length - 1; i >= 0 && ms < PRIOR_OWN_MS; i--) {
      const o = s.own[i]!;
      if (o.streamId !== at.streamId || o.endAt > at.startAt) continue;
      if (at.startAt - o.endAt > PRIOR_OWN_MAX_AGE_MS) break;
      const from = Math.max(o.startAt, o.endAt - (PRIOR_OWN_MS - ms));
      const a = source.audio(from, o.endAt);
      if (!a || a.length === 0) continue;
      pieces.unshift(a);
      ms += a.length / 16;
    }
    return pieces.length > 0 ? concat(pieces) : null;
  }

  /**
   * Is this clip the user's own voice? Only the clip itself decides: nothing else (not even the
   * user's own speech just before it) can carry someone else's command over the bar.
   */
  private async judge(
    userId: string,
    cfg: VoiceConfig,
    audio: Float32Array | null,
  ): Promise<Verdict> {
    if (!audio) return { kind: "unchecked", reason: "clip_missing" };
    if (audio.length < MIN_VERIFY_SAMPLES) return { kind: "unchecked", reason: "clip_too_short" };
    const score = await this.deps.score(userId, audio);
    if (!score || score.self === null) return { kind: "unchecked", reason: "no_voiceprint" };
    const bar = cfg.minScore;
    if (score.other > score.self || score.self < Math.min(THRESHOLD_FLOOR, bar))
      return { kind: "other", score: score.self };
    if (score.self >= bar) return { kind: "own", score: score.self };
    return { kind: "near", score: score.self };
  }

  /**
   * For calibration only (it never decides anything: whoever said the command, the user's own
   * speech would lift it): log how a near miss scores after the user's recent speech from the
   * same stream.
   */
  private async logWithPrior(
    userId: string,
    s: UserState,
    audio: Float32Array,
    at: Spoken,
    score: number,
  ): Promise<void> {
    const prior = this.priorOwn(s, at);
    if (!prior) return;
    const longer = await this.deps.score(userId, concat([prior, audio]));
    if (longer?.self == null) return;
    this.deps.log(
      `voice: near miss ${score.toFixed(2)}; with ${Math.round(prior.length / 16)} ms of the user's earlier speech ${longer.self.toFixed(2)} (other ${longer.other.toFixed(2)}): not used`,
    );
  }

  private cueHeard(
    userId: string,
    s: UserState,
    c: Omit<Cue, "at" | "seenAt">,
    via: "partial" | "final",
  ): void {
    // Broken timings: a span nothing could ever be matched against.
    if (c.nameEndAt <= c.startAt) return;
    const at = this.now();
    s.cues.push({ ...c, at, seenAt: at });
    this.deps.log(
      `voice: wake phrase heard (${via}) ${at - c.nameEndAt} ms after the ${via === "partial" ? "name" : "utterance"} ended`,
    );
    this.deps.cue({ userId, cue: "heard", nameEndAt: c.nameEndAt, via, at });
  }

  /** Tell the outcome of the cued wake phrase in this utterance, if there is one (true if so). */
  private cueOutcome(
    userId: string,
    s: UserState,
    u: { startAt: number; endAt: number },
    cue: "no_command" | "failed" | null,
  ): boolean {
    const i = s.cues.findIndex((c) => covers(u, c));
    if (i < 0) return false;
    const [c] = s.cues.splice(i, 1);
    this.markTold(s, { startAt: c!.startAt, nameEndAt: c!.nameEndAt });
    if (cue) this.deps.cue({ userId, cue, nameEndAt: null, via: null, at: this.now() });
    return true;
  }

  private markTold(s: UserState, span: Span): void {
    const now = this.now();
    s.told = s.told.filter((t) => now - t.at < TOLD_MS);
    s.told.push({ ...span, at: now });
  }

  /**
   * A command that wasn't tapped as heard failed in a way the user must hear about (most likely
   * their own voice, just not sure enough; or the check broke): three taps, once. Held for a
   * moment (see tick): another stream may still accept its own copy of the same words, and then
   * the user mustn't be told to say it again.
   */
  private tellFailed(s: UserState, cfg: VoiceConfig, u: Spoken): void {
    if (cfg.mode !== "on" || !cfg.haptics) return;
    const span = { startAt: u.startAt, nameEndAt: u.endAt };
    const asSpan = { startAt: span.startAt, endAt: span.nameEndAt };
    // Another stream's copy of the same words was told (or is waiting to be) already.
    if (
      span.nameEndAt <= span.startAt ||
      this.told(s, span) ||
      s.heldFails.some((h) => covers(asSpan, h))
    )
      return;
    s.heldFails.push({ ...span, at: this.now() });
  }

  /** Failed cues held long enough: told, unless the words were told meanwhile (accepted). */
  private flushFails(userId: string, s: UserState): void {
    const now = this.now();
    const due = s.heldFails.filter((h) => now - h.at >= FAIL_HOLD_MS);
    if (due.length === 0) return;
    s.heldFails = s.heldFails.filter((h) => now - h.at < FAIL_HOLD_MS);
    for (const h of due) {
      if (this.told(s, h)) continue;
      this.markTold(s, h);
      this.deps.cue({ userId, cue: "failed", nameEndAt: null, via: null, at: now });
    }
  }

  private async heardNow(
    userId: string,
    s: UserState,
    u: HeardUtterance,
    source: AudioSource,
  ): Promise<void> {
    s.source = source;
    s.sources.set(source.streamId, source);
    if (u.isSelf) {
      s.own = s.own.filter((o) => u.startAt - o.endAt < PRIOR_OWN_MAX_AGE_MS).slice(-20);
      s.own.push({ streamId: source.streamId, startAt: u.startAt, endAt: u.endAt });
    }
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
    if (step.done.length === 0 && !s.assembler.busy) await this.nearMiss(userId, s, u, cfg);
  }

  /** Once a second: finish commands whose continuation didn't come. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const [userId, s] of this.users) {
      this.flushFails(userId, s);
      // A wake phrase in the running transcript that no finished utterance had.
      for (const c of [...s.cues]) {
        const span = { startAt: c.startAt, endAt: c.nameEndAt };
        if (!c.confirmed && now - c.seenAt > CUE_CONFIRM_MS)
          this.cueOutcome(userId, s, span, "no_command");
        else if (now - c.at > CUE_MAX_MS) this.cueOutcome(userId, s, span, "failed");
      }
      if (!s.assembler.busy) continue;
      const stall = s.source?.stall?.() ?? null;
      // The rest of what's being said may still come.
      if (stall === "waiting") continue;
      // Without a stream (it ended), nothing more is coming: finish now.
      const step =
        stall === "cut"
          ? s.assembler.cut()
          : s.source
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
    let r: GateResult;
    try {
      r = await this.gate(userId, s, cfg, c);
    } catch (err) {
      // The check itself broke (speaker model, database): not sent, and the user is told.
      this.deps.log(`voice: own-voice check failed: ${err}`);
      this.report(userId, cfg, c, "ignored", "check_error", null);
      r = { sent: false, tell: true };
    }
    // Sent: the server tells how the delivery went.
    const first = c.parts[0]!;
    const cued = this.cueOutcome(userId, s, first, r.sent === false ? "failed" : null);
    if (!cued && r.tell) this.tellFailed(s, cfg, first);
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
    // The audio the gate checks when the command is in it (a bare wake phrase: the gate checks it
    // together with the command, later). Only a sure one taps: a near miss is told by the gate.
    let verdict: Verdict;
    try {
      verdict = await this.judge(userId, cfg, this.clip(s, [woke]));
    } catch (err) {
      this.deps.log(`voice: own-voice check failed: ${err}`);
      return;
    }
    if (verdict.kind !== "own") return;
    this.cueHeard(
      userId,
      s,
      { startAt: woke.startAt, nameEndAt: woke.endAt, streamId: woke.streamId, confirmed: true },
      "final",
    );
  }

  /**
   * Report a command: sent true if accepted, false if ignored, null if it was a duplicate; `tell`:
   * say it failed even if it wasn't tapped as heard.
   */
  private async gate(
    userId: string,
    s: UserState,
    cfg: VoiceConfig,
    c: AssembledCommand,
  ): Promise<GateResult> {
    const no = { sent: false, tell: false };
    // Voice commands were turned off meanwhile: not sent.
    if (cfg.mode === "off") return no;
    const now = this.now();
    const first = c.parts[0]!;
    // Two streams (or slots) heard the same thing, and one copy was accepted: keep that one,
    // silently, whatever this copy's voice check would say (its audio may be worse).
    if (
      s.recent.some(
        (r) =>
          Math.abs(r.spokenAt - c.spokenAt) <= DUPLICATE_MS &&
          textSimilarity(r.command, c.command) >= DUPLICATE_SIMILARITY,
      )
    )
      return { sent: null, tell: false };
    // Own voice, over all parts together (a short "Hey Hermes" has no embedding of its own).
    const audio = this.clip(s, c.parts);
    const verdict = await this.judge(userId, cfg, audio);
    if (verdict.kind === "unchecked") {
      this.report(userId, cfg, c, "ignored", verdict.reason, null);
      return no;
    }
    if (verdict.kind !== "own") {
      this.report(userId, cfg, c, "ignored", "not_own_voice", verdict.score);
      if (verdict.kind === "near" && audio)
        await this.logWithPrior(userId, s, audio, first, verdict.score).catch((err) =>
          this.deps.log(`voice: ${err}`),
        );
      // Someone else stays silent; the user's own voice, not sure enough, is told.
      return { sent: false, tell: verdict.kind === "near" };
    }
    const score = { self: verdict.score };
    if (
      first.speakerKey &&
      (await this.deps.isMediaVoice(userId, first.chainId, first.speakerKey))
    ) {
      this.report(userId, cfg, c, "ignored", "media_voice", score.self);
      return no;
    }
    // Part of it may be missing (the recognizer or the audio broke off): never sent, and told.
    if (c.cutOff) {
      this.report(userId, cfg, c, "ignored", "cut_off", score.self);
      return { sent: false, tell: true };
    }
    s.recent = s.recent.filter((r) => now - r.acceptedAt < 3600_000);
    const last = s.recent.at(-1);
    const lastMinute = s.recent.filter((r) => now - r.acceptedAt < 60_000).length;
    if (
      (last && now - last.acceptedAt < COOLDOWN_MS) ||
      lastMinute >= MAX_PER_MINUTE ||
      s.recent.length >= MAX_PER_HOUR
    ) {
      this.report(userId, cfg, c, "ignored", "rate_limited", score.self);
      return no;
    }
    s.recent.push({ spokenAt: c.spokenAt, acceptedAt: now, command: c.command });
    // Its words are told (by the server, once delivered): another stream's copy isn't, either way.
    this.markTold(s, { startAt: first.startAt, nameEndAt: first.endAt });
    this.report(userId, cfg, c, cfg.mode === "on" ? "pending" : "shadow", null, score.self);
    return { sent: true, tell: false };
  }

  /**
   * The user said a greeting and something name-like that didn't match: maybe a missed command.
   * Logged when it sounds like them (at least the floor), whether or not the transcript line was
   * tagged as theirs (a bare "Hey Adri" is too short to be tagged).
   */
  private async nearMiss(
    userId: string,
    s: UserState,
    u: HeardUtterance,
    cfg: VoiceConfig,
  ): Promise<void> {
    const wake = nearWake(u.text, cfg.wake);
    if (!wake) return;
    let verdict: Verdict | null = null;
    try {
      verdict = await this.judge(userId, cfg, this.clip(s, [u]));
    } catch (err) {
      this.deps.log(`voice: own-voice check failed: ${err}`);
    }
    const score = verdict && verdict.kind !== "unchecked" ? verdict.score : null;
    const theirs = verdict?.kind === "own" || verdict?.kind === "near";
    if (!theirs && !u.isSelf) return;
    const c = {
      parts: [u],
      wake,
      command: wake.command,
      transcript: u.text,
      spokenAt: u.startAt,
      endedAt: u.endAt,
    };
    this.report(userId, cfg, c, "ignored", "near_miss", score);
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
      } else if (
        prompt.kind === "sample" &&
        audio &&
        audio.length >= MIN_PRINT_SAMPLES &&
        // The same clip again (a repeated upload): a sample, but not a second voiceprint.
        (score?.self ?? 0) < DUPLICATE_PRINT
      ) {
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
