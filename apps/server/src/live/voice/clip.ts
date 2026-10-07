import { OpusDecoder, OpusEncoder } from "@hearloom/audio";
import { type SonioxOptions, SonioxSession } from "../asr/soniox";

/** Omi frames: 20 ms at 16 kHz. */
const FRAME = 320;

/**
 * Put browser-recorded audio (16 kHz mono) through the pendant's codec (Opus, CELT low delay, 20 ms
 * frames), so its voice embedding and transcript are comparable with what the pendant sends.
 */
export function throughPendantCodec(pcm: Int16Array): Int16Array {
  const enc = new OpusEncoder(16000, 1);
  const dec = new OpusDecoder(16000, 1, FRAME);
  try {
    const frames = Math.floor(pcm.length / FRAME);
    const out = new Int16Array(frames * FRAME);
    for (let i = 0; i < frames; i++) {
      const decoded = dec.decode(enc.encode(pcm.subarray(i * FRAME, (i + 1) * FRAME)));
      out.set(decoded.subarray(0, FRAME), i * FRAME);
    }
    return out;
  } finally {
    enc.destroy();
    dec.destroy();
  }
}

/** Transcribe a short clip with the real-time model (the one live commands are heard with). */
export async function transcribeClip(pcm: Int16Array, opts: SonioxOptions): Promise<string> {
  const parts: string[] = [];
  let error: string | null = null;
  const session = new SonioxSession(
    opts,
    (u) => parts.push(u.text),
    (message) => {
      error = message;
    },
  );
  session.send(pcm, Date.now() - pcm.length / 16);
  await session.close();
  if (parts.length === 0 && error) throw new Error(error);
  return parts.join(" ").trim();
}
