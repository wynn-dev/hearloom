import { describe, expect, test } from "bun:test";
import { CommandAssembler, type HeardUtterance } from "./assembler";
import { type AudioSource, VoiceDetector } from "./detector";
import type { VoiceCueEvent, VoiceDetection } from "./types";

/** Commands whose audio or recognizer broke off mid-way are never sent. */

const cfg = { names: ["Hermes"], aliases: [] };
const T = 1_800_000_000_000;
const at = (s: number) => T + s * 1000;

function utt(text: string, startS: number, endS: number, over: Partial<HeardUtterance> = {}) {
  return {
    streamId: "s1",
    text,
    startAt: at(startS),
    endAt: at(endS),
    lang: "en",
    speakerKey: "S1",
    isSelf: true,
    chainId: "c1",
    ...over,
  } satisfies HeardUtterance;
}

describe("CommandAssembler: cut off", () => {
  test("a cut-off command is done at once, marked cut off", () => {
    const a = new CommandAssembler();
    // Still talking per the VAD: a whole command would wait for more.
    const step = a.push(
      utt("Hey Hermes, set a", 0, 1.5, { cutOff: true }),
      cfg,
      at(3),
      at(3),
      at(3),
    );
    expect(step.done).toHaveLength(1);
    expect(step.done[0]).toMatchObject({ command: "set a", cutOff: true });
    expect(a.busy).toBe(false);
  });

  test("a cut-off bare wake phrase isn't armed (its command may be what was lost)", () => {
    const a = new CommandAssembler();
    const step = a.push(utt("Hey Hermes", 0, 0.8, { cutOff: true }), cfg, at(0.8), at(2));
    expect(step.done[0]).toMatchObject({ command: "", cutOff: true });
    expect(a.busy).toBe(false);
    // What follows is not taken as its command.
    expect(a.push(utt("for five minutes", 2, 3), cfg, at(3), at(4.5)).done).toEqual([]);
  });

  test("a cut-off continuation cuts the command off", () => {
    const a = new CommandAssembler();
    expect(a.push(utt("Hey Hermes.", 0, 0.8), cfg, at(0.8), at(2)).done).toEqual([]);
    const step = a.push(utt("set a", 2, 3, { cutOff: true }), cfg, at(3), at(4));
    expect(step.done[0]).toMatchObject({ command: "set a", cutOff: true });
  });

  test("cut(): an open command fails, armed or pending", () => {
    const armed = new CommandAssembler();
    armed.push(utt("Hey Hermes.", 0, 0.8), cfg, at(0.8), at(2));
    expect(armed.cut().done[0]).toMatchObject({ command: "", cutOff: true });
    expect(armed.busy).toBe(false);

    const pending = new CommandAssembler();
    // Talking on after it: waits for a continuation.
    pending.push(utt("Hey Hermes, set a timer", 0, 2), cfg, at(4), at(3.5), at(4));
    expect(pending.busy).toBe(true);
    expect(pending.cut().done[0]).toMatchObject({ command: "set a timer", cutOff: true });
    expect(new CommandAssembler().cut().done).toEqual([]);
  });

  test("cut(before): only a command that started before it", () => {
    const a = new CommandAssembler();
    a.push(utt("Hey Hermes, set a timer", 5, 7), cfg, at(9), at(8.5), at(9));
    expect(a.cut(at(5)).done).toEqual([]);
    expect(a.busy).toBe(true);
    expect(a.cut(at(5.1)).done[0]).toMatchObject({ cutOff: true });
  });
});

function setup() {
  let now = T;
  let stall: "waiting" | "cut" | null = null;
  let lastSpeech = 0;
  let heardUntil = 0;
  let cutBefore = 0;
  const detections: VoiceDetection[] = [];
  const cues: VoiceCueEvent[] = [];
  const detector = new VoiceDetector({
    config: async () => ({ mode: "on", wake: cfg, minScore: 0.65, haptics: true }),
    score: async () => ({ self: 0.8, other: 0.2 }),
    isMediaVoice: async () => false,
    embed: async () => [],
    detected: (d) => detections.push(d),
    cue: (e) => cues.push(e),
    taught: () => {},
    log: () => {},
    now: () => now,
  });
  const source: AudioSource = {
    streamId: "s1",
    audio: (from, to) => new Float32Array(Math.max(0, Math.round((to - from) * 16))),
    lastSpeechAt: () => lastSpeech,
    heardUntil: () => heardUntil,
    stall: () => stall,
    cutBefore: () => cutBefore,
  };
  return {
    detector,
    detections,
    cues: () => cues.map((c) => c.cue),
    say: (u: HeardUtterance, nowS: number, speechS: number, heardS: number) => {
      now = at(nowS);
      lastSpeech = at(speechS);
      heardUntil = at(heardS);
      return detector.heard("u1", u, source);
    },
    set: (o: { nowS?: number; stall?: typeof stall; heardS?: number; cutBeforeS?: number }) => {
      if (o.nowS !== undefined) now = at(o.nowS);
      if (o.cutBeforeS !== undefined) cutBefore = at(o.cutBeforeS);
      if (o.stall !== undefined) stall = o.stall;
      if (o.heardS !== undefined) heardUntil = o.heardS === Infinity ? Infinity : at(o.heardS);
    },
  };
}

