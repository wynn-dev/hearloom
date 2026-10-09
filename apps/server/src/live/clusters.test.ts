import { describe, expect, test } from "bun:test";
import { SpeakerClusters } from "./speakers";

/** Unit vectors: `voice(i)` is a distinct voice; nearby angles are the same voice. */
function voice(i: number, jitter = 0): Float32Array {
  const v = new Float32Array(8);
  v[i] = 1;
  v[(i + 1) % 8] = jitter;
  return v;
}

describe("SpeakerClusters.label", () => {
  test("a voice keeps one key across recognizer sessions", () => {
    const c = new SpeakerClusters(0.6);
    expect(c.label("soniox:aaaa:1", "soniox:aaaa:", voice(0))).toBe("S1");
    expect(c.label("soniox:aaaa:2", "soniox:aaaa:", voice(1))).toBe("S2");
    // Next session: labels restart at 1, the voices don't.
    expect(c.label("soniox:bbbb:1", "soniox:bbbb:", voice(1, 0.1))).toBe("S2");
    expect(c.label("soniox:bbbb:2", "soniox:bbbb:", voice(0, 0.1))).toBe("S1");
    // A label keeps the key its first utterance gave it.
    expect(c.label("soniox:bbbb:2", "soniox:bbbb:", voice(3))).toBe("S1");
    expect(c.label("soniox:bbbb:2", "soniox:bbbb:", null)).toBe("S1");
  });

  test("too short to tell: a fresh key, kept for the label", () => {
    const c = new SpeakerClusters(0.6);
    expect(c.label("soniox:aaaa:1", "soniox:aaaa:", voice(0))).toBe("S1");
    expect(c.label("soniox:bbbb:1", "soniox:bbbb:", null)).toBe("S2");
    expect(c.label("soniox:bbbb:1", "soniox:bbbb:", voice(0))).toBe("S2");
  });

  test("a short-first label's voice is learned for later sessions (if it's a new voice)", () => {
    const c = new SpeakerClusters(0.6);
    expect(c.label("soniox:aaaa:1", "soniox:aaaa:", null)).toBe("S1");
    expect(c.label("soniox:aaaa:1", "soniox:aaaa:", voice(2))).toBe("S1");
    expect(c.label("soniox:bbbb:1", "soniox:bbbb:", voice(2, 0.1))).toBe("S1");
  });

  test("the engine said they're different people: not the same key in one session", () => {
    const c = new SpeakerClusters(0.6);
    expect(c.label("soniox:aaaa:1", "soniox:aaaa:", voice(0))).toBe("S1");
    expect(c.label("soniox:aaaa:2", "soniox:aaaa:", voice(0, 0.2))).toBe("S2");
    // Clearly the same voice as S1 though: no second cluster for it, so later sessions get S1.
    expect(c.label("soniox:bbbb:1", "soniox:bbbb:", voice(0, 0.2))).toBe("S1");
  });

  test("taken, but only somewhat alike: a new voice of its own", () => {
    const c = new SpeakerClusters(0.6);
    const alike = new Float32Array(8);
    alike[0] = 0.65; // cosine 0.65 to voice(0): over the threshold, not clearly the same
    alike[1] = Math.sqrt(1 - 0.65 ** 2);
    expect(c.label("soniox:aaaa:1", "soniox:aaaa:", voice(0))).toBe("S1");
    expect(c.label("soniox:aaaa:2", "soniox:aaaa:", alike)).toBe("S2");
    expect(c.label("soniox:bbbb:1", "soniox:bbbb:", alike)).toBe("S2");
  });
});
