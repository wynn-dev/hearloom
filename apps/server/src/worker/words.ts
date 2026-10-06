import { guessLanguage } from "../live/lang";
import type { ScribeWord } from "../providers/elevenlabs";

export interface NewUtterance {
  startAt: number;
  endAt: number;
  text: string;
  lang: string | null;
  speaker: string | null;
  confidence: number | null;
  provider: string;
  model: string | null;
}

/** Group Scribe words into utterances: new utterance on speaker change or a pause > 1 s. */
export function wordsToUtterances(
  words: ScribeWord[],
  toAbs: (s: number) => number,
  speakerOf: (a: number, b: number, scribeSpeaker?: string) => string | null,
): { utterances: NewUtterance[]; events: { label: string; startAt: number; endAt: number }[] } {
  const utterances: NewUtterance[] = [];
  const events: { label: string; startAt: number; endAt: number }[] = [];
  let cur: { words: ScribeWord[]; speaker: string | null } | null = null;
  const flush = () => {
    if (!cur || cur.words.length === 0) return;
    const text = cur.words
      .map((w) => w.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    const first = cur.words[0]!;
    const last = cur.words[cur.words.length - 1]!;
    if (text) {
      const lp = cur.words.map((w) => w.logprob).filter((x): x is number => typeof x === "number");
      utterances.push({
        startAt: toAbs(first.start),
        endAt: toAbs(last.end),
        text,
        lang: guessLanguage(text),
        speaker: cur.speaker,
        confidence: lp.length ? Math.exp(lp.reduce((x, y) => x + y, 0) / lp.length) : null,
        provider: "elevenlabs",
        model: "scribe_v2",
      });
    }
    cur = null;
  };
  for (const w of words) {
    if (w.type === "audio_event") {
      events.push({
        label: w.text
          .replace(/[()[\]]/g, "")
          .trim()
          .toLowerCase(),
        startAt: toAbs(w.start),
        endAt: toAbs(w.end),
      });
      continue;
    }
    if (w.type === "spacing") {
      if (cur) cur.words.push(w);
      continue;
    }
    const speaker = speakerOf(toAbs(w.start), toAbs(w.end), w.speaker_id);
    const prevWord = cur?.words.filter((x) => x.type === "word").at(-1);
    // Absolute times: silent gaps were cut out of the audio Scribe heard.
    const pause = prevWord ? toAbs(w.start) - toAbs(prevWord.end) : 0;
    if (cur && (speaker !== cur.speaker || pause > 1000)) flush();
    cur ??= { words: [], speaker };
    cur.words.push(w);
  }
  flush();
  return { utterances, events };
}
