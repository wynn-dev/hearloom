import { decodeOggOpus } from "@hearloom/audio";
import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { storage } from "../storage";

/**
 * Decoded 16 kHz audio of one stream between two absolute times, from stored chunks.
 * Chunks are contiguous internally (gaps were concealed), so sample offset = time offset.
 */
export async function loadStreamAudio(
  db: Db,
  streamId: string,
  fromMs: number,
  toMs: number,
): Promise<Float32Array | null> {
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
  const parts: Float32Array[] = [];
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
    parts.push(slice);
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
