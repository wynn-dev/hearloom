import { describe, expect, test } from "bun:test";
import {
  aliasWorthLearning,
  alignTeach,
  cleanCommand,
  matchWake,
  nearWake,
  phoneticKey,
  teachPhrase,
  textSimilarity,
  type WakeConfig,
} from "./wake";

const cfg: WakeConfig = { names: ["Hermes"], aliases: [] };

describe("matchWake", () => {
  test.each([
    ["Hey Hermes, remind me to call mom at six.", "Hermes", "remind me to call mom at six."],
    ["hey hermès what's the weather", "hermès", "what's the weather"],
    ["Hé Hermes, hoe laat is het?", "Hermes", "hoe laat is het?"],
    ["OK Hermes: set a timer", "Hermes", "set a timer"],
    ["Um, hey Hermes, what time is it", "Hermes", "what time is it"],
    ["Hey Hermis, what's up", "Hermis", "what's up"],
    ["Hoi Harmes. Bel mama.", "Harmes", "Bel mama."],
  ])("%s", (text, heardAs, command) => {
    const m = matchWake(text, cfg);
    expect(m).not.toBeNull();
    expect(m!.name).toBe("Hermes");
    expect(m!.heardAs).toBe(heardAs);
    expect(m!.command).toBe(command);
  });

  test("wake word alone has an empty command", () => {
    expect(matchWake("Hey Hermes.", cfg)?.command).toBe("");
    expect(matchWake("Hey Hermes. Um.", cfg)?.command).toBe("");
  });

  test.each([
    "I asked Hermes yesterday",
    "Hermes, what's the weather",
    "hey there Hermes's bag",
    "so I said hey Hermes to him",
    "hey Thomas, how are you",
    "",
  ])("no match: %s", (text) => {
    expect(matchWake(text, cfg)).toBeNull();
  });

  test("after a sentence end inside the utterance", () => {
    const m = matchWake("Okay, thanks. Hey Hermes, call Anna.", cfg);
    expect(m?.command).toBe("call Anna.");
    expect(m?.start).toBe(14);
  });

  test("scores: exact, alias, fuzzy, phonetic", () => {
    expect(matchWake("hey hermes x", cfg)?.score).toBe(1);
    expect(matchWake("hey hermis x", cfg)?.score).toBe(0.9);
    expect(matchWake("hey air mess x", { ...cfg, aliases: ["air mess"] })?.score).toBe(1);
    expect(matchWake("hey hurmass x", cfg)?.score).toBe(0.85);
    // Same key, but too much longer than the name.
    expect(matchWake("hey hairmesses x", cfg)).toBeNull();
  });

  test("split names only match as a learned alias", () => {
    expect(matchWake("Hey her mess, turn on the lights", cfg)).toBeNull();
    const learned = { ...cfg, aliases: ["her mess"] };
    expect(matchWake("Hey her mess, turn on the lights", learned)).toMatchObject({
      heardAs: "her mess",
      command: "turn on the lights",
      score: 1,
    });
    // Not across punctuation, even as an alias.
    expect(matchWake("Hey her, mess everything up", learned)).toBeNull();
  });

  // Everyday speech whose consonants spell HRMS (review of #30): must never fire.
  test.each([
    "Okay, her mom's coming over tonight.",
    "Oh hi, Harry Moss is here.",
    "Hey, hurry, miss, the bus is leaving",
    "Hey, her moms are at the door.",
    "Hey, harm us and you'll regret it",
    "Hi her mess is everywhere",
    "Hey Hermione, come here",
    "OK, hers is the red one",
  ])("everyday speech: %s", (text) => {
    expect(matchWake(text, cfg)).toBeNull();
  });

  test("blocked spellings are not fuzzy-matched", () => {
    expect(matchWake("hey herpes do it", cfg)).not.toBeNull();
    expect(matchWake("hey herpes do it", { ...cfg, blocked: ["herpes"] })).toBeNull();
    expect(matchWake("hey hermes do it", { ...cfg, blocked: ["herpes"] })).not.toBeNull();
  });

  test("multi-word names and short names", () => {
    const c = { names: ["Mister Robot"], aliases: [] };
    expect(matchWake("Hey Mister Robot, play music", c)?.command).toBe("play music");
    const short = { names: ["Max"], aliases: [] };
    expect(matchWake("hey max, lights off", short)?.command).toBe("lights off");
    expect(matchWake("hey may, lights off", short)).toBeNull();
  });

  test("keeps the command's casing and punctuation", () => {
    expect(matchWake("hey Hermes — Email ANNA: “Running late!”", cfg)?.command).toBe(
      "Email ANNA: “Running late!”",
    );
  });
});

test("phoneticKey folds similar spellings", () => {
  expect(phoneticKey("Hermes")).toBe("HRMS");
  expect(phoneticKey("her mess")).toBe("HRMS");
  expect(phoneticKey("harmes")).toBe("HRMS");
  expect(phoneticKey("herpes")).not.toBe("HRMS");
});

test("cleanCommand", () => {
  expect(cleanCommand(", do it.")).toBe("do it.");
  expect(cleanCommand(" — um")).toBe("");
});

test("textSimilarity", () => {
  expect(textSimilarity("Hey Hermes, call mom", "hey hermes call mom")).toBe(1);
  expect(textSimilarity("a b c d", "a b c x")).toBe(0.75);
});

describe("alignTeach", () => {
  test("finds how the name was heard", () => {
    const a = alignTeach(
      "Hey, air miss, what's the weather tomorrow?",
      teachPhrase("Hermes", 1),
      cfg,
    );
    expect(a).toEqual({ ok: true, heardAs: "air miss", nameScore: 0, wouldMatch: false });
  });

  test("wake-only prompt", () => {
    const a = alignTeach("Hey Hermes.", teachPhrase("Hermes", 0), cfg);
    expect(a).toEqual({ ok: true, heardAs: "Hermes", nameScore: 1, wouldMatch: true });
  });

  test("something else entirely", () => {
    expect(alignTeach("Hey, can you pass the salt please", teachPhrase("Hermes", 1), cfg).ok).toBe(
      false,
    );
    expect(alignTeach("Where are my keys", teachPhrase("Hermes", 0), cfg).heardAs).toBeNull();
  });
});

test("aliasWorthLearning", () => {
  expect(aliasWorthLearning("air miss", cfg, 1)).toBe(false);
  expect(aliasWorthLearning("air miss", cfg, 2)).toBe(true);
  expect(aliasWorthLearning("Hermus", cfg, 1)).toBe(true);
  expect(aliasWorthLearning("Hermes", cfg, 5)).toBe(false);
  expect(aliasWorthLearning("hey", cfg, 5)).toBe(false);
  expect(aliasWorthLearning("air miss", { ...cfg, aliases: ["Air Miss"] }, 3)).toBe(false);
  // Several words: heard twice (or confirmed by the user) even when it looks like the name.
  expect(aliasWorthLearning("her mess", cfg, 1)).toBe(false);
  expect(aliasWorthLearning("her mess", cfg, 2)).toBe(true);
  expect(aliasWorthLearning("Hermus", cfg, 1)).toBe(true);
});

test("nearWake", () => {
  expect(nearWake("Hey hermit, what's up", cfg)).toMatchObject({
    heardAs: "hermit",
    command: "what's up",
  });
  expect(nearWake("Hey Hermes, what's up", cfg)).toBeNull();
  expect(nearWake("Hey Anna, what's up", cfg)).toBeNull();
  expect(nearWake("I met a hermit", cfg)).toBeNull();
});
