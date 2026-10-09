/**
 * "Hey <agent>" wake-phrase matching on transcript text. Pure: the live pipeline runs it on every
 * fresh utterance, and the console's "try a phrase" box runs the same code in the browser.
 *
 * A wake phrase is a greeting ("hey", "ok", "hoi"…) followed by the agent's name, at the start of
 * an utterance or of a sentence in it. The name may be a configured name, an alias (a spelling the
 * speech recognizer actually produced, learned while teaching), or a near miss: one or two edits
 * away, or the same phonetic key ("her mess" → HRMS, like "Hermes").
 *
 * Near misses of the name only count right after hey/hi/hello/hoi/hallo at a sentence start:
 * everywhere else the name must be heard exactly (or as a learned alias). Dutch "oké, ieder…"
 * sounds like "oké, Adri" to the matcher, and a false trigger acts in the world.
 *
 * Fillers, lead-ins and repeated greetings may come first ("um, so hey", "yeah, hey", "hey hey",
 * "OK, hey"), and "there" may follow hey/hi/hello ("hey there Hermes"). Within an utterance, a
 * wake phrase may also follow a dash (the recognizer marks cut-off speech with one) or a short
 * closing clause and a comma ("I'm off, hey Hermes"), but not reported speech ("he said, hey
 * Hermes, …").
 */

export interface WakeConfig {
  /** The agent's name(s), e.g. ["Hermes"]. */
  names: string[];
  /** Other spellings the recognizer produces for a name ("her mess"): matched exactly. */
  aliases: string[];
  /** Spellings that caused false triggers: never fuzzy-matched. */
  blocked?: string[];
}

export interface WakeMatch {
  /** The configured name it matched. */
  name: string;
  /** The words that were heard as the name, as transcribed ("her mess"). */
  heardAs: string;
  /** Everything after the name, without leading punctuation (may be ""). */
  command: string;
  /** 1 = name or alias, 0.9 = a few edits away, 0.85 = sounds the same. */
  score: number;
  /** Character offset of the greeting in the text. */
  start: number;
  /** Character offset just after the name. */
  end: number;
  /** Character offset of the command in the text (the text's length if there is none). */
  commandStart: number;
}

const GREETINGS = new Set([
  "hey",
  "hay",
  "hi",
  "hiya",
  "hai",
  "hello",
  "ok",
  "okay",
  // Dutch "oké", "okee".
  "oke",
  "okee",
  "yo",
  "ey",
  "he",
  "hee",
  "heej",
  "hej",
  "hoi",
  "hallo",
]);
/** Greetings after which a near miss of the name counts (at a sentence start, first in line). */
const LOOSE_GREETINGS = new Set(["hey", "hi", "hello", "hoi", "hallo"]);
/** Greetings that "there" may follow ("hey there Hermes"). */
const THERE_GREETINGS = new Set(["hey", "hi", "hello"]);
/** Sounds that carry no meaning: also dropped from the start of a command. */
const HESITATIONS = new Set(["um", "uh", "uhm", "erm", "ah", "eh", "hmm"]);
/** Before the greeting only ("er" is also a Dutch word: "er is…"). */
const FILLERS = new Set([...HESITATIONS, "er", "so", "oh", "nou"]);
/** Words that may lead into a greeting ("yeah, hey Hermes", "and hey Hermes"). */
const LEAD_INS = new Set(["yeah", "yes", "ja", "and", "en", "alright", "right", "well"]);
/** Words that report speech: a greeting after them is quoted ("he said, hey Hermes, …"). */
const REPORTING = new Set([
  "say",
  "says",
  "said",
  "saying",
  "tell",
  "tells",
  "told",
  "telling",
  "ask",
  "asks",
  "asked",
  "asking",
  "like",
  "goes",
  "went",
  "shouted",
  "yelled",
  "wrote",
  "zeg",
  "zegt",
  "zei",
  "zeiden",
  "zeggen",
  "gezegd",
  "vroeg",
  "vroegen",
  "vraag",
  "vraagt",
  "vragen",
  "gevraagd",
  "riep",
  "roept",
  "schreef",
]);
/** A name followed by one of these is narration, not address ("hey, Hermes said…"). */
const NARRATING = new Set(["said", "says", "told", "asked", "zei", "zegt", "vroeg", "vertelde"]);
/**
 * Short clauses that close what came before: after one and a comma, a wake phrase may start
 * ("Thanks, hey Hermes", "I'm off, hey Hermes", "Dank je, hoi Hermes").
 */
