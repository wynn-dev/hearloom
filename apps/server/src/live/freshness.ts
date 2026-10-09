/**
 * Audio received this long after it was captured is backlog (uploaded late), not live: its speech is
 * transcribed in batches and can't be a voice command.
 */
export const FRESH_MS = 30_000;
/** Late audio becomes live again only once it arrives this promptly (hysteresis). */
export const FRESH_AGAIN_MS = 10_000;

/**
 * Whether a stream's audio is live or backlog. Judged from the lag between capture and when the
 * server received it, so audio that arrived promptly stays live however long it waits in the
 * pipeline. Changes only between utterances (and at the start of a run): speech that crosses the
 * line isn't split between the live recognizer and the batch transcription.
 */
export class Freshness {
  private fresh: boolean | null = null;

  /**
   * `lagMs`: server receive time minus capture time. `speaking`: an utterance is in progress (it
   * keeps the current answer).
   */
  judge(lagMs: number, speaking: boolean): boolean {
    if (this.fresh === null) this.fresh = lagMs < FRESH_MS;
    else if (!speaking) this.fresh = this.fresh ? lagMs < FRESH_MS : lagMs < FRESH_AGAIN_MS;
    return this.fresh;
  }

  /** A new run (the mic slept): decide afresh. */
  reset(): void {
    this.fresh = null;
  }
}
