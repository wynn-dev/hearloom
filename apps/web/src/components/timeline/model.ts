import type { AudioChunk, Timeline } from "@hearloom/api";

export type Conversation = Timeline["conversations"][number];
export type Utterance = Timeline["utterances"][number];
export type SoundEvent = Timeline["soundEvents"][number];
export type Bookmark = Timeline["bookmarks"][number];
export type DeviceEvent = Timeline["deviceEvents"][number];

export interface Filters {
  audio: boolean;
  speech: boolean;
  sounds: boolean;
  bookmarks: boolean;
  device: boolean;
}

export const defaultFilters: Filters = {
  audio: true,
  speech: true,
  sounds: true,
  bookmarks: true,
  device: true,
};

interface Base {
  key: string;
  /** Start, unix ms. */
  at: number;
  /** End, unix ms (= at for point items). */
  end: number;
  /** Id of the conversation this row belongs to, if any. */
  conv: string | null;
}

export type Row =
  | (Base & { kind: "audio"; chunks: AudioChunk[] })
  | (Base & { kind: "utterance"; item: Utterance })
  | (Base & { kind: "sound"; item: SoundEvent })
  | (Base & { kind: "bookmark"; item: Bookmark })
  | (Base & { kind: "device"; item: DeviceEvent });

export type Entry =
  | Row
  | { kind: "conversation"; key: string; at: number; conv: string; item: Conversation }
  | { kind: "gap"; key: string; at: number; ms: number; conv: null };

/** Same-time ordering: context first (audio, device), then content. */
const ORDER: Record<Row["kind"], number> = {
  device: 0,
  audio: 1,
  bookmark: 2,
  sound: 3,
  utterance: 4,
};

/** Show a divider when nothing happened for this long. */
export const GAP_MS = 15 * 60_000;

