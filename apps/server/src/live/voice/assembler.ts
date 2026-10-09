import { isGreetingOnly, matchWake, type WakeConfig, type WakeMatch } from "@hearloom/shared";
import type { LangSpan } from "../asr/types";

/** A fresh, final utterance as the command assembler sees it. */
export interface HeardUtterance {
  streamId: string;
  text: string;
  startAt: number;
  endAt: number;
  lang: string | null;
  /** The language of each stretch of `text`, when the recognizer tags words. */
  langSpans?: LangSpan[];
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
  /** The language of the command's own words (not the greeting and name), if known. */
  lang?: string | null;
}

export interface Abandoned {
  wake: WakeMatch;
  utterance: HeardUtterance;
  reason: "no_command";
}

export interface AssemblerLimits {
  /** After a bare "Hey Hermes", the command must start within this after it ended (audio time). */
  armMs: number;
  /** A continuation must start within this after the previous part ended (audio time). */
  gapMs: number;
  /**
   * Give up waiting for a continuation this long after the last part arrived, unless the user is
   * still talking. Speech counts as still going on until this much audio after it was heard (its
   * transcript may still be on the way).
   */
  waitMs: number;
  /**
   * Speech may hold a command (or a bare wake phrase) at most this much longer: voice activity
   * can be anyone, or music.
   */
  talkMs: number;
  /** Speech this long after the last part's end means a continuation is still being transcribed. */
  speechAfterMs: number;
  /**
   * A command is complete once this much audio after its end was heard without speech: a pause
   * ("call mom … at five") is a continuation, not the end.
   */
  quietMs: number;
  /** "Hey" | "Hermes, …" split in two: the greeting's utterance ended at most this long before. */
  splitGreetingMs: number;
  maxMs: number;
  maxParts: number;
  maxChars: number;
}

export const DEFAULT_LIMITS: AssemblerLimits = {
  armMs: 8_000,
  gapMs: 2_500,
  waitMs: 4_000,
  talkMs: 10_000,
  speechAfterMs: 400,
  quietMs: 2_200,
  splitGreetingMs: 500,
  maxMs: 30_000,
  maxParts: 3,
  maxChars: 500,
};

/**
 * The longest a wake phrase can wait for its command to be finished (wall clock, from when it
 * arrived): waiting for the command, then for each further part.
 */
export function longestWaitMs(l: AssemblerLimits): number {
  return l.armMs + l.talkMs + (l.maxParts - 1) * (l.waitMs + l.talkMs);
}

type State =
  | { t: "idle" }
  /** A bare wake phrase, waiting for its command (`at`: when it arrived, wall clock). */
  | { t: "armed"; wake: WakeMatch; utterance: HeardUtterance; at: number }
  | {
      t: "pending";
      wake: WakeMatch;
      parts: HeardUtterance[];
      commandParts: string[];
      /** Where the command starts in the first part's text. */
      commandStart: number;
      /** When the last part arrived (wall clock). */
      at: number;
    };

export interface Step {
  done: AssembledCommand[];
  abandoned: Abandoned[];
  /** A wake phrase that starts a command (it may be done already, or still waiting for one). */
  woke: { wake: WakeMatch; utterance: HeardUtterance } | null;
  /**
   * The utterance is only a greeting that may go on in the next one ("Hey" | "Hermes, …"): it
   * isn't known yet whether it was a wake phrase.
   */
  heldGreeting?: boolean;
}

