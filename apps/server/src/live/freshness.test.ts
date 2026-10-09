import { describe, expect, test } from "bun:test";
import { FRESH_AGAIN_MS, FRESH_MS, Freshness } from "./freshness";

describe("Freshness", () => {
  test("audio received promptly is live, audio captured long before it arrived is backlog", () => {
    expect(new Freshness().judge(1_500, false)).toBe(true);
    // From the phone's offline backlog: captured 10 minutes before the server got it.
    expect(new Freshness().judge(10 * 60_000, false)).toBe(false);
    expect(new Freshness().judge(FRESH_MS, false)).toBe(false);
  });

  test("doesn't change in the middle of an utterance", () => {
    const f = new Freshness();
    expect(f.judge(2_000, false)).toBe(true);
    // The upload stalls while the user is talking: the utterance stays live to its end.
    expect(f.judge(45_000, true)).toBe(true);
    expect(f.judge(50_000, false)).toBe(false);
    // Caught up mid-utterance: it stays backlog until the speech ends.
    expect(f.judge(500, true)).toBe(false);
    expect(f.judge(500, false)).toBe(true);
  });

  test("hysteresis: backlog becomes live again only once it arrives well within the limit", () => {
    const f = new Freshness();
    expect(f.judge(5 * 60_000, false)).toBe(false);
    expect(f.judge(FRESH_MS - 1_000, false)).toBe(false);
    expect(f.judge(FRESH_AGAIN_MS + 1_000, false)).toBe(false);
    expect(f.judge(FRESH_AGAIN_MS - 1_000, false)).toBe(true);
    // And live stays live up to the limit.
    expect(f.judge(FRESH_MS - 1_000, false)).toBe(true);
  });

  test("a new run decides afresh, even if it starts with speech", () => {
    const f = new Freshness();
    expect(f.judge(5 * 60_000, false)).toBe(false);
    f.reset();
    expect(f.judge(800, true)).toBe(true);
  });
});
