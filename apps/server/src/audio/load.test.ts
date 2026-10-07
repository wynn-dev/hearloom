import { expect, test } from "bun:test";
import { concatPieces } from "./load";

test("a time in a gap between pieces maps to the end of the piece before it", () => {
  const t0 = 1_760_000_000_000;
  // 2 s of audio, a 50 s gap (mic asleep), then 3 s.
  const { samples, toOffset, toAbs } = concatPieces([
    { startAt: t0, samples: new Float32Array(32_000) },
    { startAt: t0 + 52_000, samples: new Float32Array(48_000) },
  ]);
  expect(samples.length).toBe(80_000);
  expect(toOffset(t0 + 1_000)).toBe(16_000);
  expect(toOffset(t0 + 30_000)).toBe(32_000);
  expect(toOffset(t0 + 53_000)).toBe(48_000);
  expect(toAbs(3)).toBe(t0 + 53_000);
});