describe("VoiceDetector: cut off", () => {
  test("a cut-off command isn't sent: stored as cut_off, the pendant told it failed", async () => {
    const t = setup();
    await t.say(utt("Hey Hermes, set a", 0, 1.5, { cutOff: true }), 3, 1.5, 3);
    expect(t.detections).toHaveLength(1);
    expect(t.detections[0]).toMatchObject({ status: "ignored", reason: "cut_off" });
    expect(t.cues()).toEqual(["heard", "failed"]);
  });

  test("audio stalled mid-command: waits for it, then fails rather than send a cut command", async () => {
    const t = setup();
    // Still talking after the part: not done yet.
    await t.say(utt("Hey Hermes, set a timer", 0, 2), 3.5, 3.5, 3.5);
    expect(t.detections).toEqual([]);
    // Frames stopped mid-speech: even well past the continuation wait, nothing is sent.
    t.set({ nowS: 10, stall: "waiting" });
    await t.detector.tick();
    expect(t.detections).toEqual([]);
    // Given up on: the command was cut off.
    t.set({ nowS: 14, stall: "cut", heardS: Infinity });
    await t.detector.tick();
    expect(t.detections[0]).toMatchObject({ reason: "cut_off", command: "set a timer" });
    expect(t.cues()).toEqual(["heard", "failed"]);
  });

  test("audio resumed after a stall: the command completes as usual", async () => {
    const t = setup();
    await t.say(utt("Hey Hermes, set a timer", 0, 2), 3.5, 3.5, 3.5);
    t.set({ nowS: 6, stall: "waiting" });
    await t.detector.tick();
    expect(t.detections).toEqual([]);
    await t.say(utt("for five minutes", 3, 4.5), 9, 4.5, 8);
    expect(t.detections[0]).toMatchObject({
      status: "pending",
      command: "set a timer for five minutes",
    });
  });
});

describe("VoiceDetector: the recognizer broke off mid-command", () => {
  test("after a whole part: the command fails rather than send that part", async () => {
    const t = setup();
    // "Hey Hermes, set a timer" ended; the user talks on ("for five minutes")…
    await t.say(utt("Hey Hermes, set a timer", 0, 2), 3.5, 3.5, 3.5);
    // …and the live session drops meanwhile.
    t.set({ nowS: 4, cutBeforeS: 3.5 });
    await t.detector.tick();
    expect(t.detections[0]).toMatchObject({ reason: "cut_off", command: "set a timer" });
    expect(t.cues()).toEqual(["heard", "failed"]);
  });

  test("the next session's rest isn't appended and sent", async () => {
    const t = setup();
    await t.say(utt("Hey Hermes, set a timer", 0, 2), 3.5, 3.5, 3.5);
    t.set({ cutBeforeS: 3.5 });
    // Before a tick: the next session's words arrive first.
    await t.say(utt("minutes", 4.5, 5), 6.5, 5, 6.5);
    expect(t.detections.map((d) => [d.reason, d.command])).toEqual([["cut_off", "set a timer"]]);
  });

  test("a command started after the break is unaffected", async () => {
    const t = setup();
    t.set({ cutBeforeS: 3 });
    await t.say(utt("Hey Hermes, lights on", 5, 6.5), 8, 6.5, 8);
    expect(t.detections[0]).toMatchObject({ status: "pending", command: "lights on" });
  });

  test("a cut copy of a command another stream sent: dropped silently, no failed buzz", async () => {
    const t = setup();
    await t.say(utt("Hey Hermes, lights on", 0, 1.5), 3, 1.5, 3);
    await t.say(
      utt("Hey Hermes, lights on", 0.1, 1.4, { cutOff: true, streamId: "s2" }),
      3.2,
      1.2,
      3.2,
    );
    expect(t.detections.map((d) => d.status)).toEqual(["pending"]);
    expect(t.cues()).toEqual(["heard"]);
  });
});
