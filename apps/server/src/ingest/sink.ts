import { schema } from "@hearloom/db";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { invalidate } from "../realtime";
import { storage } from "../storage";
import type { ChunkSink } from "./stream-writer";

const { audioChunks, captureStreams } = schema;

function chunkKey(userId: string, streamId: string, seqStart: number, at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `audio/${userId}/${y}/${m}/${d}/${streamId}-${seqStart}.ogg`;
}

export const dbChunkSink: ChunkSink = {
  async saveChunk(meta, chunk) {
    const key = chunkKey(meta.userId, meta.id, chunk.seqStart, chunk.startAt);
    await storage.put(key, chunk.ogg);
    const sha256 = new Bun.CryptoHasher("sha256").update(chunk.ogg).digest("hex");
    await db
      .insert(audioChunks)
      .values({
        userId: meta.userId,
        streamId: meta.id,
        seqStart: chunk.seqStart,
        seqEnd: chunk.seqEnd,
        startAt: chunk.startAt,
        endAt: chunk.endAt,
        frameCount: chunk.frameCount,
        durationMs: chunk.durationMs,
        codec: meta.codec,
        storageKey: key,
        byteSize: chunk.ogg.length,
        sha256,
      })
      .onConflictDoNothing({ target: [audioChunks.streamId, audioChunks.seqStart] });
    invalidate(meta.userId, ["timeline"]);
  },

  async saveProgress(meta, p) {
    await db
      .update(captureStreams)
      .set({
        ackedSeq: sql`greatest(${captureStreams.ackedSeq}, ${p.ackedSeq}::bigint)`,
        lastFrameAt: sql`greatest(${captureStreams.lastFrameAt}, ${p.lastFrameAt.toISOString()}::timestamptz)`,
        framesReceived: sql`${captureStreams.framesReceived} + ${p.frames}`,
        bytesReceived: sql`${captureStreams.bytesReceived} + ${p.bytes}`,
      })
      .where(eq(captureStreams.id, meta.id));
  },
};
