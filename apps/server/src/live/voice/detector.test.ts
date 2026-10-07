import { describe, expect, test } from "bun:test";
import type { HeardUtterance } from "./assembler";
import {
  type AudioSource,
  commandThreshold,
  DEFAULT_MIN_SCORE,
  MAX_TRANSCRIPT_CHARS,
  TEACH_MIN_SELF,
  teachVoiceVerdict,
  VoiceDetector,
} from "./detector";
import type { TeachResult, VoiceConfig, VoiceDetection } from "./types";

const T = 1_800_000_000_000;

function setup(over: { config?: Partial<VoiceConfig>; self?: number | null; other?: number } = {}) {
  let now = T;
  const detections: VoiceDetection[] = [];
  const taught: TeachResult[] = [];
  const learned: number[] = [];
  const audioCalls: [number, number][] = [];
  const media = new Set<string>();
  const config: VoiceConfig = {
    mode: "on",
    wake: { names: ["Hermes"], aliases: [] },
    minScore: 0.65,
    ...over.config,
  };
  const scores = { self: over.self === undefined ? 0.8 : over.self, other: over.other ?? 0.2 };
  const detector = new VoiceDetector({
    config: async () => config,
    score: async () => ({ ...scores }),
    isMediaVoice: async (_u, chainId, key) => media.has(`${chainId}:${key}`),
    learn: async (_u, _p, audio) => {
      learned.push(audio.length);
      return "vp1";
    },
    detected: (d) => detections.push(d),
    taught: (_u, r) => taught.push(r),
    log: () => {},
    now: () => now,
  });
  let lastSpeech = 0;
  const source: AudioSource = {
    streamId: "s1",
    audio: (from, to) => {
      audioCalls.push([from - T, to - T]);
      return new Float32Array(Math.max(0, Math.round((to - from) * 16)));
    },
    lastSpeechAt: () => lastSpeech,
  };
  const say = async (
    text: string,
    startS: number,
    endS: number,
    o: Partial<HeardUtterance> = {},
  ) => {
    now = T + (endS + 1.5) * 1000;
    lastSpeech = T + endS * 1000;
    await detector.heard(
      "u1",
      {
        streamId: "s1",
        text,
        startAt: T + startS * 1000,
        endAt: T + endS * 1000,
        lang: "en",
        speakerKey: "S1",
        isSelf: true,
        chainId: "c1",
        ...o,
      },
      source,
    );
  };
  return {
    detector,
    detections,
    taught,
    learned,
    audioCalls,
    media,
    scores,
    say,
    setNow: (s: number) => {
      now = T + s * 1000;
    },
  };
}

describe("VoiceDetector", () => {
  test("delivers a verified command", async () => {
    const t = setup();
    await t.say("Hey Hermes, what's 17 times 23?", 0, 2.5);
    expect(t.detections).toHaveLength(1);
    expect(t.detections[0]).toMatchObject({
      status: "pending",
      reason: null,
      command: "what's 17 times 23?",
      wakeName: "Hermes",
      speakerScore: 0.8,
      spokenAt: T,
      endedAt: T + 2500,
    });
  });

  test("shadow mode records without delivering; off does nothing", async () => {
    const shadow = setup({ config: { mode: "shadow" } });
    await shadow.say("Hey Hermes, lights on", 0, 2);
    expect(shadow.detections[0]!.status).toBe("shadow");
    const off = setup({ config: { mode: "off" } });
    await off.say("Hey Hermes, lights on", 0, 2);
    expect(off.detections).toHaveLength(0);
  });

  test("own-voice gate", async () => {
    const none = setup({ self: null });
    await none.say("Hey Hermes, lights on", 0, 2);
    expect(none.detections[0]).toMatchObject({ status: "ignored", reason: "no_voiceprint" });

    const low = setup({ self: 0.5 });
    await low.say("Hey Hermes, lights on", 0, 2);
    expect(low.detections[0]).toMatchObject({
      status: "ignored",
      reason: "not_own_voice",
      speakerScore: 0.5,
    });

    const someoneElse = setup({ self: 0.7, other: 0.75 });
    await someoneElse.say("Hey Hermes, lights on", 0, 2);
    expect(someoneElse.detections[0]!.reason).toBe("not_own_voice");
  });

  test("media voices are ignored", async () => {
    const t = setup();
    t.media.add("c1:S4");
    await t.say("Hey Hermes, buy now", 0, 2, { speakerKey: "S4", isSelf: null });
    expect(t.detections[0]).toMatchObject({ status: "ignored", reason: "media_voice" });
  });

  test("duplicates from another stream are dropped silently; rate limit", async () => {
    const t = setup();
    await t.say("Hey Hermes, lights on", 0, 2);
    await t.say("Hey Hermes, lights on.", 0.2, 2, { streamId: "s2" });
    expect(t.detections).toHaveLength(1);
    // Within the 2 s cooldown.
    await t.say("Hey Hermes, lights off", 2.2, 3);
    expect(t.detections[1]).toMatchObject({ status: "ignored", reason: "rate_limited" });
  });

  test("bare wake word that times out is stored as no_command", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    t.setNow(12);
    await t.detector.tick();
    expect(t.detections[0]).toMatchObject({ status: "ignored", reason: "no_command" });
  });

  test("near misses from the user are stored", async () => {
    const t = setup();
    await t.say("Hey hermit, what's up", 0, 2);
    expect(t.detections[0]).toMatchObject({
      status: "ignored",
      reason: "near_miss",
      heardAs: "hermit",
    });
    await t.say("Hey Anna, what's up", 5, 7);
    expect(t.detections).toHaveLength(1);
  });

  test("teaching: matches the prompt, learns, and never sends a command", async () => {
    const t = setup({ self: 0.71 });
    const prompt = {
      sessionId: "t1",
      kind: "sample" as const,
      index: 1,
      phrase: "Hey Hermes, what's the weather tomorrow?",
      personId: "p1",
    };
    t.detector.setTeach("u1", prompt);
    await t.say("Hey her mess, what's the weather tomorrow?", 0, 2.5);
    expect(t.detections).toHaveLength(0);
    expect(t.learned).toHaveLength(1);
    expect(t.taught[0]).toMatchObject({
      ok: true,
      heardAs: "her mess",
      speakerScore: 0.71,
      voiceprintId: "vp1",
      // A split name only matches once it's learned as an alias.
      wouldMatch: false,
      wouldTrigger: false,
      source: "pendant",
    });
    // Too short for a voiceprint, still a sample.
    await t.say("Hey Hermes, what's the weather tomorrow?", 5, 5.6);
    expect(t.learned).toHaveLength(1);
    expect(t.taught[1]).toMatchObject({ ok: true, voiceprintId: null });
    // Something else.
    await t.say("Where did I put my keys?", 8, 10);
    expect(t.taught[2]).toMatchObject({ ok: false, voiceprintId: null });
  });

  test("self-test reports whether it would trigger", async () => {
    const t = setup({ self: 0.6 });
    t.detector.setTeach("u1", {
      sessionId: "t1",
      kind: "test",
      index: 0,
      phrase: "Hey Hermes",
      personId: "p1",
    });
    await t.say("Hey Hermes, test", 0, 2);
    expect(t.taught[0]).toMatchObject({ ok: true, wouldMatch: true, wouldTrigger: false });
    expect(t.learned).toHaveLength(0);
  });
});

