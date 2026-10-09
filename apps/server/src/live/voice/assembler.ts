import { matchWake, type WakeConfig, type WakeMatch } from "@hearloom/shared";

/** A fresh, final utterance as the command assembler sees it. */
export interface HeardUtterance {
  streamId: string;
  text: string;
  startAt: number;
  endAt: number;
  lang: string | null;
  /** Chain-scoped speaker key ("S2"). */
  speakerKey: string | null;
  /** From the utterance's own embedding (null: too short to tell). */
  isSelf: boolean | null;
  chainId: string;
  /** Its last words may be missing: the recognizer or the audio broke off mid-utterance. */
  cutOff?: boolean;
}

export interface AssembledCommand {
  wake: WakeMatch;
  parts: HeardUtterance[];
  /** The request: what followed the name, across parts. */
  command: string;
  /** All parts' text. */
  transcript: string;
  /** Start of the wake phrase's utterance. */
  spokenAt: number;
  /** End of the last part. */
  endedAt: number;
  /** Part of it may be missing (a part was cut off, or the audio broke off): never send it. */
  cutOff?: boolean;
}

export interface Abandoned {
  wake: WakeMatch;
  utterance: HeardUtterance;
  reason: "no_command";
}

export interface AssemblerLimits {
  /** After a bare "Hey Hermes", the next utterance must start within this (wall clock). */
  armMs: number;
  /** A continuation must start within this after the previous part ended (audio time). */
  gapMs: number;
  /** Give up waiting for a continuation this long after the last part arrived. */
  waitMs: number;
  /** Speech this long after the last part's end means a continuation is still being transcribed. */
  speechAfterMs: number;
  /**
   * A command is complete once this much audio after its end was heard without speech: a short
   * pause ("call mom … at five") is a continuation, not the end.
   */
  quietMs: number;
  maxMs: number;
  maxParts: number;
  maxChars: number;
}

export const DEFAULT_LIMITS: AssemblerLimits = {
  armMs: 8_000,
  gapMs: 2_500,
  waitMs: 4_000,
  speechAfterMs: 400,
  quietMs: 1_200,
  maxMs: 30_000,
  maxParts: 3,
  maxChars: 500,
};

type State =
  | { t: "idle" }
  | { t: "armed"; wake: WakeMatch; utterance: HeardUtterance; until: number }
  | { t: "pending"; wake: WakeMatch; parts: HeardUtterance[]; commandParts: string[]; at: number };

export interface Step {
  done: AssembledCommand[];
  abandoned: Abandoned[];
  /** A wake phrase that starts a command (it may be done already, or still waiting for one). */
  woke: { wake: WakeMatch; utterance: HeardUtterance } | null;
}

/**
 * Turns one user's stream of fresh utterances into voice commands:
 *
 * - "Hey Hermes, call mom." → a command as soon as the user stops talking.
 * - "Hey Hermes." … "call mom." → the next utterance by the same speaker (within `armMs`) is the
 *   command.
 * - If the user is still talking when a part arrives, utterances from the same speaker that follow
 *   closely are appended (bounded by `maxMs`, `maxParts`, `maxChars`).
 *
 * `lastSpeechAt` is the audio time of the latest speech the voice activity detector heard: speech
 * after a part's end means its continuation hasn't come out of the recognizer yet. `heardUntil` is
 * the audio time heard so far (Infinity: don't wait for quiet).
 */
export class CommandAssembler {
  private state: State = { t: "idle" };

  constructor(private readonly limits: AssemblerLimits = DEFAULT_LIMITS) {}

  get busy(): boolean {
    return this.state.t !== "idle";
  }

  push(
    u: HeardUtterance,
    cfg: WakeConfig,
    lastSpeechAt: number,
    now: number,
    heardUntil = Number.POSITIVE_INFINITY,
  ): Step {
    const step: Step = { done: [], abandoned: [], woke: null };
    const s = this.state;
    if (s.t === "armed") {
      if (now <= s.until && this.sameSpeaker(s.utterance, u) && !matchWake(u.text, cfg)) {
        this.state = {
          t: "pending",
          wake: s.wake,
          parts: [s.utterance, u],
          commandParts: [u.text.trim()],
          at: now,
        };
        this.maybeComplete(lastSpeechAt, heardUntil, step);
        return step;
      }
      step.abandoned.push({ wake: s.wake, utterance: s.utterance, reason: "no_command" });
      this.state = { t: "idle" };
    } else if (s.t === "pending") {
      if (this.continues(s, u) && !matchWake(u.text, cfg)) {
        s.parts.push(u);
        s.commandParts.push(u.text.trim());
        s.at = now;
        this.maybeComplete(lastSpeechAt, heardUntil, step);
        return step;
      }
      this.complete(step);
    }
    this.start(u, cfg, lastSpeechAt, heardUntil, now, step);
    return step;
  }

