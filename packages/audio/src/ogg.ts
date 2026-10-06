import { BufferSource, EncodedPacketSink, Input, OGG } from "mediabunny";
import { OpusDecoder } from "./opus";

/**
 * Decode an Ogg Opus file (as stored by Hearloom) to 16 kHz mono PCM. One-byte "lost frame"
 * packets decode through libopus packet-loss concealment, so timing is preserved.
 */
export async function decodeOggOpus(bytes: Uint8Array, frameSamples = 320): Promise<Int16Array> {
  const input = new Input({ source: new BufferSource(bytes), formats: [OGG] });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("no audio track");
    const decoder = new OpusDecoder(16000, 1, frameSamples);
    const parts: Int16Array[] = [];
    let total = 0;
    try {
      for await (const packet of new EncodedPacketSink(track).packets()) {
        const pcm = decoder.decode(packet.data);
        parts.push(pcm);
        total += pcm.length;
      }
    } finally {
      decoder.destroy();
    }
    const out = new Int16Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  } finally {
    input.dispose();
  }
}
