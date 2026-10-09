import type { PartialUtterance, Utterance } from "./types";

/** One token from the Soniox real-time API. */
export interface SonioxToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  is_final: boolean;
  speaker?: string;
  language?: string;
}

/**
 * Maps positions in the audio we sent to Soniox (ms since the session started, counting only
 * audio actually sent) back to wall-clock time. We only stream speech, so the session timeline
 * has jumps relative to wall clock.
 */
export class SessionClock {
  private spans: { sessionMs: number; absMs: number }[] = [];
  private sentMs = 0;

  /** Record that `durationMs` of audio starting at wall-clock `absMs` was just sent. */
  sent(absMs: number, durationMs: number): void {
    const last = this.spans[this.spans.length - 1];
    const contiguous = last && Math.abs(last.absMs + (this.sentMs - last.sessionMs) - absMs) < 5;
    if (!contiguous) this.spans.push({ sessionMs: this.sentMs, absMs });
    this.sentMs += durationMs;
  }

  get totalSentMs(): number {
    return this.sentMs;
  }

  toAbs(sessionMs: number): number {
    let span = this.spans[0];
    for (const s of this.spans) {
      if (s.sessionMs <= sessionMs) span = s;
      else break;
    }
    if (!span) return sessionMs;
    return span.absMs + (sessionMs - span.sessionMs);
  }

  /** Index of the contiguous stretch of sent audio that `sessionMs` falls in. */
  spanAt(sessionMs: number): number {
    let i = 0;
    while (i + 1 < this.spans.length && this.spans[i + 1]!.sessionMs <= sessionMs) i++;
    return i;
  }
}

/** Text with no letters or digits (also matches ""). */
const NO_WORDS = /^[^\p{L}\p{N}]*$/u;
/**
 * A token that only closes what came before it: "." "?" "," "—", closing quotes and brackets, with
 * no space before it. Straight quotes and hyphens are left out: they can also open text ("-5", "'t").
 */
const CLOSING = /^[.,!?;:…。，！？、)\]}”’»–—]+$/u;

/**
 * Groups final Soniox tokens into utterances: a new utterance starts on the `<end>` endpoint
 * token, a speaker change, a pause longer than `maxGapMs` (wall clock), where the audio we sent
 * was cut (stitched speech segments, mic sleep), or at a word boundary once the utterance is
 * longer than `maxUtteranceMs` (async results have no endpoints).
 */
export class SonioxAssembler {
  private current: SonioxToken[] = [];

  constructor(
    private readonly clock: SessionClock,
    private readonly model: string,
    private readonly maxGapMs = 1500,
    private readonly speakerPrefix = "soniox:",
    private readonly maxUtteranceMs = 30_000,
  ) {}

  /** Feed one response's tokens; returns utterances completed by these tokens. */
  push(tokens: SonioxToken[]): Utterance[] {
    const out: Utterance[] = [];
    for (const t of tokens) {
      if (!t.is_final) continue;
      if (t.text === "<end>" || t.text === "<fin>") {
        const u = this.emit();
        if (u) out.push(u);
        continue;
      }
      if (/^<\w+>$/.test(t.text)) continue;
      if (CLOSING.test(t.text)) {
        // Closing punctuation belongs to the words before it, whatever speaker or time Soniox gave
        // it: it takes theirs, so it can't hide a split or stretch the line. If that line was
        // already emitted, it's dropped rather than starting the next one.
        const prev = this.current[this.current.length - 1];
        if (prev) {
          this.current.push({
            ...t,
            speaker: prev.speaker,
            start_ms: prev.end_ms,
            end_ms: prev.end_ms,
          });
        }
        continue;
      }
      if (this.splitsBefore(t)) {
        const u = this.emit();
        if (u) out.push(u);
      }
      this.current.push(t);
    }
    return out;
  }

  /**
   * The utterance in progress after `push(tokens)`: its final tokens plus the non-final ones in
   * `tokens` (Soniox sends the current guesses with every response). Null if there are no words.
   */
  partial(tokens: SonioxToken[]): PartialUtterance | null {
    let toks = [...this.current];
    for (const t of tokens) {
      if (t.is_final || /^<\w+>$/.test(t.text)) continue;
      if (CLOSING.test(t.text)) {
        if (toks.length > 0) toks.push({ ...t, end_ms: toks.at(-1)!.end_ms });
        continue;
      }
      if (this.splitsBefore(t, toks)) toks = [];
      toks.push(t);
    }
    const first = toks[0];
    if (!first) return null;
    const ends: PartialUtterance["ends"] = [];
    let raw = "";
    for (const t of toks) {
      raw += t.text;
      ends.push({ offset: raw.length, endAt: this.clock.toAbs(t.end_ms ?? t.start_ms ?? 0) });
    }
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (NO_WORDS.test(text)) return null;
    return {
      text,
      startAt: this.clock.toAbs(first.start_ms ?? 0),
      ends: ends.map((e) => ({ offset: Math.max(0, e.offset - lead), endAt: e.endAt })),
      audioAt: this.clock.toAbs(this.clock.totalSentMs),
      speakerKey: first.speaker !== undefined ? `${this.speakerPrefix}${first.speaker}` : null,
    };
  }

  private splitsBefore(t: SonioxToken, current = this.current): boolean {
    const prev = current[current.length - 1];
    if (!prev) return false;
    if (t.speaker !== undefined && t.speaker !== prev.speaker) return true;
    if (t.start_ms === undefined || prev.end_ms === undefined) return false;
    const { clock } = this;
    if (clock.toAbs(t.start_ms) - clock.toAbs(prev.end_ms) > this.maxGapMs) return true;
    if (clock.spanAt(t.start_ms) !== clock.spanAt(prev.start_ms ?? prev.end_ms)) return true;
    const first = current[0]!;
    return (
      t.text.startsWith(" ") &&
      clock.toAbs(t.start_ms) - clock.toAbs(first.start_ms ?? t.start_ms) > this.maxUtteranceMs
    );
  }

  /** Emit whatever is buffered (session ending). */
  flush(): Utterance | null {
    return this.emit();
  }

  private emit(): Utterance | null {
    const toks = this.current;
    this.current = [];
    const text = toks
      .map((t) => t.text)
      .join("")
      .trim();
    // No words at all (e.g. a lone symbol): not worth a line of its own.
    if (NO_WORDS.test(text)) return null;
    const first = toks[0]!;
    const last = toks[toks.length - 1]!;
    const langs = new Map<string, number>();
    for (const t of toks)
      if (t.language) langs.set(t.language, (langs.get(t.language) ?? 0) + t.text.length);
    const lang = [...langs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const confs = toks.map((t) => t.confidence).filter((c): c is number => typeof c === "number");
    return {
      startAt: this.clock.toAbs(first.start_ms ?? 0),
      endAt: this.clock.toAbs(last.end_ms ?? last.start_ms ?? 0),
      text,
      lang,
      speakerKey: first.speaker !== undefined ? `${this.speakerPrefix}${first.speaker}` : null,
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
      provider: "soniox",
      model: this.model,
    };
  }
}
