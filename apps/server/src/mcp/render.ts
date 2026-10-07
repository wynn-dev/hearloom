import { EPISODE_KIND_LABEL, type EpisodeKind } from "@hearloom/shared";

/**
 * Compact, token-efficient text for LLMs. One line per event, times in the user's timezone:
 *   ## Tue 2026-10-06 · Conversation · episode 01a1b2c3 · 09:30–09:52 · Me, Alice, S2
 *   09:30:12 Me: Did the fix land?
 *   09:30:20 [door slam]
 *   09:31–09:45 {music}
 */

export interface RenderUtterance {
  id: string;
  startAt: Date;
  speaker: string;
  text: string;
  lang: string | null;
}

export interface RenderSound {
  startAt: Date;
  endAt: Date;
  label: string;
  kind: "point" | "state";
}

export interface RenderMark {
  at: Date;
  note: string | null;
}

export interface RenderEpisode {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  kind: EpisodeKind;
  title: string | null;
  speakers?: string[];
}

export function clock(d: Date, tz: string, seconds = true): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  }).format(d);
}

export function day(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")}`;
}

/** "Talk "Distributed systems"" / "Media" — the kind, and the title if there is one. */
export function episodeLabel(e: { kind: EpisodeKind; title: string | null }): string {
  return `${EPISODE_KIND_LABEL[e.kind]}${e.title ? ` "${e.title}"` : ""}`;
}

export function episodeHeader(e: RenderEpisode, tz: string): string {
  const end = e.endedAt ? clock(e.endedAt, tz, false) : "now";
  const who = e.speakers?.length ? ` · ${e.speakers.join(", ")}` : "";
  return `## ${day(e.startedAt, tz)} · ${episodeLabel(e)} · episode ${e.id} · ${clock(e.startedAt, tz, false)}–${end}${who}`;
}

/** Media speech is from a TV, radio or video, not from people present. */
export const MEDIA_NOTE = "(media: voices from a TV, radio or recording, not people present)";

/**
 * Interleave utterances, sound events and bookmarks chronologically. With `dayHeaders`, a
 * `## <day>` line starts every day (lines only carry the time of day).
 */
export function renderLines(
  utterances: RenderUtterance[],
  sounds: RenderSound[],
  tz: string,
  opts: { bookmarks?: RenderMark[]; dayHeaders?: boolean; episodes?: RenderEpisode[] } = {},
): string[] {
  type Row = { at: number; line: string };
  const rows: Row[] = [
    ...utterances.map((u) => ({
      at: u.startAt.getTime(),
      line: `${clock(u.startAt, tz)} ${u.speaker}: ${u.text}`,
    })),
    ...sounds.map((s) => ({
      at: s.startAt.getTime(),
      line:
        s.kind === "state"
          ? `${clock(s.startAt, tz, false)}–${clock(s.endAt, tz, false)} {${s.label}}`
          : `${clock(s.startAt, tz)} [${s.label}]`,
    })),
    ...(opts.bookmarks ?? []).map((b) => ({
      at: b.at.getTime(),
      line: `${clock(b.at, tz)} ⚑ bookmark${b.note ? `: ${b.note}` : ""}`,
    })),
    // Episode starts go before what happens at the same moment.
    ...(opts.episodes ?? []).map((e) => ({
      at: e.startedAt.getTime() - 0.5,
      line: `── ${clock(e.startedAt, tz, false)}–${e.endedAt ? clock(e.endedAt, tz, false) : "now"} ${episodeLabel(e)} · episode ${e.id}${e.kind === "media" ? ` ${MEDIA_NOTE}` : ""}`,
    })),
  ];
  rows.sort((a, b) => a.at - b.at);
  if (!opts.dayHeaders) return rows.map((r) => r.line);
  const out: string[] = [];
  let lastDay = "";
  for (const r of rows) {
    const d = day(new Date(r.at), tz);
    if (d !== lastDay) out.push(`## ${d}`);
    lastDay = d;
    out.push(r.line);
  }
  return out;
}

export function speakerName(u: {
  personName: string | null;
  isWearer: boolean | null;
  speakerKey: string | null;
}): string {
  if (u.isWearer) return "Me";
  return u.personName ?? u.speakerKey ?? "Someone";
}