const CLOSERS = new Set([
  "thanks",
  "thank",
  "ok",
  "okay",
  "oke",
  "okee",
  "bye",
  "right",
  "alright",
  "fine",
  "good",
  "great",
  "cool",
  "sure",
  "done",
  "off",
  "yes",
  "yeah",
  "no",
  "dank",
  "bedankt",
  "doei",
  "goed",
  "prima",
  "klaar",
  "top",
  "mooi",
  "ja",
  "nee",
]);
/** A closing clause before a comma is at most this many words. */
const MAX_CLOSER_WORDS = 3;
/** At most this many fillers, lead-ins and other greetings before the greeting itself. */
const MAX_LEAD = 4;
/** Name spans tried after the greeting, in words ("her mess" is two). */
const MAX_NAME_WORDS = 3;

interface Token {
  /** Lowercase, accents stripped, letters and digits only. */
  norm: string;
  start: number;
  end: number;
}

/** Lowercase, without accents ("Hermès" → "hermes"), keeping only letters, digits and spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A name or alias as compared: normalized, spaces removed ("Her Mess" → "hermess"). */
export function compactName(s: string): string {
  return normalizeText(s).replace(/\s+/g, "");
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*/gu)) {
    const norm = compactName(m[0]);
    if (norm) out.push({ norm, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Optimal-string-alignment (Damerau-Levenshtein) distance between two sequences. */
function distance<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1);
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[m]!;
}

export function editDistance(a: string, b: string): number {
  return distance(a, b);
}

/**
 * A rough phonetic key: similar-sounding spellings get the same key ("hermes", "her mess",
 * "harmes" → "HRMS"). Consonant skeleton with common English/Dutch spelling variants folded.
 */
export function phoneticKey(s: string): string {
  let w = compactName(s).replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w
    .replace(/x/g, "ks")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/sch/g, "sk")
    .replace(/[cs]h/g, "x")
    .replace(/th/g, "t")
    .replace(/gh/g, "g")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/dt|d$/g, "t");
  const first = /[aeiouyj]/.test(w[0]!) ? "a" : w[0]!;
  const rest = w.slice(1).replace(/[aeiouyhwj]/g, "");
  return (first + rest).replace(/(.)\1+/g, "$1").toUpperCase();
}

/** A loose match may differ in length from the name by at most this many letters. */
const LOOSE_LENGTH_SLACK = 2;

/**
 * How well a heard span (compacted) matches a name or alias (compacted): 0 = not at all. Loose
 * matches (a few edits away, or the same phonetic key) only for a single word close to the name's
 * length: across words the consonant skeleton matches everyday speech ("her mom's", "Harry Moss"
 * → HRMS). Missing a wake phrase can be taught; a false trigger acts in the world.
 */
function spanScore(heard: string, target: string, loose: boolean): number {
  if (!heard || !target) return 0;
  if (heard === target) return 1;
  if (!loose || target.length < 4) return 0;
  if (Math.abs(heard.length - target.length) > LOOSE_LENGTH_SLACK) return 0;
  if (editDistance(heard, target) <= Math.max(1, Math.floor(target.length / 5))) return 0.9;
  const key = phoneticKey(target);
  if (key.length >= 3 && phoneticKey(heard) === key) return 0.85;
  return 0;
}

