/**
 * Recent 16 kHz audio with absolute timestamps, for slicing utterances (speaker ID, pre-roll).
 * Stored as the pushed chunks, each with its own start time, so old audio is dropped chunk by chunk
 * even during hours of uninterrupted capture, and slicing copies only the requested range.
 */
export class PcmHistory {
  private chunks: { startAt: number; samples: Float32Array }[] = [];

  constructor(private readonly keepMs = 180_000) {}

  push(atMs: number, samples: Float32Array): void {
    if (samples.length === 0) return;
    this.chunks.push({ startAt: atMs, samples });
    const cutoff = atMs - this.keepMs;
    let drop = 0;
    while (drop < this.chunks.length - 1 && end(this.chunks[drop]!) < cutoff) drop++;
    if (drop > 0) this.chunks.splice(0, drop);
  }

  /** Audio between two absolute times (gaps are skipped), or null if none is retained. */
  slice(fromMs: number, toMs: number): Float32Array | null {
    const parts: Float32Array[] = [];
    for (const c of this.chunks) {
      if (end(c) <= fromMs || c.startAt >= toMs) continue;
      const a = Math.max(0, Math.floor((fromMs - c.startAt) * 16));
      const b = Math.min(c.samples.length, Math.ceil((toMs - c.startAt) * 16));
      if (b > a) parts.push(c.samples.subarray(a, b));
    }
    if (parts.length === 0) return null;
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** Retained samples (for tests/metrics). */
  get size(): number {
    return this.chunks.reduce((n, c) => n + c.samples.length, 0);
  }
}

function end(c: { startAt: number; samples: Float32Array }): number {
  return c.startAt + c.samples.length / 16;
}
