import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  OggOutputFormat,
  Output,
} from "mediabunny";

/**
 * A TOC-only Opus packet with the same mode/bandwidth/frame size as `reference`.
 * Decoders treat a frame with no payload as lost and run packet-loss concealment,
 * which keeps timing intact across dropped BLE packets.
 */
export function lostFramePacket(reference: Uint8Array): Uint8Array {
  return new Uint8Array([(reference[0] ?? 0xb8) & 0xfc]);
}

/**
 * OpusHead identification header (RFC 7845 §5.1). Omi encodes in restricted-low-delay
 * (CELT-only) mode whose lookahead is 2.5 ms, i.e. a pre-skip of 120 samples at 48 kHz.
 */
export function opusHead(channels: number, inputSampleRate: number, preSkip = 120): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  const view = new DataView(head.buffer);
  view.setUint8(8, 1); // version
  view.setUint8(9, channels);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true); // output gain
  view.setUint8(18, 0); // mapping family 0: mono/stereo
  return head;
}

/** Wrap contiguous raw Opus frames into an Ogg Opus file without re-encoding. */
export async function muxOggOpus(
  frames: Uint8Array[],
  opts: { frameMs: number; sampleRate: number; channels?: number },
): Promise<Uint8Array> {
  if (frames.length === 0) throw new Error("no frames");
  const target = new BufferTarget();
  const output = new Output({ format: new OggOutputFormat(), target });
  const source = new EncodedAudioPacketSource("opus");
  output.addAudioTrack(source);
  await output.start();
  const dur = opts.frameMs / 1000;
  for (let i = 0; i < frames.length; i++) {
    const packet = new EncodedPacket(frames[i]!, "key", i * dur, dur, i);
    await source.add(
      packet,
      i === 0
        ? {
            decoderConfig: {
              codec: "opus",
              numberOfChannels: opts.channels ?? 1,
              sampleRate: 48000,
              description: opusHead(opts.channels ?? 1, opts.sampleRate),
            },
          }
        : undefined,
    );
  }
  await output.finalize();
  if (!target.buffer) throw new Error("ogg muxing produced no output");
  return new Uint8Array(target.buffer);
}
