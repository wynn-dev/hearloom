/** Characters `start`..`end` of an utterance's text are in this language ("en"). */
export interface LangSpan {
  start: number;
  end: number;
  lang: string;
}

/** A finalized piece of transcript with absolute (unix ms) times. */
export interface Utterance {
  startAt: number;
  endAt: number;
  text: string;
  lang: string | null;
  /** The language of each stretch of `text` (character offsets), when the engine tags words. */
  langSpans?: LangSpan[];
  /** Engine-scoped speaker label (e.g. "soniox:2"), if the engine diarizes. */
  speakerKey: string | null;
  confidence: number | null;
  provider: string;
  model: string | null;
  /**
   * The recognizer's session broke, or the audio stalled, before the utterance was finished: its
   * last words may be missing (never act on it as a whole command).
   */
  cutOff?: boolean;
}

/**
 * The utterance being spoken, as the recognizer has it so far: its final words plus its latest
 * guesses (which may still change). Absolute (unix ms) times.
 */
export interface PartialUtterance {
  text: string;
  startAt: number;
  /** Each token: its end offset in `text`, and its times. */
  tokens: { offset: number; startAt: number; endAt: number }[];
  /** End of the audio the recognizer has processed so far. */
  audioAt: number;
  speakerKey: string | null;
}