/**
 * Best score of heard words against the config's names and aliases. `words` > 1 (a span such as
 * "her mess") must be an exact name or alias.
 */
export function scoreName(
  heard: string,
  cfg: WakeConfig,
  words = 1,
): { name: string; score: number } | null {
  const h = compactName(heard);
  const blocked = (cfg.blocked ?? []).some((b) => compactName(b) === h);
  let best: { name: string; score: number } | null = null;
  const consider = (name: string, target: string, loose: boolean) => {
    const score = spanScore(h, compactName(target), loose);
    if (score > 0 && (!best || score > best.score)) best = { name, score };
  };
  for (const name of cfg.names) consider(name, name, !blocked && words === 1);
  // An alias belongs to the first name (one agent per user, for now).
  const primary = cfg.names[0];
  if (primary) for (const alias of cfg.aliases) consider(primary, alias, false);
  return best;
}

/** Words of a span are only separated by spaces (no comma etc. inside a name). */
function joined(text: string, span: Token[]): boolean {
  for (let i = 1; i < span.length; i++)
    if (/\S/.test(text.slice(span[i - 1]!.end, span[i]!.start))) return false;
  return true;
}

/** The words of the clause before token i (back to the previous punctuation or the start). */
function clauseBefore(text: string, tokens: Token[], i: number): Token[] {
  let k = i - 1;
  while (k > 0 && !/[.!?…—–,;:]/.test(text.slice(tokens[k - 1]!.end, tokens[k]!.start))) k--;
  return tokens.slice(Math.max(0, k), i);
}

/**
 * Can a wake phrase start at token i?
 * - "sentence": at the start of the text, or after a sentence end;
 * - "dash": after a dash ("—" also marks speech cut off), unless the clause before it reports
 *   speech ("I told him — hey Hermes — …");
 * - "comma": after a short closing clause and a comma ("Thanks, hey Hermes", "I'm off, hey
 *   Hermes"), not reported speech ("You just say, hey Hermes, …");
 * - null: inside a sentence.
 * After a dash or a comma, only a name heard exactly counts, right after the greeting.
 */
function anchored(text: string, tokens: Token[], i: number): "sentence" | "dash" | "comma" | null {
  if (i === 0) return "sentence";
  const gap = text.slice(tokens[i - 1]!.end, tokens[i]!.start);
  if (/[.!?…]/.test(gap)) return "sentence";
  const dash = /[—–]/.test(gap);
  if (!dash && !gap.includes(",")) return null;
  const clause = clauseBefore(text, tokens, i);
  if (clause.some((t) => REPORTING.has(t.norm))) return null;
  if (dash) return "dash";
  return clause.length <= MAX_CLOSER_WORDS && clause.some((t) => CLOSERS.has(t.norm))
    ? "comma"
    : null;
}

interface NameStart {
  /** The token the name starts at. */
  at: number;
  /** The greeting's token. */
  greeting: number;
  /** A near miss of the name may count (else only an exact name or alias). */
  loose: boolean;
  /** Greeting and name only separated by spaces ("…, hey, Hermes said" is not a wake phrase). */
  tight: boolean;
}

/**
 * Where the name may start, for a wake phrase anchored at token i: right after a greeting, which
 * may follow up to `MAX_LEAD` fillers, lead-ins or other greetings ("um, so hey", "hey hey", "OK,
 * hey"), or after "hey there".
 */
function nameStarts(tokens: Token[], i: number): NameStart[] {
  const out: NameStart[] = [];
  for (let j = i; j < Math.min(tokens.length, i + MAX_LEAD + 1); j++) {
    const w = tokens[j]!.norm;
    if (GREETINGS.has(w)) {
      // Only hey/hi/hello/hoi/hallo, first in line (after hesitations at most).
      const first = tokens.slice(i, j).every((t) => HESITATIONS.has(t.norm) || t.norm === "er");
      out.push({ at: j + 1, greeting: j, loose: first && LOOSE_GREETINGS.has(w), tight: j > i });
      if (THERE_GREETINGS.has(w) && tokens[j + 1]?.norm === "there")
        out.push({ at: j + 2, greeting: j, loose: false, tight: true });
    } else if (!LEAD_INS.has(w) && !FILLERS.has(w)) break;
  }
  return out;
}

