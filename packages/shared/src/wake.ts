/**
 * "Hey <agent>" wake-phrase matching on transcript text. Pure: the live pipeline runs it on every
 * fresh utterance, and the console's "try a phrase" box runs the same code in the browser.
 *
 * A wake phrase is a greeting ("hey", "ok", "hoi"…) followed by the agent's name, at the start of
 * an utterance or of a sentence in it. The name may be a configured name, an alias (a spelling the
 * speech recognizer actually produced, learned while teaching), or a near miss: one or two edits
 * away, or the same phonetic key ("her mess" → HRMS, like "Hermes").
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
}

const GREETINGS = new Set([
  "hey",
  "hay",
  "hi",
  "hiya",
  "hello",
  "ok",
  "okay",
  "yo",
  "he",
  "hee",
  "hej",
  "hoi",
  "hallo",
]);
const FILLERS = new Set(["um", "uh", "uhm", "erm", "er", "ah", "so", "oh", "eh", "nou", "hmm"]);
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

/** Can a wake phrase start at token i: the start of the text, or after a sentence end? */
function anchored(text: string, tokens: Token[], i: number): boolean {
  if (i === 0) return true;
  return /[.!?…]/.test(text.slice(tokens[i - 1]!.end, tokens[i]!.start));
}

/** Greeting position for an anchor at token i (after up to two fillers), or -1. */
function greetingAt(tokens: Token[], i: number): number {
  for (let g = i; g < Math.min(tokens.length, i + 3); g++) {
    if (GREETINGS.has(tokens[g]!.norm)) return g;
    if (!FILLERS.has(tokens[g]!.norm)) return -1;
  }
  return -1;
}

/** Find a wake phrase in a transcript; null if there is none. */
export function matchWake(text: string, cfg: WakeConfig): WakeMatch | null {
  if (cfg.names.length === 0) return null;
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    if (!anchored(text, tokens, i)) continue;
    const g = greetingAt(tokens, i);
    if (g < 0) continue;
    let best: { name: string; score: number; end: number; nameStart: number } | null = null;
    for (let k = 1; k <= MAX_NAME_WORDS && g + k < tokens.length; k++) {
      const span = tokens.slice(g + 1, g + 1 + k);
      if (!joined(text, span)) break;
      const hit = scoreName(span.map((t) => t.norm).join(""), cfg, k);
      // Ties go to the longer span ("her mess" over "her").
      if (hit && (!best || hit.score >= best.score))
        best = { ...hit, end: span.at(-1)!.end, nameStart: span[0]!.start };
    }
    if (best) {
      return {
        name: best.name,
        heardAs: text.slice(best.nameStart, best.end),
        command: cleanCommand(text.slice(best.end)),
        score: best.score,
        start: tokens[i]!.start,
        end: best.end,
      };
    }
  }
  return null;
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
    if (!anchored(text, tokens, i)) continue;
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
      return {
        name,
        heardAs: text.slice(best.start, best.end),
        command: cleanCommand(text.slice(best.end)),
        score: Math.round(best.score * 100) / 100,
        start: tokens[i]!.start,
        end: best.end,
      };
    }
  }
  return null;
}

/** Text after the name: leading punctuation and fillers dropped. */
export function cleanCommand(rest: string): string {
  let s = rest.replace(/^[\s,.:;!?…\-–—'"’”]+/u, "").trim();
  // "Hey Hermes. Um." is a wake word on its own.
  if (tokenize(s).every((t) => FILLERS.has(t.norm))) s = "";
  return s;
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
