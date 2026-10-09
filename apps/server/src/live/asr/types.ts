/** A finalized piece of transcript with absolute (unix ms) times. */
export interface Utterance {
  startAt: number;
  endAt: number;
  text: string;
  lang: string | null;
  /** Engine-scoped speaker label (e.g. "soniox:2"), if the engine diarizes. */
  speakerKey: string | null;
  confidence: number | null;
  provider: string;
  model: string | null;
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
