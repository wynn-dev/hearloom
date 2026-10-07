import { decodeOggOpus } from "@hearloom/audio";
import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { storage } from "../storage";

export interface AudioPiece {
  /** Absolute time (unix ms) of the first sample. */
  startAt: number;
  samples: Float32Array;
}

/**
 * Decoded 16 kHz audio of one stream between two absolute times, as contiguous pieces (chunks
 * are split at mic-sleep gaps; inside a chunk lost packets were concealed, so offsets = time).
 */
export async function loadStreamPieces(
  db: Db,
  streamId: string,
  fromMs: number,
  toMs: number,
): Promise<AudioPiece[]> {
  const chunks = await db
    .select()
    .from(schema.audioChunks)
    .where(
      and(
        eq(schema.audioChunks.streamId, streamId),
        lt(schema.audioChunks.startAt, new Date(toMs)),
        gte(schema.audioChunks.endAt, new Date(fromMs)),
      ),
    )
    .orderBy(asc(schema.audioChunks.startAt));
  const pieces: AudioPiece[] = [];
  for (const c of chunks) {
    const file = storage.file(c.storageKey);
    if (!(await file.exists())) continue;
    const pcm = await decodeOggOpus(new Uint8Array(await file.arrayBuffer()));
    const start = c.startAt.getTime();
    const a = Math.max(0, Math.floor((fromMs - start) * 16));
    const b = Math.min(pcm.length, Math.ceil((toMs - start) * 16));
    if (b <= a) continue;
    const slice = new Float32Array(b - a);
    for (let i = 0; i < slice.length; i++) slice[i] = pcm[a + i]! / 32768;
    const prev = pieces[pieces.length - 1];
    const sliceStart = start + a / 16;
    // Merge back-to-back chunks (60 s chunk boundaries) into one piece.
    if (prev && Math.abs(prev.startAt + prev.samples.length / 16 - sliceStart) < 30) {
      const merged = new Float32Array(prev.samples.length + slice.length);
      merged.set(prev.samples);
      merged.set(slice, prev.samples.length);
      prev.samples = merged;
    } else {
      pieces.push({ startAt: sliceStart, samples: slice });
    }
  }
  return pieces;
}

/** Concatenate pieces (dropping the silent gaps) with a mapping back to absolute time. */
export function concatPieces(pieces: AudioPiece[]): {
  samples: Float32Array;
  toAbs(seconds: number): number;
  /** Inverse of toAbs: sample offset of an absolute time (clamped into the nearest piece). */
  toOffset(absMs: number): number;
} {
  const total = pieces.reduce((n, p) => n + p.samples.length, 0);
  const samples = new Float32Array(total);
  const offsets: { at: number; startAt: number; end: number }[] = [];
  let o = 0;
  for (const p of pieces) {
    samples.set(p.samples, o);
    offsets.push({ at: o / 16000, startAt: p.startAt, end: o + p.samples.length });
    o += p.samples.length;
  }
  return {
    samples,
    toAbs(seconds: number) {
      let span = offsets[0];
      for (const s of offsets) {
        if (s.at <= seconds) span = s;
        else break;
      }
      return span ? span.startAt + (seconds - span.at) * 1000 : seconds * 1000;
    },
    toOffset(absMs: number) {
      let span = offsets[0];
      for (const s of offsets) {
        if (s.startAt <= absMs) span = s;
        else break;
      }
      if (!span) return 0;
      // A time in a gap between pieces maps to the end of the piece before it.
      return Math.max(
        0,
        Math.min(span.end, Math.round((span.at + (absMs - span.startAt) / 1000) * 16000)),
      );
    },
  };
}

/** Audio between two absolute times, concatenated (for embeddings / enrollment). */
export async function loadStreamAudio(
  db: Db,
  streamId: string,
  fromMs: number,
  toMs: number,
): Promise<Float32Array | null> {
  const pieces = await loadStreamPieces(db, streamId, fromMs, toMs);
  if (pieces.length === 0) return null;
  return concatPieces(pieces).samples;
}
