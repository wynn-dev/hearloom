import { describe, expect, test } from "bun:test";
import type { PartialUtterance } from "../asr/types";
import type { HeardUtterance } from "./assembler";
import {
  type AudioSource,
  CUE_CONFIRM_MS,
  commandThreshold,
  DEFAULT_MIN_SCORE,
  logLearnVerdict,
  MAX_TRANSCRIPT_CHARS,
  selfPrintVerdict,
  TEACH_GRACE_MS,
  TEACH_MIN_SELF,
  THRESHOLD_FLOOR,
  teachVoiceVerdict,
  VoiceDetector,
  type VoiceScore,
} from "./detector";
import type { TeachHeard, VoiceConfig, VoiceCueEvent, VoiceDetection } from "./types";

const T = 1_800_000_000_000;

function setup(
  over: {
    config?: Partial<VoiceConfig>;
    self?: number | null;
    other?: number;
    /** Score by clip length (s), instead of the fixed self/other. */
    scoreBySeconds?: (seconds: number) => VoiceScore | null;
  } = {},
) {
  let now = T;
  const detections: VoiceDetection[] = [];
  const cueEvents: VoiceCueEvent[] = [];
  const taught: TeachHeard[] = [];
  const learned: number[] = [];
  const audioCalls: [number, number][] = [];
  /** The stream each audio call went to. */
  const audioStreams: string[] = [];
  /** Lengths (s) of the clips scored. */
  const scored: number[] = [];
  const media = new Set<string>();
  const config: VoiceConfig = {
    mode: "on",
    wake: { names: ["Hermes"], aliases: [] },
    minScore: 0.65,
    haptics: true,
    ...over.config,
  };
  const scores = { self: over.self === undefined ? 0.8 : over.self, other: over.other ?? 0.2 };
  let scoreError: Error | null = null;
  const detector = new VoiceDetector({
    config: async () => config,
    score: async (_u, audio) => {
      if (scoreError) throw scoreError;
      scored.push(audio.length / 16_000);
      return over.scoreBySeconds ? over.scoreBySeconds(audio.length / 16_000) : { ...scores };
    },
    isMediaVoice: async (_u, chainId, key) => media.has(`${chainId}:${key}`),
    embed: async (audio) => {
      learned.push(audio.length);
      return [0.1, 0.2];
    },
    detected: (d) => detections.push(d),
    cue: (e) => cueEvents.push(e),
    taught: (_u, r) => taught.push(r),
    log: () => {},
    now: () => now,
  });
  let lastSpeech = 0;
  let heardUntil = 0;
  const sources = new Map<string, AudioSource>();
  /** Streams whose audio is no longer retained. */
  const noAudio = new Set<string>();
  const sourceFor = (streamId: string): AudioSource => {
    let src = sources.get(streamId);
    if (!src) {
      src = {
        streamId,
        audio: (from, to) => {
          audioCalls.push([from - T, to - T]);
          audioStreams.push(streamId);
          if (noAudio.has(streamId)) return null;
          return new Float32Array(Math.max(0, Math.round((to - from) * 16)));
        },
        lastSpeechAt: () => lastSpeech,
        heardUntil: () => heardUntil,
      };
      sources.set(streamId, src);
    }
    return src;
  };
  const source = sourceFor("s1");
  const say = async (
    text: string,
    startS: number,
    endS: number,
    o: Partial<HeardUtterance> = {},
  ) => {
    now = T + (endS + 1.5) * 1000;
    lastSpeech = T + endS * 1000;
    heardUntil = now;
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
      sourceFor(o.streamId ?? "s1"),
    );
  };
  /**
   * The recognizer's running transcript at `nowS`: `words` with their end times (s), audio sent
   * up to `audioS`.
   */
  const hear = (
    words: [string, number][],
    startS: number,
    audioS: number,
    nowS = audioS + 0.3,
    streamId = "s1",
  ) => {
    now = T + nowS * 1000;
    lastSpeech = T + audioS * 1000;
    heardUntil = T + audioS * 1000;
    let text = "";
    const tokens: PartialUtterance["tokens"] = [];
    let at = startS;
    for (const [w, endS] of words) {
      text += (text && !/^[,.?!]/.test(w) ? " " : "") + w;
      tokens.push({ offset: text.length, startAt: T + at * 1000, endAt: T + endS * 1000 });
      at = endS + 0.05;
    }
    return detector.partial(
      "u1",
      { text, startAt: T + startS * 1000, tokens, audioAt: T + audioS * 1000, speakerKey: "S1" },
      sourceFor(streamId),
    );
  };
  return {
    detector,
    detections,
    cueEvents,
    cues: () => cueEvents.map((e) => (e.via ? `${e.cue}:${e.via}` : e.cue)),
    hear,
    taught,
    learned,
    audioCalls,
    audioStreams,
    noAudio,
    scored,
    media,
    scores,
    say,
    source,
    failScoring: (err: Error | null) => {
      scoreError = err;
    },
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

    const clearlyNot = setup({ self: 0.3 });
    await clearlyNot.say("Hey Hermes, lights on", 0, 2);
    expect(clearlyNot.detections[0]).toMatchObject({
      reason: "not_own_voice",
      speakerScore: 0.3,
    });
  });

  test("the own-voice check scores padded audio (as teaching samples are)", async () => {
    const t = setup();
    await t.say("Hey Hermes, lights on", 10, 11.4);
    // 1.4 s of speech, 0.25 s either side.
    expect(t.audioCalls.at(-1)).toEqual([9750, 11650]);
    expect(t.scored.at(-1)).toBeCloseTo(1.9);
    expect(t.detections[0]!.status).toBe("pending");
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

  test("a misheard wake phrase is logged when it sounds like the user, tagged or not", async () => {
    // A bare "Hey Adri" is too short for the transcript to tag it as theirs.
    const near = setup({ self: 0.5 });
    await near.say("Hey hermit.", 0, 0.8, { isSelf: null });
    expect(near.detections[0]).toMatchObject({ reason: "near_miss", speakerScore: 0.5 });
    // Someone else's misheard "hey …": nothing logged, nothing buzzed.
    const other = setup({ self: 0.3 });
    await other.say("Hey hermit.", 0, 0.8, { isSelf: null });
    expect(other.detections).toHaveLength(0);
    expect(other.cues()).toEqual([]);
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
      // The embedding goes to the host, which stores it with the sample.
      embedding: [0.1, 0.2],
      // A split name only matches once it's learned as an alias.
      wouldMatch: false,
      wouldTrigger: false,
      source: "pendant",
    });
    // Too short for a voiceprint, still a sample.
    await t.say("Hey Hermes, what's the weather tomorrow?", 5, 5.6);
    expect(t.learned).toHaveLength(1);
    expect(t.taught[1]).toMatchObject({ ok: true, embedding: null });
    // Something else.
    await t.say("Where did I put my keys?", 8, 10);
    expect(t.taught[2]).toMatchObject({ ok: false, embedding: null });
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
    expect(t.taught[0]).toMatchObject({ ok: false, embedding: null });
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
    // Never below the lowest bar a command can need (review round 2): a 0.5 voice isn't learned.
    expect(TEACH_MIN_SELF).toBeGreaterThanOrEqual(THRESHOLD_FLOOR);
    expect(teachVoiceVerdict({ self: 0.5, other: 0 })).not.toBeNull();
    expect(teachVoiceVerdict({ self: 0.56, other: 0.2 })).toBeNull();
  });

  test("learning from the log needs the same bar as sending", () => {
    // A family member scoring 0.5 against the user (threshold 0.65) is not enrolled by a click.
    expect(logLearnVerdict({ self: 0.5, other: 0 }, 0.65)).not.toBeNull();
    expect(logLearnVerdict({ self: 0.64, other: 0 }, 0.65)).not.toBeNull();
    expect(logLearnVerdict({ self: 0.7, other: 0.72 }, 0.65)).not.toBeNull();
    expect(logLearnVerdict({ self: null, other: 0 }, 0.65)).not.toBeNull();
    expect(logLearnVerdict({ self: 0.66, other: 0.3 }, 0.65)).toBeNull();
  });

  test("selfPrintVerdict: no outliers, no copies; the first one is free", () => {
    // The first voiceprint: nothing to compare with, unless it's clearly someone else on file.
    expect(selfPrintVerdict({ self: null, other: 0.2 }, 0.57)).toBeNull();
    expect(selfPrintVerdict({ self: null, other: 0.7 }, 0.57)).not.toBeNull();
    // The real bad one: a "This is me" clip that scored 0.44 against the user's voice.
    expect(selfPrintVerdict({ self: 0.44, other: 0.2 }, 0.57)).not.toBeNull();
    expect(selfPrintVerdict({ self: 0.6, other: 0.65 }, 0.57)).not.toBeNull();
    // The same clip learned twice (cos 1.000).
    expect(selfPrintVerdict({ self: 1, other: 0.2 }, 0.57)).toContain("Already learned");
    expect(selfPrintVerdict({ self: 0.985, other: 0.2 }, 0.57)).toContain("Already learned");
    expect(selfPrintVerdict({ self: 0.7, other: 0.2 }, 0.57)).toBeNull();
  });

  test("teaching the same clip again adds a sample, not a second voiceprint", async () => {
    const t = setup({ self: 0.99 });
    t.detector.setTeach("u1", prompt);
    await t.say("Hey Hermes, what's the weather tomorrow?", 0, 2.5);
    expect(t.taught[0]).toMatchObject({ ok: true, embedding: null });
    expect(t.learned).toHaveLength(0);
  });

  test("the last teaching phrase, finalized after Done, is not a command", async () => {
    const t = setup();
    t.detector.setTeach("u1", prompt);
    t.setNow(3); // Done pressed right after saying the phrase (spoken 0–2.5 s)
    t.detector.setTeach("u1", null);
    // Its final arrives ~1.5 s later, then the user says something else within the grace.
    await t.say("Hey Hermes, what's the weather tomorrow?", 0, 2.5);
    await t.say("Hey Hermes, remind me to call mom at six", 5, 7);
    expect(t.detections).toHaveLength(0);
    expect(t.taught).toHaveLength(0);
    // Speech that starts after the grace is a command again.
    const after = 3 + TEACH_GRACE_MS / 1000 + 1;
    await t.say("Hey Hermes, what time is it?", after, after + 2);
    expect(t.detections).toHaveLength(1);
    expect(t.detections[0]!.status).toBe("pending");
  });

  test("own-voice check and parts use each utterance's span, not the gap between", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    t.audioCalls.length = 0;
    await t.say("What's on my calendar?", 5, 7);
    // Each padded.
    expect(t.audioCalls).toEqual([
      [-250, 1050],
      [4750, 7250],
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
  const long = (...scores: number[]) => scores.map((score) => ({ score, seconds: 3.2 }));
  const short = (...scores: number[]) => scores.map((score) => ({ score, seconds: 1.6 }));
  expect(commandThreshold([])).toBe(DEFAULT_MIN_SCORE);
  expect(commandThreshold(long(0.8, 0.9))).toBe(DEFAULT_MIN_SCORE);
  expect(commandThreshold(long(0.7, 0.75, 0.8, 0.85, 0.9))).toBeCloseTo(0.65);
  // Never under the floor, never over 0.75.
  expect(commandThreshold(long(0.3, 0.4, 0.5))).toBe(THRESHOLD_FLOOR);
  expect(THRESHOLD_FLOOR).toBe(0.45);
  expect(commandThreshold(long(0.95, 0.95, 0.95))).toBe(0.75);
  // Tuned on command-length samples when there are enough: they score lower than long ones.
  expect(commandThreshold([...long(0.7, 0.72, 0.75, 0.8), ...short(0.55, 0.6, 0.62)])).toBeCloseTo(
    0.5,
  );
  // Too few of them: all samples.
  expect(commandThreshold([...long(0.7, 0.72, 0.75, 0.8), ...short(0.55, 0.6)])).toBeCloseTo(0.55);
});

describe("pendant cues", () => {
  test("a one-breath command: heard when it's finished (the server buzzes sent)", async () => {
    const t = setup();
    await t.say("Hey Hermes, what's 17 times 23?", 0, 2.5);
    expect(t.cues()).toEqual(["heard:final"]);
    expect(t.cueEvents[0]).toMatchObject({ userId: "u1", nameEndAt: T + 2500, at: T + 4000 });
    expect(t.detections[0]!.status).toBe("pending");
  });

  test("heard from the running transcript, before the utterance is finished", async () => {
    const t = setup();
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes,", 0.8],
        ["what's", 1.1],
      ],
      0,
      1.2,
    );
    expect(t.cues()).toEqual(["heard:partial"]);
    expect(t.cueEvents[0]).toMatchObject({ nameEndAt: T + 800, at: T + 1500 });
    // Later guesses and the finished utterance don't buzz again.
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes,", 0.8],
        ["what's", 1.1],
        ["17", 1.6],
      ],
      0,
      1.7,
    );
    await t.say("Hey Hermes, what's 17 times 23?", 0, 2.5);
    expect(t.cues()).toEqual(["heard:partial"]);
    expect(t.detections[0]!.status).toBe("pending");
  });

  test("a name at the end of the running transcript waits until it can't grow", async () => {
    const t = setup();
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes", 0.8],
      ],
      0,
      1.0,
    );
    expect(t.cues()).toEqual([]);
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes", 0.8],
      ],
      0,
      1.3,
    );
    expect(t.cues()).toEqual(["heard:partial"]);
  });

  test("clearly not the user's voice: no buzz at all", async () => {
    for (const voice of [
      { self: 0.31, other: 0.2 },
      // Closer to someone else on file than to the user.
      { self: 0.55, other: 0.6 },
    ]) {
      const t = setup(voice);
      await t.hear(
        [
          ["Hey", 0.3],
          ["Hermes,", 0.8],
          ["what's", 1.1],
        ],
        0,
        1.2,
      );
      await t.say("Hey Hermes, what's 17 times 23?", 0, 2.5);
      expect(t.cues()).toEqual([]);
      expect(t.detections[0]).toMatchObject({ reason: "not_own_voice", speakerScore: voice.self });
    }
  });

  test("a near miss of the user's own voice: no tap, but told it failed, and recorded", async () => {
    // Above the floor, under the bar (0.65), closer to the user than to anyone else.
    const t = setup({ self: 0.52, other: 0.31 });
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes,", 0.8],
        ["what's", 1.1],
      ],
      0,
      1.2,
    );
    await t.say("Hey Hermes, what's 17 times 23?", 0, 2.5);
    expect(t.cues()).toEqual(["failed"]);
    expect(t.detections[0]).toMatchObject({
      status: "ignored",
      reason: "not_own_voice",
      speakerScore: 0.52,
    });
    // Another stream's copy of the same words isn't told again.
    await t.say("Hey Hermes, what's 17 times 23?", 0.05, 2.5, { streamId: "s2" });
    expect(t.cues()).toEqual(["failed"]);
  });

  test("a near miss in shadow mode or with buzzes off: recorded, never buzzed", async () => {
    for (const config of [{ haptics: false }, { mode: "shadow" as const }]) {
      const t = setup({ self: 0.52, config });
      await t.say("Hey Hermes, lights on", 0, 2);
      expect(t.cues()).toEqual([]);
      expect(t.detections[0]).toMatchObject({ reason: "not_own_voice", speakerScore: 0.52 });
    }
  });

  test("a near miss is scored again after the user's recent speech on the same stream", async () => {
    // Short clips score low; with 3 s more of the same voice it's clear.
    const t = setup({
      scoreBySeconds: (s) => ({ self: s >= 4 ? 0.7 : 0.55, other: 0.25 }),
    });
    await t.say("I'm going to take the dog out now.", 0, 4, { isSelf: true });
    t.audioCalls.length = 0;
    await t.say("Hey Hermes, lights on", 10, 11.4, { isSelf: null });
    expect(t.detections.at(-1)).toMatchObject({ status: "pending", speakerScore: 0.7 });
    // The last 3 s of that speech, then the padded command.
    expect(t.audioCalls).toContainEqual([1000, 4000]);
    expect(t.scored.at(-1)).toBeCloseTo(3 + 1.9);
    expect(t.cues()).toEqual(["heard:final"]);
  });

  test("earlier speech from another stream, or someone else's, isn't used", async () => {
    const byLength = (s: number) => ({ self: s >= 4 ? 0.7 : 0.55, other: 0.25 });
    const other = setup({ scoreBySeconds: byLength });
    await other.say("I'm going to take the dog out now.", 0, 4, { isSelf: true, streamId: "s2" });
    await other.say("Hey Hermes, lights on", 10, 11.4, { isSelf: null });
    expect(other.detections.at(-1)).toMatchObject({ reason: "not_own_voice", speakerScore: 0.55 });
    expect(other.cues()).toEqual(["failed"]);

    const untagged = setup({ scoreBySeconds: byLength });
    await untagged.say("I'm going to take the dog out now.", 0, 4, { isSelf: null });
    await untagged.say("Hey Hermes, lights on", 10, 11.4, { isSelf: null });
    expect(untagged.detections.at(-1)!.reason).toBe("not_own_voice");

    // A voice that doesn't sound like the user's isn't carried over the bar by theirs.
    const stranger = setup({ scoreBySeconds: (s) => ({ self: s >= 4 ? 0.7 : 0.3, other: 0.2 }) });
    await stranger.say("I'm going to take the dog out now.", 0, 4, { isSelf: true });
    await stranger.say("Hey Hermes, lights on", 10, 11.4, { isSelf: null });
    expect(stranger.detections.at(-1)).toMatchObject({
      reason: "not_own_voice",
      speakerScore: 0.3,
    });
    expect(stranger.cues()).toEqual([]);
  });

  test("the own-voice check breaks: recorded as check_error, told it failed", async () => {
    const t = setup();
    t.failScoring(new Error("db down"));
    await t.say("Hey Hermes, lights on", 0, 2);
    expect(t.detections[0]).toMatchObject({ status: "ignored", reason: "check_error" });
    expect(t.cues()).toEqual(["failed"]);
    // The detector keeps working.
    t.failScoring(null);
    await t.say("Hey Hermes, lights off", 10, 12);
    expect(t.detections[1]!.status).toBe("pending");
  });

  test("wake word alone, then nothing: heard, then no command", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    t.setNow(12);
    await t.detector.tick();
    expect(t.cues()).toEqual(["heard:final", "no_command"]);
    expect(t.detections[0]).toMatchObject({ reason: "no_command" });
  });

  test("wake word, then someone else talks: no command", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    await t.say("Dinner's ready!", 2, 3, { speakerKey: "S2", isSelf: false });
    expect(t.cues()).toEqual(["heard:final", "no_command"]);
  });

  test("wake word, then the command: heard once", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    await t.say("What's the weather tomorrow?", 2.5, 4.5);
    expect(t.cues()).toEqual(["heard:final"]);
    expect(t.detections[0]!.status).toBe("pending");
  });

  test("heard, then rejected here: failed", async () => {
    const t = setup();
    await t.say("Hey Hermes, lights on", 0, 2);
    // Within the 2 s cooldown.
    await t.say("Hey Hermes, lights off", 2.2, 3);
    expect(t.cues()).toEqual(["heard:final", "heard:final", "failed"]);
    expect(t.detections[1]!.reason).toBe("rate_limited");

    const media = setup();
    media.media.add("c1:S4");
    await media.say("Hey Hermes, buy now", 0, 2, { speakerKey: "S4" });
    expect(media.cues()).toEqual(["heard:final", "failed"]);
  });

  test("the running transcript's wake phrase isn't in the finished utterance: no command", async () => {
    const t = setup();
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes,", 0.8],
        ["house", 1.1],
      ],
      0,
      1.2,
    );
    await t.say("Hey, her messy house.", 0, 1.5);
    expect(t.cues()).toEqual(["heard:partial", "no_command"]);
    expect(t.detections.map((d) => d.status)).not.toContain("pending");
  });

  test("the running utterance never finishes: no command, after a while", async () => {
    const t = setup();
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes,", 0.8],
        ["what's", 1.1],
      ],
      0,
      1.2,
    );
    // Still being spoken (and recognized) after the confirm window: no verdict yet.
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes,", 0.8],
        ["what's", 1.1],
      ],
      0,
      10,
      11,
    );
    t.setNow(1.5 + CUE_CONFIRM_MS / 1000);
    await t.detector.tick();
    expect(t.cues()).toEqual(["heard:partial"]);
    t.setNow(11.5 + CUE_CONFIRM_MS / 1000);
    await t.detector.tick();
    expect(t.cues()).toEqual(["heard:partial", "no_command"]);
  });

  test("no buzzes with haptics off, in shadow mode, or while teaching", async () => {
    for (const config of [{ haptics: false }, { mode: "shadow" as const }]) {
      const t = setup({ config });
      await t.hear(
        [
          ["Hey", 0.3],
          ["Hermes,", 0.8],
          ["what's", 1.1],
        ],
        0,
        1.2,
      );
      await t.say("Hey Hermes, what's 17 times 23?", 0, 2.5);
      await t.say("Hey Hermes.", 5, 5.8, { isSelf: null });
      t.setNow(20);
      await t.detector.tick();
      expect(t.cues()).toEqual([]);
      expect(t.detections.length).toBeGreaterThan(0);
    }
    const t = setup();
    t.detector.setTeach("u1", {
      sessionId: "t1",
      kind: "sample",
      index: 0,
      phrase: "Hey Hermes",
      personId: "p1",
    });
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes", 0.8],
      ],
      0,
      1.3,
    );
    await t.say("Hey Hermes", 0, 0.8);
    expect(t.cues()).toEqual([]);
  });
});