describe("review fixes", () => {
  const prompt = {
    sessionId: "t1",
    kind: "sample" as const,
    index: 1,
    phrase: "Hey Hermes, what's the weather tomorrow?",
    personId: "p1",
  };

  test("teaching refuses someone else's voice", async () => {
    // Someone else (closer to another enrolled voice than to the user's) reads the prompt.
    const t = setup({ self: 0.1, other: 0.9 });
    t.detector.setTeach("u1", prompt);
    await t.say("Hey Hermes, what's the weather tomorrow?", 0, 2.5, { isSelf: false });
    expect(t.learned).toHaveLength(0);
    expect(t.taught[0]).toMatchObject({ ok: false, voiceprintId: null });
    expect(t.taught[0]!.error).toContain("didn't sound like you");
  });

  test("teaching refuses a voice below the floor even with no one else close", async () => {
    const t = setup({ self: TEACH_MIN_SELF - 0.05, other: 0 });
    t.detector.setTeach("u1", prompt);
    await t.say("Hey Hermes, what's the weather tomorrow?", 0, 2.5);
    expect(t.learned).toHaveLength(0);
    expect(t.taught[0]!.ok).toBe(false);
  });

  test("teachVoiceVerdict", () => {
    expect(teachVoiceVerdict(null)).not.toBeNull();
    // First sample: nothing to compare with, unless it's clearly someone else enrolled.
    expect(teachVoiceVerdict({ self: null, other: 0.2 })).toBeNull();
    expect(teachVoiceVerdict({ self: null, other: 0.7 })).not.toBeNull();
    expect(teachVoiceVerdict({ self: 0.7, other: 0.3 })).toBeNull();
    expect(teachVoiceVerdict({ self: 0.6, other: 0.65 })).not.toBeNull();
    expect(teachVoiceVerdict({ self: 0.4, other: 0 })).not.toBeNull();
  });

  test("own-voice check and parts use each utterance's span, not the gap between", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    t.audioCalls.length = 0;
    await t.say("What's on my calendar?", 5, 7);
    expect(t.audioCalls).toEqual([
      [0, 800],
      [5000, 7000],
    ]);
    expect(t.detections[0]!.parts).toEqual([
      { startAt: T, endAt: T + 800 },
      { startAt: T + 5000, endAt: T + 7000 },
    ]);
  });

  test("transcripts and commands are capped", async () => {
    const t = setup();
    const long = "word ".repeat(400);
    await t.say(`Hey Hermes, ${long}`, 0, 20);
    expect(t.detections[0]!.command.length).toBeLessThanOrEqual(500);
    expect(t.detections[0]!.transcript.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
  });

  test("a disposed stream's audio is dropped and idle users are forgotten", async () => {
    const t = setup();
    await t.say("Just talking.", 0, 2);
    expect(t.detector.userCount).toBe(1);
    t.detector.dropSource("other-stream");
    expect(t.detector.userCount).toBe(1);
    t.detector.dropSource("s1");
    expect(t.detector.userCount).toBe(0);
  });
});

test("commandThreshold", () => {
  expect(commandThreshold([])).toBe(DEFAULT_MIN_SCORE);
  expect(commandThreshold([0.8, 0.9])).toBe(DEFAULT_MIN_SCORE);
  expect(commandThreshold([0.7, 0.75, 0.8, 0.85, 0.9])).toBeCloseTo(0.65);
  expect(commandThreshold([0.3, 0.4, 0.5])).toBe(0.55);
  expect(commandThreshold([0.95, 0.95, 0.95])).toBe(0.75);
});
