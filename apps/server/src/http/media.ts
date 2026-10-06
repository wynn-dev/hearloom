import { timingSafeEqual } from "node:crypto";
import { schema } from "@hearloom/db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { storage } from "../storage";

/**
 * Short-lived signed URLs for audio. Lets <audio>, AVPlayer and (later) the agent fetch
 * clips without auth headers, without exposing the session token in URLs.
 */
function sign(path: string, exp: number): string {
  return new Bun.CryptoHasher("sha256", `${env.BETTER_AUTH_SECRET}:media`)
    .update(`${path}:${exp}`)
    .digest("base64url");
}

export function signedMediaUrl(path: string, ttlSec = env.MEDIA_URL_TTL_SEC): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${path}?exp=${exp}&sig=${sign(path, exp)}`;
}

export function chunkUrl(chunkId: string): string {
  return signedMediaUrl(`/media/chunks/${chunkId}.ogg`);
}

function verify(path: string, exp: string | null, sig: string | null): boolean {
  if (!exp || !sig) return false;
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(path, e));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** GET /media/chunks/:id.ogg with HTTP Range support. */
export async function serveChunk(req: Request, chunkId: string): Promise<Response> {
  const url = new URL(req.url);
  if (!verify(url.pathname, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("forbidden", { status: 403 });
  }
  const [chunk] = await db
    .select({ key: schema.audioChunks.storageKey })
    .from(schema.audioChunks)
    .where(eq(schema.audioChunks.id, chunkId));
  if (!chunk) return new Response("not found", { status: 404 });
  const file = storage.file(chunk.key);
  if (!(await file.exists())) return new Response("not found", { status: 404 });

  const size = file.size;
  const headers: Record<string, string> = {
    "content-type": "audio/ogg",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  };
  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m) {
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (!m[1] && m[2]) {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    }
    if (start >= size || end < start) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      },
    });
  }
  return new Response(file, { headers: { ...headers, "content-length": String(size) } });
}