/** Contiguous chunks of one stream (≤ gapMs apart) play back as one run. */
export function audioRuns(chunks: AudioChunk[], gapMs = 3_000): AudioChunk[][] {
  const sorted = [...chunks].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const runs: AudioChunk[][] = [];
  let run: AudioChunk[] = [];
  for (const chunk of sorted) {
    const prev = run[run.length - 1];
    if (
      prev &&
      (prev.streamId !== chunk.streamId || chunk.startAt.getTime() - prev.endAt.getTime() > gapMs)
    ) {
      runs.push(run);
      run = [];
    }
    run.push(chunk);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * Device events worth showing: pendant bookmarks already appear as bookmark rows, and battery
 * reports are thinned to changes of ≥ 5 points so a day doesn't drown in them.
 */
export function visibleDeviceEvents(events: DeviceEvent[]): DeviceEvent[] {
  let lastBattery: number | null = null;
  return events.filter((e) => {
    if (e.kind === "bookmark") return false;
    if (e.kind === "battery") {
      const value = typeof e.payload.value === "number" ? e.payload.value : null;
      if (value === null) return false;
      if (lastBattery !== null && Math.abs(value - lastBattery) < 5) return false;
      lastBattery = value;
    }
    if (e.kind === "wearable_connected") lastBattery = null;
    return true;
  });
}

/** Merge all timeline layers into one time-ordered list with conversation headers and gaps. */
export function buildEntries(data: Timeline, filters: Filters): Entry[] {
  const conversations = [...data.conversations].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  const convAt = (t: number): string | null => {
    let found: string | null = null;
    for (const c of conversations) {
      if (c.startedAt.getTime() > t) break;
      if (t < (c.endedAt?.getTime() ?? Number.POSITIVE_INFINITY)) found = c.id;
    }
    return found;
  };

  const rows: Row[] = [];
  if (filters.audio) {
    for (const chunks of audioRuns(data.chunks)) {
      const first = chunks[0]!;
      const at = first.startAt.getTime();
      rows.push({
        kind: "audio",
        key: `a:${first.id}`,
        at,
        end: chunks[chunks.length - 1]!.endAt.getTime(),
        conv: convAt(at),
        chunks,
      });
    }
  }
  if (filters.speech) {
    for (const item of data.utterances) {
      const at = item.startAt.getTime();
      rows.push({
        kind: "utterance",
        key: `u:${item.id}`,
        at,
        end: item.endAt.getTime(),
        conv: item.conversationId ?? convAt(at),
        item,
      });
    }
  }
  if (filters.sounds) {
    for (const item of data.soundEvents) {
      const at = item.startAt.getTime();
      rows.push({
        kind: "sound",
        key: `s:${item.id}`,
        at,
        end: item.endAt.getTime(),
        conv: convAt(at),
        item,
      });
    }
  }
  if (filters.bookmarks) {
    for (const item of data.bookmarks) {
      const at = item.at.getTime();
      rows.push({ kind: "bookmark", key: `b:${item.id}`, at, end: at, conv: convAt(at), item });
    }
  }
  if (filters.device) {
    for (const item of visibleDeviceEvents(data.deviceEvents)) {
      const at = item.at.getTime();
      rows.push({ kind: "device", key: `d:${item.id}`, at, end: at, conv: convAt(at), item });
    }
  }
  rows.sort((a, b) => a.at - b.at || ORDER[a.kind] - ORDER[b.kind]);

  const byId = new Map(conversations.map((c) => [c.id, c]));
  const shown = new Set<string>();
  const entries: Entry[] = [];
  let currentConv: string | null = null;
  let lastEnd: number | null = null;
  let convIndex = 0;

  const pushConversation = (c: Conversation, suffix = "") => {
    entries.push({
      kind: "conversation",
      key: `c:${c.id}${suffix}`,
      at: c.startedAt.getTime(),
      conv: c.id,
      item: c,
    });
    shown.add(c.id);
  };
  const pushGap = (at: number) => {
    if (lastEnd !== null && at - lastEnd >= GAP_MS) {
      entries.push({ kind: "gap", key: `g:${lastEnd}`, at: lastEnd, ms: at - lastEnd, conv: null });
    }
  };

  for (const row of rows) {
    // Conversations that started before this row but have no rows of their own still get a header.
    while (
      convIndex < conversations.length &&
      conversations[convIndex]!.startedAt.getTime() <= row.at
    ) {
      const c = conversations[convIndex++]!;
      if (row.conv !== c.id && !shown.has(c.id)) {
        pushGap(c.startedAt.getTime());
        pushConversation(c);
        lastEnd = Math.max(lastEnd ?? 0, c.endedAt?.getTime() ?? c.startedAt.getTime());
        currentConv = c.id;
      }
    }
    pushGap(row.at);
    if (row.conv !== null && row.conv !== currentConv) {
      const c = byId.get(row.conv);
      if (c) pushConversation(c, shown.has(c.id) ? `:${row.key}` : "");
    }
    currentConv = row.conv;
    entries.push(row);
    lastEnd = Math.max(lastEnd ?? row.end, row.end);
  }
  for (; convIndex < conversations.length; convIndex++) {
    const c = conversations[convIndex]!;
    if (!shown.has(c.id)) {
      pushGap(c.startedAt.getTime());
      pushConversation(c);
      lastEnd = Math.max(lastEnd ?? 0, c.endedAt?.getTime() ?? c.startedAt.getTime());
    }
  }
  return entries;
}

/** Index of the first entry at or after `t` (entries are time-ordered). */
export function entryIndexAt(entries: Entry[], t: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.at < t) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, entries.length - 1);
}

/** Merge [start, end] intervals that are closer than `slackMs` (for the day strip). */
export function mergeIntervals(
  intervals: Array<[number, number]>,
  slackMs: number,
): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start - last[1] <= slackMs) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

export function deviceEventText(e: DeviceEvent): string {
  const value = e.payload.value;
  const name = typeof e.payload.name === "string" ? e.payload.name : "Pendant";
  switch (e.kind) {
    case "wearable_connected": {
      const battery =
        typeof e.payload.battery === "number" ? ` (battery ${e.payload.battery}%)` : "";
      return `${name} connected${battery}`;
    }
    case "wearable_disconnected":
      return `${name} disconnected`;
    case "battery":
      return `Pendant battery ${String(value)}%`;
    case "charging":
      return value === false ? "Pendant stopped charging" : "Pendant charging";
    case "muted":
      return "Microphone muted";
    case "unmuted":
      return "Microphone unmuted";
    case "ack_nudge":
      return "Notification acknowledged on the pendant";
    case "button": {
      const press = { 1: "tap", 2: "double tap", 5: "hold" }[Number(value)] ?? String(value ?? "");
      return `Pendant button ${press}`.trim();
    }
    default: {
      const label = e.kind.replaceAll("_", " ");
      return value === null || value === undefined ? label : `${label}: ${String(value)}`;
    }
  }
}