/**
 * Turns one user's stream of fresh utterances into voice commands:
 *
 * - "Hey Hermes, call mom." → a command as soon as the user stops talking.
 * - "Hey Hermes." … "call mom." → the next utterance by the same speaker (same label, or the
 *   user's voice) that starts within `armMs` is the command. Other speakers' utterances are
 *   skipped meanwhile. (The detector checks an unlabeled voice on its own first: see
 *   `needsVoiceCheck`.)
 * - If the user is still talking when a part arrives, utterances from the same speaker that follow
 *   closely are appended (bounded by `maxMs`, `maxParts`, `maxChars`).
 * - "Hey" | "Hermes, call mom." split by the recognizer (it heard a speaker change) is one wake
 *   phrase: a line of only a greeting, not someone else's, right before the exact name.
 *
 * `lastSpeechAt` is the audio time of the latest speech the voice activity detector heard: speech
 * after a part's end means its continuation hasn't come out of the recognizer yet. `heardUntil` is
 * the audio time heard so far (Infinity: nothing more is coming, don't wait).
 */
export class CommandAssembler {
  private state: State = { t: "idle" };
  /** Per stream: its last utterance, if it ended with a greeting (and started nothing). */
  private greetings = new Map<string, HeardUtterance>();
  /** The last part of the latest finished command (to tell about speech that went on after it). */
  private finished: HeardUtterance | null = null;

  constructor(
    private readonly limits: AssemblerLimits = DEFAULT_LIMITS,
    private readonly log: (message: string) => void = () => {},
  ) {}

  get busy(): boolean {
    return this.state.t !== "idle";
  }

  /** The stream whose speech decides how long to wait (the latest part's), if waiting. */
  get streamId(): string | null {
    const s = this.state;
    if (s.t === "armed") return s.utterance.streamId;
    if (s.t === "pending") return s.parts.at(-1)!.streamId;
    return null;
  }

  /**
   * Would `u` be the command to a bare wake phrase if it were the user's voice? (Another speaker
   * label, voice unknown: the detector checks its own clip, and marks it `isSelf` if it's theirs.)
   */
  needsVoiceCheck(u: HeardUtterance, cfg: WakeConfig): boolean {
    const s = this.state;
    return (
      s.t === "armed" &&
      u.isSelf === null &&
      !this.sameSpeaker(s.utterance, u) &&
      u.startAt <= s.utterance.endAt + this.limits.armMs &&
      !matchWake(u.text, cfg)
    );
  }

  push(
    u: HeardUtterance,
    cfg: WakeConfig,
    lastSpeechAt: number,
    now: number,
    heardUntil = Number.POSITIVE_INFINITY,
  ): Step {
    const step: Step = { done: [], abandoned: [], woke: null };
    const greeting = this.greetings.get(u.streamId);
    this.greetings.delete(u.streamId);
    const wake = matchWake(u.text, cfg);
    const s = this.state;
    if (s.t === "armed" && !wake) {
      // Someone else, meanwhile: the command may still come.
      if (!this.maybeUser(s.utterance, u)) return step;
      if (u.startAt <= s.utterance.endAt + this.limits.armMs) {
        this.state = {
          t: "pending",
          wake: s.wake,
          parts: [s.utterance, u],
          commandParts: [u.text.trim()],
          commandStart: s.utterance.text.length,
          at: now,
        };
        this.maybeComplete(lastSpeechAt, heardUntil, step);
        return step;
      }
    }
    if (s.t === "armed") {
      step.abandoned.push({ wake: s.wake, utterance: s.utterance, reason: "no_command" });
      this.state = { t: "idle" };
    } else if (s.t === "pending") {
      if (!wake && this.continues(s, u)) {
        s.parts.push(u);
        s.commandParts.push(u.text.trim());
        s.at = now;
        this.maybeComplete(lastSpeechAt, heardUntil, step);
        return step;
      }
      this.complete(step);
    }
    if (wake) {
      this.start(u, wake, lastSpeechAt, heardUntil, now, step);
      return step;
    }
    const joined = greeting && this.joinGreeting(greeting, u, cfg);
    if (joined) {
      this.start(joined.utterance, joined.wake, lastSpeechAt, heardUntil, now, step);
      return step;
    }
    this.wentOn(u);
    // A greeting alone, not someone else's: its name may be in the next line.
    if (u.isSelf !== false && isGreetingOnly(u.text)) {
      this.greetings.set(u.streamId, u);
      step.heldGreeting = true;
    }
    return step;
  }

