/**
 * Turns per-window AudioSet tags into timestamped sound events with hysteresis:
 * an event opens when a label scores >= `on`, stays open while it scores >= `off`, and closes after
 * `closeAfter` windows below `off`. Speech classes are dropped (transcription covers speech).
 */

export interface WindowTag {
  name: string;
  prob: number;
}

export interface SoundEvent {
  /** Short label, e.g. "vehicle horn". */
  label: string;
  /** Full AudioSet display name. */
  audioset: string;
  startAt: number;
  endAt: number;
  confidence: number;
}

/** AudioSet classes that are speech/meta rather than "something happened". */
const IGNORE = new Set([
  "Speech",
  "Male speech, man speaking",
  "Female speech, woman speaking",
  "Child speech, kid speaking",
  "Conversation",
  "Narration, monologue",
  "Babbling",
  "Speech synthesizer",
  "Silence",
  "Sound effect",
  "Noise",
  "Static",
  "Mains hum",
  "Hum",
  "Inside, small room",
  "Inside, large room or hall",
  "Inside, public space",
  "Outside, urban or manmade",
  "Outside, rural or natural",
  "Environmental noise",
]);

export function shortLabel(audioset: string): string {
  return (audioset.split(",")[0] ?? audioset).trim().toLowerCase();
}

interface Open {
  audioset: string;
  startAt: number;
  lastSeenAt: number;
  peak: number;
  misses: number;
}

export interface SmootherOptions {
  on?: number;
  off?: number;
  closeAfter?: number;
}

export class SoundEventSmoother {
  private open = new Map<string, Open>();
  private readonly on: number;
  private readonly off: number;
  private readonly closeAfter: number;

  constructor(opts: SmootherOptions = {}) {
    this.on = opts.on ?? 0.45;
    this.off = opts.off ?? 0.25;
    this.closeAfter = opts.closeAfter ?? 2;
  }

  /**
   * Feed the tags of one analysis window [start, end). Returns events that closed, plus events
   * that just opened (so they can be shown live and extended later).
   */
  push(
    tags: WindowTag[],
    start: number,
    end: number,
  ): { closed: SoundEvent[]; opened: SoundEvent[] } {
    const closed: SoundEvent[] = [];
    const opened: SoundEvent[] = [];
    const seen = new Set<string>();
    for (const t of tags) {
      if (IGNORE.has(t.name)) continue;
      const o = this.open.get(t.name);
      if (o && t.prob >= this.off) {
        o.lastSeenAt = end;
        o.peak = Math.max(o.peak, t.prob);
        o.misses = 0;
        seen.add(t.name);
      } else if (!o && t.prob >= this.on) {
        const n: Open = {
          audioset: t.name,
          startAt: start,
          lastSeenAt: end,
          peak: t.prob,
          misses: 0,
        };
        this.open.set(t.name, n);
        opened.push(toEvent(n));
        seen.add(t.name);
      }
    }
    for (const [name, o] of this.open) {
      if (seen.has(name)) continue;
      o.misses++;
      if (o.misses >= this.closeAfter) {
        this.open.delete(name);
        closed.push(toEvent(o));
      }
    }
    return { closed, opened };
  }

  /** Close everything (end of audio). */
  flush(): SoundEvent[] {
    const out = [...this.open.values()].map(toEvent);
    this.open.clear();
    return out;
  }

  openEvents(): SoundEvent[] {
    return [...this.open.values()].map(toEvent);
  }
}

function toEvent(o: Open): SoundEvent {
  return {
    label: shortLabel(o.audioset),
    audioset: o.audioset,
    startAt: o.startAt,
    endAt: o.lastSeenAt,
    confidence: o.peak,
  };
}