/** The greeting for an anchor at token i (the last one, "hey hey"), or -1. */
function greetingAt(tokens: Token[], i: number): number {
  const starts = nameStarts(tokens, i).filter((s) => s.at === s.greeting + 1);
  return starts.at(-1)?.greeting ?? -1;
}

/** Best name heard from token `at` on, as matched by `scoreName` (null: none). */
function nameAt(
  text: string,
  tokens: Token[],
  at: number,
  cfg: WakeConfig,
): { name: string; score: number; end: number; nameStart: number; next: number } | null {
  let best: { name: string; score: number; end: number; nameStart: number; next: number } | null =
    null;
  for (let k = 1; k <= MAX_NAME_WORDS && at + k <= tokens.length; k++) {
    const span = tokens.slice(at, at + k);
    if (!joined(text, span)) break;
    const hit = scoreName(span.map((t) => t.norm).join(""), cfg, k);
    // Ties go to the longer span ("her mess" over "her").
    if (hit && (!best || hit.score >= best.score))
      best = { ...hit, end: span.at(-1)!.end, nameStart: span[0]!.start, next: at + k };
  }
  return best;
}

/** Find a wake phrase in a transcript; null if there is none. */
export function matchWake(text: string, cfg: WakeConfig): WakeMatch | null {
  if (cfg.names.length === 0) return null;
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const anchor = anchored(text, tokens, i);
    if (!anchor) continue;
    let best: { name: string; score: number; end: number; nameStart: number } | null = null;
    for (const { at, greeting, loose, tight } of nameStarts(tokens, i)) {
      // "…, hey Hermes" but not "…, hey, Hermes said".
      if (
        (tight || anchor !== "sentence") &&
        at < tokens.length &&
        !joined(text, tokens.slice(greeting, at + 1))
      )
        continue;
      const hit = nameAt(text, tokens, at, cfg);
      // A close name: "Hey Hermis", but not "Hey, ieder…" (comma) or "Oké iedere…".
      const close = loose && anchor === "sentence" && joined(text, tokens.slice(greeting, at + 1));
      if (!hit || (hit.score < 1 && !close)) continue;
      // "Hey, Hermes said…": talking about the agent, not to it.
      const after = tokens[hit.next];
      if (after && NARRATING.has(after.norm) && joined(text, [tokens[hit.next - 1]!, after]))
        continue;
      if (!best || hit.score > best.score) best = hit;
    }
    if (!best) continue;
    let { command, start: commandStart } = commandFrom(text, best.end);
    // Said twice ("Hey Hermes, hey Hermes, call mom"): the command is what follows the last one.
    const again = command ? matchWake(command, cfg) : null;
    if (again?.start === 0 && again.score === 1) {
      command = again.command;
      commandStart = command ? commandStart + again.commandStart : text.length;
    }
    return {
      name: best.name,
      heardAs: text.slice(best.nameStart, best.end),
      command,
      score: best.score,
      start: tokens[i]!.start,
      end: best.end,
      commandStart,
    };
  }
  return null;
}

/**
 * Is the text only a greeting (and fillers): "Hey", "Um, hey", "Oké."? A wake phrase may go on
 * from it in the next utterance (the recognizer may split "Hey" | "Hermes, call mom" where it
 * hears a speaker change).
 */
export function isGreetingOnly(text: string): boolean {
  const tokens = tokenize(text);
  return (
    tokens.some((t) => GREETINGS.has(t.norm)) &&
    tokens.every((t) => GREETINGS.has(t.norm) || FILLERS.has(t.norm))
  );
}

