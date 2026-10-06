import { expect, test } from "bun:test";
import { OpusDecoder, OpusEncoder } from "./opus";

test("round-trips Omi-style CELT low-delay frames with exact PLC", () => {
  const enc = new OpusEncoder(16000, 1);
  const dec = new OpusDecoder(16000, 1, 320);
  const frames: Uint8Array[] = [];
  for (let f = 0; f < 50; f++) {
    const pcm = new Int16Array(320);
    for (let i = 0; i < 320; i++)
      pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (f * 320 + i)) / 16000));
    frames.push(enc.encode(pcm));
  }
  // CELT-only, wideband, 20 ms => TOC config 23 (0xB8 with code 0, mono).
  expect(frames[0]![0]! & 0xfc).toBe(0xb8);
  let total = 0;
  for (const f of frames) total += dec.decode(f).length;
  expect(total).toBe(50 * 320);
  expect(dec.conceal().length).toBe(320);
  expect(dec.decode(new Uint8Array([0xb8])).length).toBe(320);
  enc.destroy();
  dec.destroy();
});
