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
  /** Where each token ends: its end offset in `text`, and its end time. */
  ends: { offset: number; endAt: number }[];
  /** End of the audio sent to the recognizer so far. */
  audioAt: number;
  speakerKey: string | null;
}
