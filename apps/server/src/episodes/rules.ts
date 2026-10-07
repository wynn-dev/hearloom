/**
 * Rule-based episode segmentation: what kind of speech is this (a conversation, a talk, TV…), and
 * where does one kind of thing end and the next begin. Pure functions, shared by the live pipeline
 * and by the offline pass over backlog. The agent and the user can override what these decide.
 */
import type { EpisodeKind } from "@hearloom/shared";

/** Speech-context AudioSet classes (CED tagger) that help tell kinds of speech apart. */
export const CONTEXT_CLASSES = {
  conversation: ["Conversation"],
  narration: ["Narration, monologue"],
  babble: ["Hubbub, speech noise, speech babble", "Chatter", "Crowd"],
  tv: ["Television"],
  radio: ["Radio"],
  music: ["Music", "Background music", "Theme music", "Soundtrack music"],
  laughter: ["Laughter"],
  applause: ["Applause", "Cheering"],
  synth: ["Speech synthesizer"],
  telephone: ["Telephone"],
} as const;
export type ContextClass = keyof typeof CONTEXT_CLASSES;
export type ContextScores = Record<ContextClass, number>;
const CLASS_NAMES = Object.keys(CONTEXT_CLASSES) as ContextClass[];

/** Context scores of one tagged window (top-K tags; a class not in them scores 0). */
export function contextScores(tags: { name: string; prob: number }[]): ContextScores {
  const out = Object.fromEntries(CLASS_NAMES.map((c) => [c, 0])) as ContextScores;
  for (const c of CLASS_NAMES) {
    const names: readonly string[] = CONTEXT_CLASSES[c];
    for (const t of tags) if (names.includes(t.name)) out[c] = Math.max(out[c], t.prob);
  }
  return out;
}

export const MINUTE = 60_000;

/** Mean context scores per minute (what context_samples stores). */
export interface ContextMinute {
  /** Start of the minute (unix ms). */
  at: number;
  windows: number;
  scores: Partial<ContextScores>;
}

/** Averages tagged windows into minutes; finished minutes are taken out with `drain`. */
export class ContextMinutes {
  private open = new Map<number, { windows: number; sums: ContextScores }>();

  add(windowStart: number, windowEnd: number, scores: ContextScores): void {
    const at = Math.floor((windowStart + windowEnd) / 2 / MINUTE) * MINUTE;
    let m = this.open.get(at);
    if (!m) {
      m = { windows: 0, sums: Object.fromEntries(CLASS_NAMES.map((c) => [c, 0])) as ContextScores };
      this.open.set(at, m);
    }
    m.windows++;
    for (const c of CLASS_NAMES) m.sums[c] += scores[c];
  }

  /** Minutes that started before `before` (all of them without it). */
  drain(before = Number.POSITIVE_INFINITY): ContextMinute[] {
    const out: ContextMinute[] = [];
    for (const [at, m] of [...this.open].sort((a, b) => a[0] - b[0])) {
      if (at + MINUTE > before) continue;
      this.open.delete(at);
      const scores: Partial<ContextScores> = {};
      for (const c of CLASS_NAMES) {
        const mean = m.sums[c] / m.windows;
        if (mean >= 0.005) scores[c] = Math.round(mean * 1000) / 1000;
      }
      out.push({ at, windows: m.windows, scores });
    }
    return out;
  }
}

/** One utterance, as the classifier sees it. */
export interface SpeechSpan {
  startAt: number;
  endAt: number;
  /** Person id or speaker key; null if unknown. */
  speaker: string | null;
  /** The user's own voice (null: not identified). */
  isWearer: boolean | null;
}

export interface WindowFeatures {
  speechMs: number;
  wearerMs: number;
  /** Speech of each other speaker (ms), longest first. */
  others: number[];
  otherMs: number;
  /** Speaker changes per minute of speech. */
  turnsPerMin: number;
  /** Mean context scores over the window's tagged minutes. */
  context: ContextScores;
}