  /**
   * The audio (or the recognizer) broke off mid-speech: an open command that started before
   * `before` (audio time) is cut off.
   */
  cut(before = Number.POSITIVE_INFINITY): Step {
    const step: Step = { done: [], abandoned: [], woke: null };
    const s = this.state;
    if (s.t === "idle" || (s.t === "armed" ? s.utterance : s.parts[0]!).startAt >= before)
      return step;
    if (s.t === "armed")
      this.state = {
        t: "pending",
        wake: s.wake,
        parts: [s.utterance],
        commandParts: [],
        commandStart: s.utterance.text.length,
        at: 0,
      };
    this.complete(step, true);
    return step;
  }

  /** Time passes: give up on a missing command or continuation. */
  tick(lastSpeechAt: number, now: number, heardUntil = Number.POSITIVE_INFINITY): Step {
    const step: Step = { done: [], abandoned: [], woke: null };
    const s = this.state;
    const { armMs, waitMs, talkMs } = this.limits;
    if (s.t === "armed") {
      const deadline = s.utterance.endAt + armMs;
      const waited = now - s.at;
      const over =
        // A command may still start (by the audio heard, or by the clock if audio lags).
        (heardUntil >= deadline || waited > armMs) &&
        // Speech after the wake phrase may be the command, still being said or transcribed.
        !this.talking(s.utterance, lastSpeechAt, heardUntil);
      if (over || waited >= armMs + talkMs) {
        step.abandoned.push({ wake: s.wake, utterance: s.utterance, reason: "no_command" });
        this.state = { t: "idle" };
      }
    } else if (s.t === "pending" && !this.maybeComplete(lastSpeechAt, heardUntil, step)) {
      const waited = now - s.at;
      // Speech past the longest command can't be part of it.
      const talking =
        this.talking(s.parts.at(-1)!, lastSpeechAt, heardUntil) &&
        lastSpeechAt - s.parts[0]!.startAt < this.limits.maxMs;
      if (waited >= waitMs && (!talking || waited >= waitMs + talkMs)) this.complete(step);
    }
    return step;
  }

  private start(
    u: HeardUtterance,
    wake: WakeMatch,
    lastSpeechAt: number,
    heardUntil: number,
    now: number,
    step: Step,
  ): void {
    step.woke = { wake, utterance: u };
    // (A bare wake phrase that was cut off may have lost its command: it isn't armed.)
    if (!wake.command && !u.cutOff) {
      this.state = { t: "armed", wake, utterance: u, at: now };
      return;
    }
    this.state = {
      t: "pending",
      wake,
      parts: [u],
      commandParts: [wake.command],
      commandStart: wake.commandStart,
      at: now,
    };
    this.maybeComplete(lastSpeechAt, heardUntil, step);
  }

