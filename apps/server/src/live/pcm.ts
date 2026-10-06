/** Recent 16 kHz audio with absolute timestamps, for slicing utterances (speaker ID, pre-roll). */
export class PcmHistory {
  private runs: { startAt: number; chunks: Float32Array[]; samples: number }[] = [];

  constructor(private readonly keepMs = 180_000) {}

  push(atMs: number, samples: Float32Array): void {
    const last = this.runs[this.runs.length - 1];
    const lastEnd = last ? last.startAt + last.samples / 16 : -Infinity;
    if (last && Math.abs(lastEnd - atMs) < 30) {
      last.chunks.push(samples);
      last.samples += samples.length;
    } else {
      this.runs.push({ startAt: atMs, chunks: [samples], samples: samples.length });
    }
    this.trim(atMs);
  }

  /** Audio between two absolute times (gaps are skipped), or null if none is retained. */
  slice(fromMs: number, toMs: number): Float32Array | null {
    const parts: Float32Array[] = [];
    for (const run of this.runs) {
      const runEnd = run.startAt + run.samples / 16;
      if (runEnd <= fromMs || run.startAt >= toMs) continue;
      const all = concat(run.chunks, run.samples);
      run.chunks = [all];
      const a = Math.max(0, Math.floor((fromMs - run.startAt) * 16));
      const b = Math.min(all.length, Math.ceil((toMs - run.startAt) * 16));
      if (b > a) parts.push(all.subarray(a, b));
    }
    if (parts.length === 0) return null;
    return concat(
      parts,
      parts.reduce((n, p) => n + p.length, 0),
    );
  }

  private trim(nowMs: number): void {
    while (this.runs.length > 0) {
      const r = this.runs[0]!;
      if (r.startAt + r.samples / 16 < nowMs - this.keepMs) this.runs.shift();
      else break;
    }
  }
}

function concat(parts: Float32Array[], total: number): Float32Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