export function windowFeatures(
  speech: SpeechSpan[],
  context: ContextMinute[],
  from: number,
  to: number,
): WindowFeatures {
  const inWindow = speech
    .filter((s) => s.endAt > from && s.startAt < to)
    .sort((a, b) => a.startAt - b.startAt);
  let speechMs = 0;
  let wearerMs = 0;
  const others = new Map<string, number>();
  let turns = 0;
  let last: string | null | undefined;
  for (const s of inWindow) {
    const ms = Math.max(0, Math.min(to, s.endAt) - Math.max(from, s.startAt));
    speechMs += ms;
    const who = s.isWearer ? "me" : (s.speaker ?? "?");
    if (s.isWearer) wearerMs += ms;
    else others.set(who, (others.get(who) ?? 0) + ms);
    if (last !== undefined && who !== last) turns++;
    last = who;
  }
  const minutes = context.filter((m) => m.at + MINUTE > from && m.at < to && m.windows > 0);
  const total = minutes.reduce((n, m) => n + m.windows, 0);
  const ctx = Object.fromEntries(
    CLASS_NAMES.map((c) => [
      c,
      total ? minutes.reduce((sum, m) => sum + (m.scores[c] ?? 0) * m.windows, 0) / total : 0,
    ]),
  ) as ContextScores;
  const otherList = [...others.values()].sort((a, b) => b - a);
  return {
    speechMs,
    wearerMs,
    others: otherList,
    otherMs: otherList.reduce((a, b) => a + b, 0),
    turnsPerMin: speechMs ? turns / (speechMs / MINUTE) : 0,
    context: ctx,
  };
}

/** Less speech than this in a window says nothing about its kind. */
const MIN_SPEECH_MS = 15_000;

/**
 * The kind of speech in a window, or null if there's too little to tell. `selfKnown`: the user has
 * an enrolled voice, so their own speech can be told apart; without it, speech that isn't clearly
 * media or a talk counts as a conversation (which holds notifications, as before episodes).
 */
export function classify(f: WindowFeatures, selfKnown: boolean): EpisodeKind | null {
  if (f.speechMs < MIN_SPEECH_MS) return null;
  const c = f.context;
  const broadcast = Math.max(c.tv, c.radio);
  const audience = Math.max(c.laughter, c.applause, c.music);
  const wearer = f.wearerMs / f.speechMs;
  const dominant = f.otherMs > 0 ? f.others[0]! / f.otherMs : 0;
  const voices = f.others.filter((ms) => ms >= 5_000).length;
  // Talking with someone wins over whatever plays in the background.
  if (selfKnown && wearer >= 0.2 && f.otherMs >= 0.1 * f.speechMs) return "conversation";
  if (broadcast >= 0.2) return "media";
  if (selfKnown) {
    if (wearer >= 0.85) return "solo";
    if (wearer >= 0.1) return "conversation";
    if (voices >= 3 && audience >= 0.15) return "media";
    if (dominant >= 0.7 && f.turnsPerMin <= 6) return "talk";
    return "ambient";
  }
  if (voices >= 3 && audience >= 0.15 && dominant < 0.6) return "media";
  if (dominant >= 0.85 && f.turnsPerMin <= 3 && c.narration >= 0.05) return "talk";
  return "conversation";
}

/** Each step classifies the last WINDOW_MS. */
export const WINDOW_MS = 2 * MINUTE;
/** Steps in a row that must agree on a new kind before it counts (≈ 3 minutes of it). */
const CONFIRM = 2;
/** A rule-classified episode younger than this is re-labelled rather than split. */
const YOUNG_MS = 5 * MINUTE;
/** Shortest episode a cut may leave behind; a change closer to the start re-labels instead. */
export const MIN_EPISODE_MS = MINUTE;

