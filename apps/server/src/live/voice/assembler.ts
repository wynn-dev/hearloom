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
  maxMs: number;
  maxParts: number;
  maxChars: number;
}

export const DEFAULT_LIMITS: AssemblerLimits = {
  armMs: 8_000,
  gapMs: 2_500,
  waitMs: 4_000,
  speechAfterMs: 400,
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
 * after a part's end means its continuation hasn't come out of the recognizer yet.
 */
export class CommandAssembler {
  private state: State = { t: "idle" };

  constructor(private readonly limits: AssemblerLimits = DEFAULT_LIMITS) {}

  get busy(): boolean {
    return this.state.t !== "idle";
  }

  push(u: HeardUtterance, cfg: WakeConfig, lastSpeechAt: number, now: number): Step {
    const step: Step = { done: [], abandoned: [] };
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
        this.maybeComplete(lastSpeechAt, step);
        return step;
      }
      step.abandoned.push({ wake: s.wake, utterance: s.utterance, reason: "no_command" });
      this.state = { t: "idle" };
    } else if (s.t === "pending") {
      if (this.continues(s, u) && !matchWake(u.text, cfg)) {
        s.parts.push(u);
        s.commandParts.push(u.text.trim());
        s.at = now;
        this.maybeComplete(lastSpeechAt, step);
        return step;
      }
      this.complete(step);
    }
    this.start(u, cfg, lastSpeechAt, now, step);
    return step;
  }

  /** Time passes: give up on a missing command or continuation. */
  tick(lastSpeechAt: number, now: number): Step {
    const step: Step = { done: [], abandoned: [] };
    const s = this.state;
    if (s.t === "armed" && now > s.until) {
      step.abandoned.push({ wake: s.wake, utterance: s.utterance, reason: "no_command" });
      this.state = { t: "idle" };
    } else if (s.t === "pending") {
      if (now - s.at >= this.limits.waitMs) this.complete(step);
      else this.maybeComplete(lastSpeechAt, step);
    }
    return step;
  }

  private start(
    u: HeardUtterance,
    cfg: WakeConfig,
    lastSpeechAt: number,
    now: number,
    step: Step,
  ): void {
    const wake = matchWake(u.text, cfg);
    if (!wake) return;
    if (!wake.command) {
      this.state = { t: "armed", wake, utterance: u, until: now + this.limits.armMs };
      return;
    }
    this.state = { t: "pending", wake, parts: [u], commandParts: [wake.command], at: now };
    this.maybeComplete(lastSpeechAt, step);
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

  /** Complete unless there's speech after the last part (its continuation is on the way). */
  private maybeComplete(lastSpeechAt: number, step: Step): void {
    const s = this.state;
    if (s.t !== "pending") return;
    const last = s.parts.at(-1)!;
    const full =
      s.parts.length >= this.limits.maxParts ||
      last.endAt - s.parts[0]!.startAt >= this.limits.maxMs;
    if (full || lastSpeechAt <= last.endAt + this.limits.speechAfterMs) this.complete(step);
  }

  private complete(step: Step): void {
    const s = this.state;
    this.state = { t: "idle" };
    if (s.t !== "pending") return;
    const command = s.commandParts.join(" ").slice(0, this.limits.maxChars).trim();
    step.done.push({
      wake: s.wake,
      parts: s.parts,
      command,
      transcript: s.parts.map((p) => p.text.trim()).join(" "),
      spokenAt: s.parts[0]!.startAt,
      endedAt: s.parts.at(-1)!.endAt,
    });
  }
}