/**
 * A wake phrase that almost matched: a greeting followed by words that look somewhat like the
 * name ("hey hermit"), at least half its letters right. Null if it matched, or isn't close.
 */
export function nearWake(text: string, cfg: WakeConfig): WakeMatch | null {
  const name = cfg.names[0];
  if (!name || matchWake(text, cfg)) return null;
  const target = compactName(name);
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    // Not after a comma: only exact names count there, so nothing is "near".
    if (anchored(text, tokens, i) !== "sentence") continue;
    const g = greetingAt(tokens, i);
    if (g < 0) continue;
    let best: { score: number; end: number; start: number } | null = null;
    for (let k = 1; k <= 2 && g + k < tokens.length; k++) {
      const span = tokens.slice(g + 1, g + 1 + k);
      if (!joined(text, span)) break;
      const heard = span.map((t) => t.norm).join("");
      const score = 1 - editDistance(heard, target) / Math.max(heard.length, target.length);
      if (score >= 0.5 && (!best || score > best.score))
        best = { score, start: span[0]!.start, end: span.at(-1)!.end };
    }
    if (best) {
      const { command, start: commandStart } = commandFrom(text, best.end);
      return {
        name,
        heardAs: text.slice(best.start, best.end),
        command,
        score: Math.round(best.score * 100) / 100,
        start: tokens[i]!.start,
        end: best.end,
        commandStart,
      };
    }
  }
  return null;
}

