import { expect, test } from "bun:test";
import { throughPendantCodec } from "./clip";

test("browser audio goes through the pendant's codec, same length and rate", () => {
  // 1 s of a 220 Hz tone at 16 kHz.
  const pcm = new Int16Array(16_000);
  for (let i = 0; i < pcm.length; i++)
    pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 16_000));
  const out = throughPendantCodec(pcm);
  expect(out.length).toBe(16_000);
  // Lossy, but still the same signal (correlation after the codec's delay settles).
  let dot = 0;
  let a = 0;
  let b = 0;
  let best = 0;
  for (let lag = 0; lag < 200; lag++) {
    dot = a = b = 0;
    for (let i = 2000; i < 15_000; i++) {
      dot += pcm[i]! * out[i + lag]!;
      a += pcm[i]! ** 2;
      b += out[i + lag]! ** 2;
    }
    best = Math.max(best, dot / Math.sqrt(a * b));
  }
  expect(best).toBeGreaterThan(0.9);
});