describe("pendant cues: one tap, one outcome", () => {
  test("two streams hear the same command: one tap, one outcome", async () => {
    const t = setup();
    await t.say("Hey Hermes, lights on", 0, 2);
    await t.say("Hey Hermes, lights on.", 0.05, 2, { streamId: "s2" });
    expect(t.cues()).toEqual(["heard:final"]);
    expect(t.detections).toHaveLength(1);
  });

  test("another stream's running transcript of a told wake phrase doesn't tap again", async () => {
    const t = setup();
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes,", 0.8],
        ["lights", 1.1],
      ],
      0,
      1.2,
    );
    await t.say("Hey Hermes, lights on", 0, 2);
    await t.hear(
      [
        ["Hey", 0.35],
        ["Hermes,", 0.85],
        ["lights", 1.15],
      ],
      0.05,
      1.25,
      3.6,
      "s2",
    );
    expect(t.cues()).toEqual(["heard:partial"]);
  });

  test("words before the wake phrase, split off later, aren't its outcome", async () => {
    const t = setup();
    const words: [string, number][] = [
      ["I'm", 0.3],
      ["off.", 0.6],
      ["Hey", 1.6],
      ["Hermes,", 2.0],
      ["call", 2.3],
    ];
    await t.hear(words, 0, 2.4);
    expect(t.cues()).toEqual(["heard:partial"]);
    // The tap's voice check used the wake phrase's audio (from "Hey", 0.65 s), not the words
    // before it.
    expect(t.audioCalls.at(-1)![0]).toBe(650 - 250);
    await t.say("I'm off.", 0, 0.6);
    // Still being said 12 s later (its running utterance now starts at the greeting).
    await t.hear(
      [
        ["Hey", 1.6],
        ["Hermes,", 2.0],
        ["call", 2.3],
      ],
      1.55,
      12,
      12.3,
    );
    t.setNow(13 + CUE_CONFIRM_MS / 1000 - 1);
    await t.detector.tick();
    await t.say("Hey Hermes, call mom and dad.", 1.55, 13);
    expect(t.cues()).toEqual(["heard:partial"]);
    expect(t.detections.at(-1)!.status).toBe("pending");
  });

  test("another stream's misheard copy doesn't reject the tap", async () => {
    const t = setup();
    await t.hear(
      [
        ["Hey", 0.3],
        ["Hermes,", 0.8],
        ["call", 1.1],
      ],
      0,
      1.2,
    );
    await t.say("Hey, her mess call mom.", 0, 2, { streamId: "s2" });
    await t.say("Hey Hermes, call mom.", 0, 2);
    expect(t.cues()).toEqual(["heard:partial"]);
    expect(t.detections.at(-1)!.status).toBe("pending");
  });

  test("an utterance that only touches the wake phrase isn't its outcome", async () => {
    const t = setup();
    const words: [string, number][] = [
      ["I'm", 0.3],
      ["off.", 0.6],
      ["Hey", 1.0],
      ["Hermes,", 1.4],
      ["call", 1.7],
    ];
    await t.hear(words, 0, 1.8);
    // Someone else's words, ending exactly where the greeting starts (0.65 s).
    await t.say("I'm off.", 0, 0.65, { speakerKey: "S2", isSelf: false });
    await t.say("Hey Hermes, call mom.", 0.65, 2.4);
    expect(t.cues()).toEqual(["heard:partial"]);
    expect(t.detections.at(-1)!.status).toBe("pending");
  });

  test("too short to check the voice: no tap, as the command isn't sent either", async () => {
    // 0.25 s of words: 0.75 s padded, under the 0.8 s the check needs.
    const t = setup();
    await t.say("Hey Hermes, stop", 0, 0.25);
    expect(t.cues()).toEqual([]);
    expect(t.detections[0]!.reason).toBe("clip_too_short");
    // 0.7 s of words is enough once padded.
    const padded = setup();
    await padded.say("Hey Hermes, stop", 0, 0.7);
    expect(padded.detections[0]!.status).toBe("pending");
  });

  test("no voiceprint yet: said so (not mistaken for missing audio)", async () => {
    const t = setup({ self: null });
    await t.say("Hey Hermes, stop", 0, 1.5);
    expect(t.detections[0]!.reason).toBe("no_voiceprint");
  });

  test("a command across a reconnect: each part's audio from its own stream", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    t.audioCalls.length = 0;
    t.audioStreams.length = 0;
    await t.say("What's on my calendar?", 3, 5, { streamId: "s2" });
    expect(t.audioStreams).toEqual(["s1", "s2"]);
    expect(t.audioCalls).toEqual([
      [-250, 1050],
      [2750, 5250],
    ]);
    expect(t.detections[0]!.status).toBe("pending");
  });

  test("the wake phrase's stream is gone: the rest is checked; none left: clip_missing", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    t.detector.dropSource("s1");
    t.audioStreams.length = 0;
    await t.say("What's on my calendar?", 3, 5, { streamId: "s2" });
    expect(t.audioStreams).toEqual(["s2"]);
    expect(t.detections[0]!.status).toBe("pending");

    // The stream no longer has the audio: not mistaken for "no voiceprint".
    const gone = setup();
    gone.noAudio.add("s3");
    await gone.say("Hey Hermes, what's on my calendar?", 0, 2, { streamId: "s3" });
    expect(gone.detections[0]!.reason).toBe("clip_missing");
    expect(gone.cues()).toEqual([]);
  });

  test("the stream ends while waiting for the command: no command", async () => {
    const t = setup();
    await t.say("Hey Hermes.", 0, 0.8, { isSelf: null });
    t.detector.dropSource("s1");
    t.setNow(3);
    await t.detector.tick();
    t.setNow(12);
    await t.detector.tick();
    expect(t.cues()).toEqual(["heard:final", "no_command"]);
  });
});
