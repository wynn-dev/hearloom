import { describe, expect, test } from "bun:test";
import { CommandAssembler, type HeardUtterance } from "./assembler";

const cfg = { names: ["Hermes"], aliases: [] };
const T = 1_800_000_000_000;

function utt(text: string, startS: number, endS: number, over: Partial<HeardUtterance> = {}) {
  return {
    streamId: "s1",
    text,
    startAt: T + startS * 1000,
    endAt: T + endS * 1000,
    lang: "en",
    speakerKey: "S1",
    isSelf: true,
    chainId: "c1",
    ...over,
  } satisfies HeardUtterance;
}
/** Wall clock: the final arrives ~1.5 s after the utterance ends. */
const at = (s: number) => T + s * 1000;
/** No speech after this audio time. */
const quiet = (s: number) => T + s * 1000;

describe("CommandAssembler", () => {
  test("single utterance completes at once when the user stops talking", () => {
    const a = new CommandAssembler();
    const step = a.push(utt("Hey Hermes, call mom.", 0, 2), cfg, quiet(2), at(3.5));
    expect(step.done).toHaveLength(1);
    expect(step.done[0]).toMatchObject({
      command: "call mom.",
      transcript: "Hey Hermes, call mom.",
      spokenAt: T,
      endedAt: T + 2000,
    });
    expect(a.busy).toBe(false);
  });

  test("non-wake speech is ignored", () => {
    const a = new CommandAssembler();
    const step = a.push(utt("I asked Hermes yesterday.", 0, 2), cfg, quiet(2), at(3.5));
    expect(step).toEqual({ done: [], abandoned: [] });
    expect(a.busy).toBe(false);
  });

  test("wake word, then the command in the next utterance", () => {
    const a = new CommandAssembler();
    expect(
      a.push(utt("Hey Hermes.", 0, 0.8, { isSelf: null }), cfg, quiet(0.8), at(2)).done,
    ).toEqual([]);
    expect(a.busy).toBe(true);
    const step = a.push(utt("What's the weather tomorrow?", 2.5, 4.5), cfg, quiet(4.5), at(6));
    expect(step.done[0]).toMatchObject({
      command: "What's the weather tomorrow?",
      transcript: "Hey Hermes. What's the weather tomorrow?",
      spokenAt: T,
    });
  });

  test("wake word alone times out as no_command", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2));
    expect(a.tick(quiet(0.8), at(5)).abandoned).toEqual([]);
    const step = a.tick(quiet(0.8), at(10.1));
    expect(step.abandoned).toHaveLength(1);
    expect(step.abandoned[0]!.reason).toBe("no_command");
  });

  test("another speaker after the wake word abandons it", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes.", 0, 0.8), cfg, quiet(0.8), at(2));
    const step = a.push(
      utt("Who's Hermes?", 2, 3, { speakerKey: "S2", isSelf: false }),
      cfg,
      quiet(3),
      at(4.5),
    );
    expect(step.abandoned).toHaveLength(1);
    expect(step.done).toHaveLength(0);
  });

  test("continuation while the user is still talking", () => {
    const a = new CommandAssembler();
    // Speech at 3.5 s, after the first part's end: a continuation is coming.
    let step = a.push(utt("Hey Hermes, remind me to", 0, 2), cfg, quiet(3.5), at(3.5));
    expect(step.done).toHaveLength(0);
    expect(a.tick(quiet(3.5), at(4)).done).toHaveLength(0);
    step = a.push(utt("call mom at six.", 2.8, 4), cfg, quiet(4), at(5.5));
    expect(step.done[0]!.command).toBe("remind me to call mom at six.");
    expect(step.done[0]!.parts).toHaveLength(2);
  });

  test("gives up waiting for a continuation", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, remind me to", 0, 2), cfg, quiet(3.5), at(3.5));
    expect(a.tick(quiet(3.5), at(7.6)).done[0]!.command).toBe("remind me to");
  });

  test("a different speaker ends the command and is not appended", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, turn on", 0, 2), cfg, quiet(3), at(3.5));
    const step = a.push(
      utt("the lights are on already", 2.5, 4, { speakerKey: "S2", isSelf: false }),
      cfg,
      quiet(4),
      at(5.5),
    );
    expect(step.done[0]!.command).toBe("turn on");
  });

  test("caps the number of parts", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, one", 0, 1), cfg, quiet(9), at(2));
    a.push(utt("two", 1.5, 2), cfg, quiet(9), at(3));
    const step = a.push(utt("three", 2.5, 3), cfg, quiet(9), at(4));
    expect(step.done[0]!.command).toBe("one two three");
  });

  test("a new wake phrase while pending starts a new command", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, first", 0, 1), cfg, quiet(2), at(2));
    const step = a.push(utt("Hey Hermes, second", 1.5, 2.5), cfg, quiet(2.5), at(4));
    expect(step.done.map((c) => c.command)).toEqual(["first", "second"]);
  });
});
