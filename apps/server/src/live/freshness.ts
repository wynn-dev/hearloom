/**
 * Audio received this long after it was captured is backlog (uploaded late), not live: its speech is
 * transcribed in batches and can't be a voice command.
 */
export const FRESH_MS = 30_000;
/** Late audio becomes live again once it arrives this promptly (hysteresis). */
export const FRESH_AGAIN_MS = 10_000;
/** Audio this old (on arrival, or by the time it's processed) is backlog, even mid-utterance. */
export const STALE_MS = 2 * FRESH_MS;
/** After this much prompt audio, a caught-up stream is live again even mid-utterance (TV, music). */
export const RELIVE_AFTER_MS = 3_000;
/**
 * At most this much of the smallest lag of a stream's live audio is taken as the phone's clock
 * running behind, so such a phone still counts as caught up.
 */
export const MAX_SKEW_MS = 15_000;

export interface FreshnessInput {
  /** Server receive time minus capture time. */
  lagMs: number;
  /** Now (processing) minus capture time. */
  ageMs: number;
  /** Capture time of the audio (unix ms). */
  at: number;
  /** An utterance is in progress (the VAD hears speech and no segment just ended). */
  midUtterance: boolean;
}

/**
 * Whether a stream's audio is live or backlog. Judged from the lag between capture and when the
 * server received it, so audio that arrived promptly stays live while it waits in the pipeline (up
 * to STALE_MS). Changes between utterances (and at the start of a run), so speech that crosses the
 * line isn't split between the live recognizer and the batch transcription; continuous speech
 * still changes at the hard bounds (STALE_MS, RELIVE_AFTER_MS).
 */
export class Freshness {
  private fresh: boolean | null = null;
  /**
   * Smallest lag of this stream's live audio (phone clock skew plus network). Only live audio
   * counts: the lag of backlog catching up says nothing about the clock.
   */
  private minLiveLag = Number.POSITIVE_INFINITY;
  /** Capture time since which the audio has arrived promptly (null: it hasn't). */
  private promptSince: number | null = null;

  judge({ lagMs, ageMs, at, midUtterance }: FreshnessInput): boolean {
    const lag = Math.max(0, lagMs); // a phone clock running ahead
    const skew = Number.isFinite(this.minLiveLag) ? Math.min(this.minLiveLag, MAX_SKEW_MS) : 0;
    const prompt = lag < FRESH_AGAIN_MS + skew;
    if (!prompt) this.promptSince = null;
    else this.promptSince ??= at;

    if (lag >= STALE_MS || ageMs >= STALE_MS) this.fresh = false;
    else if (this.fresh === null) this.fresh = lag < FRESH_MS;
    else if (this.fresh) this.fresh = midUtterance || lag < FRESH_MS;
    else this.fresh = prompt && (!midUtterance || at - this.promptSince! >= RELIVE_AFTER_MS);
    if (this.fresh) this.minLiveLag = Math.min(this.minLiveLag, lag);
    return this.fresh;
  }

  /** A new run (the mic slept): decide afresh. */
  reset(): void {
    this.fresh = null;
    this.promptSince = null;
  }
}