const LEADING_PUNCTUATION = /^[\s,.:;!?…\-–—'"’”]+/u;

/**
 * The command in `text` from offset `from` (just after the name), and where it starts: leading
 * punctuation and hesitations ("uh, call mom") dropped; "" if only fillers are left.
 */
function commandFrom(text: string, from: number): { command: string; start: number } {
  let start = from;
  for (;;) {
    start += LEADING_PUNCTUATION.exec(text.slice(start))?.[0].length ?? 0;
    const first = tokenize(text.slice(start))[0];
    if (!first || first.start > 0 || !HESITATIONS.has(first.norm)) break;
    start += first.end;
  }
  const command = text.slice(start).trim();
  // "Hey Hermes. Um." is a wake word on its own.
  if (tokenize(command).every((t) => FILLERS.has(t.norm)))
    return { command: "", start: text.length };
  return { command, start };
}

/** Text after the name: leading punctuation and hesitations dropped. */
export function cleanCommand(rest: string): string {
  return commandFrom(rest, 0).command;
}

/** Word-level similarity of two texts: 1 = same words, 0 = nothing in common. */
export function textSimilarity(a: string, b: string): number {
  const x = tokenize(a).map((t) => t.norm);
  const y = tokenize(b).map((t) => t.norm);
  const n = Math.max(x.length, y.length);
  return n === 0 ? 1 : 1 - distance(x, y) / n;
}

/** Terms that bias the speech recognizer toward the names (Soniox `context.terms`). */
export function wakeTerms(cfg: WakeConfig): string[] {
  return [...new Set(cfg.names.map((n) => n.trim()).filter(Boolean))];
}

// ---- Teaching ---------------------------------------------------------------------------------

/** What the user is asked to say while teaching: the greeting and name, then maybe a request. */
const TEACH_TEMPLATES = [
  "Hey {name}",
  "Hey {name}, what's the weather tomorrow?",
  "Hi {name}",
  "Hey {name}, remind me to call mom at six.",
  "OK {name}, what's on my calendar today?",
  "Hey {name}",
  "Hey {name}, add milk to the shopping list.",
  "Hoi {name}, hoe laat is het?",
  "Hey {name}, how long should I boil an egg?",
  "Hey {name}, send me the notes from this meeting.",
  "Hey {name}",
  "OK {name}, set a timer for ten minutes.",
];

/** The n-th teaching prompt (cycles, so teaching can go on). */
export function teachPhrase(name: string, n: number): string {
  return TEACH_TEMPLATES[n % TEACH_TEMPLATES.length]!.replace("{name}", name);
}

export interface TeachAlignment {
  /** The utterance is this prompt (greeting heard, the rest close enough). */
  ok: boolean;
  /** The words in the place of the name, as transcribed; null if no greeting was heard. */
  heardAs: string | null;
  /** How the live matcher scores those words (0 = it would not recognize the name). */
  nameScore: number;
  /** Would the live matcher fire on this utterance as configured now? */
  wouldMatch: boolean;
}

/**
 * Line up what was heard with a teaching prompt, to learn how the recognizer spells the name in
 * this user's voice: the words between the greeting and the rest of the prompt are the name.
 */
export function alignTeach(heard: string, prompt: string, cfg: WakeConfig): TeachAlignment {
  const wouldMatch = matchWake(heard, cfg) !== null;
  const promptTokens = tokenize(prompt);
  const pg = greetingAt(promptTokens, 0);
  const name = cfg.names[0] ?? "";
  const nameWords = tokenize(name).length || 1;
  const restWanted = promptTokens.slice(pg + 1 + nameWords).map((t) => t.norm);

  const tokens = tokenize(heard);
  const g = greetingAt(tokens, 0);
  if (g < 0) return { ok: false, heardAs: null, nameScore: 0, wouldMatch };
  let best: { k: number; restSim: number; nameScore: number } | null = null;
  for (let k = 1; k <= MAX_NAME_WORDS && g + k < tokens.length; k++) {
    // A name is never split by punctuation ("hurry, miss").
    if (!joined(heard, tokens.slice(g + 1, g + 1 + k))) break;
    const rest = tokens
      .slice(g + 1 + k)
      .map((t) => t.norm)
      .filter((w) => !FILLERS.has(w));
    const n = Math.max(rest.length, restWanted.length);
    const restSim = n === 0 ? 1 : 1 - distance(rest, restWanted) / n;
    const span = tokens.slice(g + 1, g + 1 + k).map((t) => t.norm);
    const nameScore = scoreName(span.join(""), cfg, k)?.score ?? 0;
    if (
      !best ||
      restSim > best.restSim + 1e-9 ||
      (Math.abs(restSim - best.restSim) < 1e-9 && nameScore > best.nameScore)
    )
      best = { k, restSim, nameScore };
  }
  if (!best) return { ok: false, heardAs: null, nameScore: 0, wouldMatch };
  const span = tokens.slice(g + 1, g + 1 + best.k);
  return {
    ok: best.restSim >= 0.5,
    heardAs: heard.slice(span[0]!.start, span.at(-1)!.end),
    nameScore: best.nameScore,
    wouldMatch,
  };
}

/**
 * Should a spelling heard in place of the name become an alias? It must look like the name
 * (similar letters or sound), or have been heard that way more than once. A spelling of several
 * words ("her mess") is everyday English, matched exactly once learned: it needs to have been
 * heard at least twice, or confirmed by the user (callers pass `timesHeard` 2 for that).
 */
export function aliasWorthLearning(heardAs: string, cfg: WakeConfig, timesHeard: number): boolean {
  const h = compactName(heardAs);
  const name = compactName(cfg.names[0] ?? "");
  if (h.length < 3 || !name || h === name) return false;
  if (cfg.aliases.some((a) => compactName(a) === h)) return false;
  if ((cfg.blocked ?? []).some((b) => compactName(b) === h)) return false;
  if (GREETINGS.has(h) || FILLERS.has(h)) return false;
  if (normalizeText(heardAs).split(" ").length > 1) return timesHeard >= 2;
  const similar =
    1 - editDistance(h, name) / Math.max(h.length, name.length) >= 0.5 ||
    phoneticKey(h).slice(0, 2) === phoneticKey(name).slice(0, 2);
  return similar || timesHeard >= 2;
}