  /**
   * The previous utterance on the stream was only a greeting and this one goes on with the exact
   * name ("Hey" | "Hermes, call mom"): the two as one utterance, and its wake phrase. (Not
   * someone's "Hi!" and the user's "Audrey, this is Tom": a close name, someone else's greeting,
   * or a pause between them doesn't join.)
   */
  private joinGreeting(
    prev: HeardUtterance,
    u: HeardUtterance,
    cfg: WakeConfig,
  ): { utterance: HeardUtterance; wake: WakeMatch } | null {
    const gap = u.startAt - prev.endAt;
    if (gap < -this.limits.speechAfterMs || gap > this.limits.splitGreetingMs) return null;
    if (prev.isSelf === false || u.isSelf === false) return null;
    const head = prev.text.trim();
    const text = `${head} ${u.text.trim()}`;
    const wake = matchWake(text, cfg);
    // The greeting in the first one, the name in the second.
    if (!wake || wake.score < 1 || wake.start >= head.length || wake.end <= head.length)
      return null;
    const shift = head.length + 1 - (u.text.length - u.text.trimStart().length);
    const spans = [
      ...(prev.langSpans ?? []),
      ...(u.langSpans ?? []).map((l) => ({ ...l, start: l.start + shift, end: l.end + shift })),
    ];
    return {
      wake,
      utterance: {
        ...u,
        text,
        startAt: prev.startAt,
        isSelf: u.isSelf ?? prev.isSelf,
        ...(spans.length ? { langSpans: spans } : {}),
        // The greeting's line broke off: the joined one may be missing words too.
        ...(prev.cutOff || u.cutOff ? { cutOff: true } : {}),
      },
    };
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
   * Could `u` be the command to the bare wake phrase `wake`? The same speaker label, or the user's
   * own voice; never a voice known to be someone else's. (The gate scores all parts together: a
   * guest's "What?" after the user's "Hey Hermes." must not ride on the user's voice.)
   */
  private maybeUser(wake: HeardUtterance, u: HeardUtterance): boolean {
    if (u.isSelf === false) return false;
    return this.sameSpeaker(wake, u) || u.isSelf === true;
  }

  /** Was there speech after `u` whose transcript may still be on the way? */
  private talking(u: HeardUtterance, lastSpeechAt: number, heardUntil: number): boolean {
    return (
      lastSpeechAt > u.endAt + this.limits.speechAfterMs &&
      heardUntil < lastSpeechAt + this.limits.waitMs
    );
  }

  /**
   * Complete once the audio after the last part is quiet for long enough (else a continuation may
   * be on the way). True if it did.
   */
  private maybeComplete(lastSpeechAt: number, heardUntil: number, step: Step): boolean {
    const s = this.state;
    if (s.t !== "pending") return false;
    const last = s.parts.at(-1)!;
    const full =
      s.parts.length >= this.limits.maxParts ||
      last.endAt - s.parts[0]!.startAt >= this.limits.maxMs;
    const quiet =
      lastSpeechAt <= last.endAt + this.limits.speechAfterMs &&
      heardUntil >= last.endAt + this.limits.quietMs;
    // A part that was cut off ends it: nothing after it can make it whole.
    if (!full && !quiet && !last.cutOff) return false;
    this.complete(step);
    return true;
  }

  private complete(step: Step, cutOff = false): void {
    const s = this.state;
    this.state = { t: "idle" };
    if (s.t !== "pending") return;
    const command = s.commandParts.join(" ").slice(0, this.limits.maxChars).trim();
    this.finished = s.parts.at(-1)!;
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
      lang: commandLang(s.parts, s.commandStart),
    });
  }

  /**
   * Speech by the same speaker right after a finished command, without a wake phrase: it may have
   * been the rest of the command (a long pause, or past the limits). It isn't sent; say so.
   */
  private wentOn(u: HeardUtterance): void {
    const last = this.finished;
    if (!last || !this.sameSpeaker(last, u)) return;
    const gap = u.startAt - last.endAt;
    if (gap < 0 || gap > this.limits.gapMs) return;
    this.log(
      `voice: speech ${Math.round(gap)} ms after a finished command (${u.text.length} chars) wasn't part of it`,
    );
  }
}

/**
 * The language most of the command's own words are in: the first part from `from` (after the
 * greeting and name), then all of the others. Without word languages, the language of the first
 * part with command words in it.
 */
export function commandLang(parts: HeardUtterance[], from: number): string | null {
  const chars = new Map<string, number>();
  parts.forEach((p, i) => {
    for (const l of p.langSpans ?? []) {
      const n = l.end - Math.max(l.start, i === 0 ? from : 0);
      if (n > 0) chars.set(l.lang, (chars.get(l.lang) ?? 0) + n);
    }
  });
  const best = [...chars].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  const first = parts[0]!;
  return (from < first.text.trim().length ? first : (parts[1] ?? first)).lang;
}