export type SegmentAction =
  | { type: "kind"; kind: EpisodeKind }
  /** A new episode of `kind` starts at the pause that fits best in [from, to]. */
  | { type: "cut"; kind: EpisodeKind; from: number; to: number };

/**
 * Hysteresis over per-minute classifications of one open episode. A new kind has to persist for
 * CONFIRM steps; then a young or still-unknown episode is re-labelled, an older one is cut.
 * `kind` is what the rules think the episode is (a kind someone set by hand is the caller's
 * business: re-labelling it by hand mustn't look like a change of what's heard).
 */
export class Segmenter {
  private pending: { kind: EpisodeKind; since: number; count: number } | null = null;

  constructor(
    /** Start of the open episode (move it when a cut lands elsewhere than `from`). */
    public startedAt: number,
    public kind: EpisodeKind = "unknown",
  ) {}

  step(at: number, kind: EpisodeKind | null): SegmentAction | null {
    if (kind === null || kind === this.kind) {
      this.pending = null;
      return null;
    }
    if (this.kind === "unknown") {
      this.kind = kind;
      return { type: "kind", kind };
    }
    if (this.pending?.kind === kind) this.pending.count++;
    else this.pending = { kind, since: at, count: 1 };
    if (this.pending.count < CONFIRM) return null;
    const { since } = this.pending;
    this.pending = null;
    if (at - this.startedAt < YOUNG_MS) {
      this.kind = kind;
      return { type: "kind", kind };
    }
    // The change began within the first window that saw the new kind.
    const from = Math.max(this.startedAt, since - WINDOW_MS);
    this.startedAt = from;
    this.kind = kind;
    return { type: "cut", kind, from, to: since };
  }
}

/**
 * Where to cut between [from, to]: the start of the utterance after the longest pause (so the cut
 * never splits speech). `from` if nothing was said there.
 */
export function cutPoint(speech: SpeechSpan[], from: number, to: number): number {
  const spans = speech
    .filter((s) => s.startAt >= from && s.startAt <= to)
    .sort((a, b) => a.startAt - b.startAt);
  if (spans.length === 0) return from;
  let best = spans[0]!.startAt;
  let bestGap = -1;
  let lastEnd = speech.reduce((end, s) => (s.startAt < from ? Math.max(end, s.endAt) : end), from);
  for (const s of spans) {
    const gap = s.startAt - lastEnd;
    if (gap > bestGap) {
      bestGap = gap;
      best = s.startAt;
    }
    lastEnd = Math.max(lastEnd, s.endAt);
  }
  return best;
}

export interface Segment {
  startedAt: number;
  endedAt: number;
  kind: EpisodeKind;
}

/**
 * Segment a finished stretch of speech offline (backlog), replaying the live steps: one per
 * minute boundary, plus one at the end so short stretches get a kind too.
 */
export function segmentRange(
  speech: SpeechSpan[],
  context: ContextMinute[],
  from: number,
  to: number,
  selfKnown: boolean,
): Segment[] {
  const out: Segment[] = [{ startedAt: from, endedAt: to, kind: "unknown" }];
  const seg = new Segmenter(from);
  const steps: number[] = [];
  for (let m = Math.ceil((from + 1) / MINUTE) * MINUTE; m < to; m += MINUTE) steps.push(m);
  steps.push(to);
  for (const at of steps) {
    const kind = classify(windowFeatures(speech, context, at - WINDOW_MS, at), selfKnown);
    const action = seg.step(at, kind);
    if (!action) continue;
    const cur = out[out.length - 1]!;
    if (action.type === "kind") cur.kind = action.kind;
    else {
      const t = cutPoint(speech, action.from, action.to);
      if (t - cur.startedAt < MIN_EPISODE_MS) {
        cur.kind = action.kind;
        continue;
      }
      cur.endedAt = t;
      seg.startedAt = t;
      out.push({ startedAt: t, endedAt: to, kind: action.kind });
    }
  }
  return out;
}
