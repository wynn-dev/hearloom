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
