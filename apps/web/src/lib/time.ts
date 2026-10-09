import { useEffect, useState } from "react";

/** Calendar day as `YYYY-MM-DD`. */
export type Day = string;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) {
    f = make();
    formatters.set(key, f);
  }
  return f;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The user's configured zone, falling back to the browser's if it is missing or invalid. */
export function safeTimeZone(tz: string | undefined | null): string {
  return tz && isValidTimeZone(tz) ? tz : browserTimeZone();
}

let zoneList: string[] | null = null;
export function allTimeZones(): string[] {
  if (!zoneList) {
    try {
      zoneList = Intl.supportedValuesOf("timeZone");
    } catch {
      zoneList = [];
    }
    if (!zoneList.includes("UTC")) zoneList = ["UTC", ...zoneList];
  }
  return zoneList;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(ms: number, tz: string): WallClock {
  const f = formatter(
    `parts|${tz}`,
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
  );
  const out: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of f.formatToParts(ms)) {
    if (part.type in out) out[part.type as keyof WallClock] = Number(part.value);
  }
  return out;
}

/** UTC offset of `tz` at an instant, in ms (positive east of Greenwich). */
function zoneOffset(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function parseDay(day: Day): [number, number, number] {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
}

/** The instant `day` starts in `tz`: local midnight, DST-aware. */
export function zonedMidnight(day: Day, tz: string): Date {
  const [y, m, d] = parseDay(day);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - zoneOffset(guess, tz);
  let start = guess - zoneOffset(first, tz);
  // Where DST starts at midnight (e.g. America/Santiago) 00:00 doesn't exist and `start` lands on the
  // previous evening; the day then begins at the transition. Find it to the minute.
  if (dayInZone(start, tz) < day) {
    let lo = start;
    let hi = start + 3 * 3_600_000;
    while (hi - lo > 60_000) {
      const mid = lo + Math.max(60_000, Math.floor((hi - lo) / 120_000) * 60_000);
      if (dayInZone(mid, tz) < day) lo = mid;
      else hi = mid;
    }
    start = hi;
  }
  return new Date(start);
}

export function dayInZone(date: Date | number, tz: string): Day {
  const w = wallClock(typeof date === "number" ? date : date.getTime(), tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

export function todayInZone(tz: string): Day {
  return dayInZone(Date.now(), tz);
}

export function shiftDay(day: Day, days: number): Day {
  const [y, m, d] = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `[00:00, 24:00)` of `day` in `tz` — 23 or 25 hours long on DST change days. */
export function dayRange(day: Day, tz: string): { from: Date; to: Date } {
  return { from: zonedMidnight(day, tz), to: zonedMidnight(shiftDay(day, 1), tz) };
}

export function formatDayLabel(day: Day): string {
  const [y, m, d] = parseDay(day);
  return formatter(
    "daylabel",
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
  ).format(Date.UTC(y, m - 1, d));
}

export function formatTime(date: Date | number, tz: string, seconds = false): string {
  return formatter(
    `time|${tz}|${seconds}`,
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
      }),
  ).format(date);
}

/** Hour-only label for axes: "14" / "2 PM" depending on locale. */
export function formatHour(date: Date | number, tz: string): string {
  return formatter(
    `hour|${tz}`,
    () => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric" }),
  ).format(date);
}

export function formatDateTime(date: Date | number, tz: string): string {
  return formatter(
    `datetime|${tz}`,
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
  ).format(date);
}

export function formatDate(date: Date | number, tz: string): string {
  return formatter(
    `date|${tz}`,
    () => new Intl.DateTimeFormat(undefined, { timeZone: tz, dateStyle: "medium" }),
  ).format(date);
}

/**
 * "Today", "Yesterday" or the date, by calendar day in `tz`: for times only known to the day (a
 * session's last activity is recorded about once a day).
 */
export function formatDayRelative(date: Date | number, now: number, tz: string): string {
  const day = dayInZone(date, tz);
  const today = dayInZone(now, tz);
  if (day >= today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  return formatDate(date, tz);
}

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

/** "12 sec. ago", "5 min. ago", "yesterday" … relative to `now`. */
export function formatRelative(date: Date | number | null | undefined, now = Date.now()): string {
  if (date === null || date === undefined) return "never";
  const ms = (typeof date === "number" ? date : date.getTime()) - now;
  const abs = Math.abs(ms);
  if (abs < 10_000) return "just now";
  if (abs < 60_000) return relativeFormat.format(Math.round(ms / 1000), "second");
  if (abs < 3_600_000) return relativeFormat.format(Math.round(ms / 60_000), "minute");
  if (abs < 86_400_000) return relativeFormat.format(Math.round(ms / 3_600_000), "hour");
  return relativeFormat.format(Math.round(ms / 86_400_000), "day");
}

/** Compact duration: "45s", "3m 05s", "2h 07m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Re-render every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
