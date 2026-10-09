import { describe, expect, test } from "bun:test";
import { FRESH_AGAIN_MS, FRESH_MS, Freshness, RELIVE_AFTER_MS, STALE_MS } from "./freshness";

const T0 = 1_760_000_000_000;

/** Feeds 1 s batches: each call is the next second of audio. */
function stream() {
  const f = new Freshness();
  let at = T0;
  return {
    f,
    /** `lag`: receive delay; `age`: processing delay (defaults to the lag: the pipeline keeps up). */
    next(lag: number, midUtterance = false, age = lag) {
      const fresh = f.judge({ lagMs: lag, ageMs: age, at, midUtterance });
      at += 1000;
      return fresh;
    },
  };
}

describe("Freshness", () => {
  test("audio received promptly is live, audio captured long before it arrived is backlog", () => {
    expect(stream().next(1_500)).toBe(true);
    // From the phone's offline backlog: captured 10 minutes before the server got it.
    expect(stream().next(10 * 60_000)).toBe(false);
    expect(stream().next(FRESH_MS)).toBe(false);
  });

  test("audio that arrived promptly stays live while the pipeline is busy, up to a limit", () => {
    const s = stream();
    expect(s.next(800, false, 25_000)).toBe(true);
    expect(s.next(800, false, 50_000)).toBe(true);
    // Minutes behind: what it would say or buzz about is stale.
    expect(s.next(800, true, STALE_MS)).toBe(false);
  });

  test("doesn't change in the middle of an utterance, short of the hard bounds", () => {
    const s = stream();
    expect(s.next(2_000)).toBe(true);
    // The upload stalls while the user is talking: the utterance stays live to its end...
    expect(s.next(45_000, true)).toBe(true);
    expect(s.next(50_000, false)).toBe(false);
    // ...unless the audio is so late that it's stale.
    const t = stream();
    expect(t.next(2_000)).toBe(true);
    expect(t.next(STALE_MS, true)).toBe(false);
  });

  test("a caught-up stream becomes live within seconds, even through continuous speech", () => {
    const s = stream();
    expect(s.next(5 * 60_000)).toBe(false);
    // Caught up while the TV talks on (no utterance boundary).
    const seen: boolean[] = [];
    for (let i = 0; i < 6; i++) seen.push(s.next(500, true));
    expect(seen.indexOf(true)).toBe(RELIVE_AFTER_MS / 1000);
    // Between utterances it changes at once.
    const t = stream();
    expect(t.next(5 * 60_000)).toBe(false);
    expect(t.next(500, false)).toBe(true);
  });

  test("hysteresis: backlog becomes live again only once it arrives well within the limit", () => {
    const s = stream();
    expect(s.next(5 * 60_000)).toBe(false);
    expect(s.next(FRESH_MS - 1_000)).toBe(false);
    expect(s.next(FRESH_AGAIN_MS + 1_000)).toBe(false);
    expect(s.next(FRESH_AGAIN_MS - 1_000)).toBe(true);
    // And live stays live up to the limit.
    expect(s.next(FRESH_MS - 1_000)).toBe(true);
    expect(s.next(FRESH_MS)).toBe(false);
  });

  test("a phone clock running behind still counts as caught up", () => {
    const s = stream();
    // The phone's clock is 14 s behind: live audio arrives "14.5 s late".
    expect(s.next(14_500)).toBe(true);
    expect(s.next(40_000)).toBe(false); // a stall
    expect(s.next(14_500)).toBe(true); // caught up again
    // Backlog catching up says nothing about the clock: no allowance from it.
    const t = stream();
    expect(t.next(5 * 60_000)).toBe(false);
    expect(t.next(20_000)).toBe(false);
    expect(t.next(14_500)).toBe(false);
  });

  test("a new run decides afresh, even if it starts with speech", () => {
    const s = stream();
    expect(s.next(5 * 60_000)).toBe(false);
    s.f.reset();
    expect(s.next(800, true)).toBe(true);
  });
});