  /** The audio broke off mid-speech and didn't come back: an open command is cut off. */
  cut(): Step {
    const step: Step = { done: [], abandoned: [], woke: null };
    const s = this.state;
    if (s.t === "armed")
      this.state = { t: "pending", wake: s.wake, parts: [s.utterance], commandParts: [], at: 0 };
    this.complete(step, true);
    return step;
  }

  /** Time passes: give up on a missing command or continuation. */
  tick(lastSpeechAt: number, now: number, heardUntil = Number.POSITIVE_INFINITY): Step {
    const step: Step = { done: [], abandoned: [], woke: null };
    const s = this.state;
    if (s.t === "armed" && now > s.until) {
      step.abandoned.push({ wake: s.wake, utterance: s.utterance, reason: "no_command" });
      this.state = { t: "idle" };
    } else if (s.t === "pending") {
      if (now - s.at >= this.limits.waitMs) this.complete(step);
      else this.maybeComplete(lastSpeechAt, heardUntil, step);
    }
    return step;
  }

  private start(
    u: HeardUtterance,
    cfg: WakeConfig,
    lastSpeechAt: number,
    heardUntil: number,
    now: number,
    step: Step,
  ): void {
    const wake = matchWake(u.text, cfg);
    if (!wake) return;
    step.woke = { wake, utterance: u };
    // (A bare wake phrase that was cut off may have lost its command: it isn't armed.)
    if (!wake.command && !u.cutOff) {
      this.state = { t: "armed", wake, utterance: u, until: now + this.limits.armMs };
      return;
    }
    this.state = { t: "pending", wake, parts: [u], commandParts: [wake.command], at: now };
    this.maybeComplete(lastSpeechAt, heardUntil, step);
  }

  private continues(s: Extract<State, { t: "pending" }>, u: HeardUtterance): boolean {
    const last = s.parts.at(-1)!;
    const chars = s.commandParts.reduce((n, p) => n + p.length + 1, 0) + u.text.length;
    return (
      this.sameSpeaker(last, u) &&
      u.startAt - last.endAt <= this.limits.gapMs &&
      u.endAt - s.parts[0]!.startAt <= this.limits.maxMs &&
      s.parts.length < this.limits.maxParts &&
      chars <= this.limits.maxChars
    );
  }

  private sameSpeaker(a: HeardUtterance, b: HeardUtterance): boolean {
    if (a.isSelf && b.isSelf) return true;
    return a.chainId === b.chainId && a.speakerKey !== null && a.speakerKey === b.speakerKey;
  }

  /**
   * Complete once the audio after the last part is quiet for long enough (else a continuation may
   * be on the way).
   */
  private maybeComplete(lastSpeechAt: number, heardUntil: number, step: Step): void {
    const s = this.state;
    if (s.t !== "pending") return;
    const last = s.parts.at(-1)!;
    const full =
      s.parts.length >= this.limits.maxParts ||
      last.endAt - s.parts[0]!.startAt >= this.limits.maxMs;
    const quiet =
      lastSpeechAt <= last.endAt + this.limits.speechAfterMs &&
      heardUntil >= last.endAt + this.limits.quietMs;
    // A part that was cut off ends it: nothing after it can make it whole.
    if (full || quiet || last.cutOff) this.complete(step);
  }

  private complete(step: Step, cutOff = false): void {
    const s = this.state;
    this.state = { t: "idle" };
    if (s.t !== "pending") return;
    const command = s.commandParts.join(" ").slice(0, this.limits.maxChars).trim();
    step.done.push({
      wake: s.wake,
      parts: s.parts,
      command,
      transcript: s.parts
        .map((p) => p.text.trim())
        .join(" ")
        .slice(0, 2 * this.limits.maxChars),
      spokenAt: s.parts[0]!.startAt,
      endedAt: s.parts.at(-1)!.endAt,
      ...(cutOff || s.parts.some((p) => p.cutOff) ? { cutOff: true } : {}),
    });
  }
}
