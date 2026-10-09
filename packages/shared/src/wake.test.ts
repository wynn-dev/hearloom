import { describe, expect, test } from "bun:test";
import {
  aliasWorthLearning,
  alignTeach,
  cleanCommand,
  isGreetingOnly,
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
  expect(cleanCommand(", uh, do it.")).toBe("do it.");
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

describe("matchWake: greetings and lead-ins (EN + NL)", () => {
  const adri: WakeConfig = { names: ["Adri"], aliases: [] };

  test.each([
    ["Oké Adri, wat is het weer morgen?", "wat is het weer morgen?"],
    ["Okee Adri, zet een timer.", "zet een timer."],
    ["Hai Adri, hoe gaat het?", "hoe gaat het?"],
    ["Ey Adri, lights off.", "lights off."],
    ["Heej Adri, bel mama.", "bel mama."],
    ["Hey hey Adri, what time is it?", "what time is it?"],
    ["OK, hey Adri, what time is it?", "what time is it?"],
    ["Hoi hoi Adri, hoe laat is het?", "hoe laat is het?"],
    ["Yeah, hey Adri, what time is it?", "what time is it?"],
    ["And hey Adri, what time is it?", "what time is it?"],
    ["Alright, hey Adri, what time is it?", "what time is it?"],
    ["Okay so hey Adri, what time is it?", "what time is it?"],
    ["Um uh so hey Adri, what time is it?", "what time is it?"],
    ["Hey there Adri, what time is it?", "what time is it?"],
    ["Hey, Adri, what time is it?", "what time is it?"],
    ["Ja, hoi Adri, hoe laat is het?", "hoe laat is het?"],
    ["En hé Adri, zet de lampen uit.", "zet de lampen uit."],
  ])("%s", (text, command) => {
    const m = matchWake(text, adri);
    expect(m).toMatchObject({ name: "Adri", heardAs: "Adri", command, start: 0 });
    expect(text.slice(m!.commandStart)).toBe(command);
  });

  test.each([
    ["I'm off—hey Adri, call mom.", "call mom.", 8],
    ["I'm off — Hey Adri, call mom.", "call mom.", 10],
    ["Ik ga – hoi Adri, bel mama.", "bel mama.", 8],
    ["I'm off, hey Adri, call mom.", "call mom.", 9],
    ["Thanks, so hey Adri, call mom.", "call mom.", 8],
    ["Dank je, oké Adri, bel mama.", "bel mama.", 9],
  ])("inside an utterance: %s", (text, command, start) => {
    expect(matchWake(text, adri)).toMatchObject({ command, start });
  });

  test("after a comma only an exact name counts; after a sentence end a close one does", () => {
    expect(matchWake("I'm off, hey Adrie, call mom.", adri)).toBeNull();
    expect(matchWake("I'm off. Hey Adrie, call mom.", adri)).toMatchObject({ score: 0.9 });
    expect(
      matchWake("I'm off, hey her mess, call mom.", { ...adri, aliases: ["her mess"] }),
    ).toMatchObject({ heardAs: "her mess", command: "call mom." });
  });

  test("a close name only right after hey/hi/hello/hoi/hallo, first at a sentence start", () => {
    for (const g of ["Hey", "Hi", "Hello", "Hoi", "Hallo", "Um, hey"])
      expect(matchWake(`${g} Adrie, call mom.`, adri)).toMatchObject({ score: 0.9 });
    for (const g of ["Oké", "OK", "Okee", "Okay", "Hai", "Ey", "Heej", "Hé", "Yo", "Hey hey"])
      expect(matchWake(`${g} Adrie, call mom.`, adri)).toBeNull();
    for (const g of ["Yeah, hey", "And hey", "Ja, hoi", "OK, hey", "Okay so hey"])
      expect(matchWake(`${g} Adrie, call mom.`, adri)).toBeNull();
    // A learned alias is exact.
    expect(matchWake("Oké Adrie, bel mama.", { ...adri, aliases: ["Adrie"] })).toMatchObject({
      score: 1,
      command: "bel mama.",
    });
  });

  // Dutch in Wynn's own voice: "ieder(e)" sounds like "Adri" (phonetic key ADR).
  test.each([
    "Oké, iedere keer als ik dit doe gaat het mis.",
    "Oké, ieder geval doen we dat morgen.",
    "Okee, iedere dinsdag is er training.",
    "Ja oké iedere keer weer.",
    "Hé, ieder geval niet vandaag.",
    "Hey, ieder geval niet vandaag.",
    "Hoi, iedere keer hetzelfde.",
    "OK, ieder jaar weer.",
    "Ok iedere keer.",
    "Nou, oké, iedere keer.",
  ])("Dutch everyday speech: %s", (text) => {
    expect(matchWake(text, adri)).toBeNull();
  });

  // Reported speech: someone quoting a command isn't giving one.
  test.each([
    "You just say, hey Adri, turn off the lights.",
    "He said, hey Adri, can you delete the folder?",
    "Ik zei, hé Adri, zet de muziek uit.",
    "I told him — hey Adri — send the mail.",
    "Then she asked, hey Adri, what's the weather?",
    "En dan zeg je, hoi Adri, wis alles.",
    "He was like, hey Adri, delete it.",
    "So I told him—hey Adri, send it.",
    // A comma after a longer clause or one that doesn't close anything.
    "We should probably go home, hey Adri, shut down the server.",
    "Delete the folder, hey Adri.",
    // Narration: talking about the agent.
    "Hey, Adri said she'd come.",
    "Hey Adri said she'd come.",
    "Okay, so, hey, Adri said she'd come.",
    "OK there Adri said no.",
    "Hey there, Adri.",
  ])("reported speech and narration: %s", (text) => {
    expect(matchWake(text, adri)).toBeNull();
  });

  test.each([
    // A bare name never counts, lead-ins or not.
    "Yeah Adri, call mom.",
    "And Adri said hi.",
    "So, Adri, what do you think?",
    "Ja Adri, dat klopt.",
    "Hey, so Adri, call mom.",
    // Inside a sentence.
    "I told him hey Adri was late.",
    "She said hoi Adri and left.",
    "We went to see Adri, hey.",
    // After a comma, a greeting set off by commas is an interjection, not addressing Adri.
    "Then, hey, Adri said she'd come.",
    "And hey, Adri said she'd come.",
    "and hey, Adrian said he'd come",
    // Close spellings after a comma or "hey there".
    "Sure, hi Adrian, nice to meet you.",
    "Hey there Adri's bag is here.",
    // Greetings without a name.
    "Hey hey hey, look at that.",
    "Oké, dat is goed.",
    // A hyphen inside a word isn't a sentence break.
    "a well-hey Adri thing",
  ])("no match: %s", (text) => {
    expect(matchWake(text, adri)).toBeNull();
  });

  test("the wake phrase said twice: the command is what follows the last one", () => {
    const m = matchWake("Hey Adri, hey Adri, call mom.", adri);
    expect(m).toMatchObject({ command: "call mom.", start: 0, heardAs: "Adri" });
    expect(m!.commandStart).toBe(20);
    expect(matchWake("Hey Adri. Hey Adri.", adri)).toMatchObject({ command: "" });
    // Only an exact name: "hey Adrie, …" may be the start of the command.
    expect(matchWake("Hey Adri, hey Adrie, call mom.", adri)?.command).toBe("hey Adrie, call mom.");
    // Only right after it: a later wake phrase is part of the command.
    expect(matchWake("Hey Adri, tell Anna to say hey Adri.", adri)?.command).toBe(
      "tell Anna to say hey Adri.",
    );
  });

  test("hesitations are dropped from the start of the command", () => {
    expect(matchWake("Hey Adri, uh, what time is it?", adri)?.command).toBe("what time is it?");
    expect(matchWake("Hey Adri, um uh what time is it?", adri)?.command).toBe("what time is it?");
    // Words, not hesitations, are kept.
    expect(matchWake("Hey Adri, so what's next?", adri)?.command).toBe("so what's next?");
    expect(matchWake("Hey Adri, umbrella or not?", adri)?.command).toBe("umbrella or not?");
    expect(matchWake("Hey Adri, uh.", adri)).toMatchObject({ command: "", commandStart: 13 });
    // Dutch "er" is a word in a command, a filler only before the greeting.
    expect(matchWake("Hey Adri, er ligt nog post.", adri)?.command).toBe("er ligt nog post.");
    expect(matchWake("Er, hey Adri, call mom.", adri)?.command).toBe("call mom.");
  });

  test("nearWake doesn't report close names after a comma", () => {
    expect(nearWake("Sure, hi Adrian, nice to meet you.", adri)).toBeNull();
    expect(nearWake("Sure. Hi Adrian, nice to meet you.", adri)).toMatchObject({
      heardAs: "Adrian",
    });
  });
});

test.each([
  ["Hey", true],
  ["Hey.", true],
  ["Hi!", true],
  ["Um, hey", true],
  ["OK, hey", true],
  ["Oké", true],
  ["I'm off. Hey", false],
  ["Hey there", false],
  ["I said hey", false],
  ["Hey Adri", false],
  ["Hey, what's up", false],
  ["", false],
] as const)("isGreetingOnly: %s", (text, expected) => {
  expect(isGreetingOnly(text)).toBe(expected);
});
