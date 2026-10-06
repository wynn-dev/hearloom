import type { Timeline } from "@hearloom/api";
import { memo, type PointerEvent, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatHour, formatTime } from "../../lib/time";
import { mergeIntervals } from "./model";

const HOUR = 3_600_000;

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={className} />
      {label}
    </span>
  );
}

/**
 * 24-hour overview of a day: recorded audio, conversations and bookmarks on one time axis.
 * Hover shows the time under the cursor; clicking an hour jumps the list below to it.
 */
export const DayStrip = memo(function DayStrip({
  data,
  from,
  to,
  tz,
  onPick,
}: {
  data: Timeline;
  from: Date;
  to: Date;
  tz: string;
  onPick: (t: number) => void;
}) {
  const start = from.getTime();
  const span = to.getTime() - start;
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const pct = (t: number) => `${(Math.max(0, Math.min(span, t - start)) / span) * 100}%`;
  const width = (a: number, b: number) =>
    `max(2px, ${((Math.min(b, start + span) - Math.max(a, start)) / span) * 100}%)`;

  const { audio, conversations, bookmarks } = useMemo(() => {
    const slack = span / 1000; // ~1.5 min on a 24 h strip: merge what's visually contiguous
    return {
      audio: mergeIntervals(
        data.chunks.map((c) => [c.startAt.getTime(), c.endAt.getTime()]),
        slack,
      ),
      conversations: data.conversations.map((c) => ({
        id: c.id,
        title: c.title ?? "Conversation",
        start: c.startedAt.getTime(),
        end: c.endedAt?.getTime() ?? Math.min(Date.now(), start + span),
      })),
      bookmarks: data.bookmarks.map((b) => ({ id: b.id, at: b.at.getTime() })),
    };
  }, [data, span, start]);

  const hours = useMemo(() => {
    const list: number[] = [];
    for (let t = start; t < start + span; t += HOUR) list.push(t);
    return list;
  }, [start, span]);

  const timeAt = (clientX: number): number | null => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return start + x * span;
  };

  const onMove = (e: PointerEvent) => setHover(timeAt(e.clientX));

  const hoverInfo = useMemo(() => {
    if (hover === null) return null;
    const recording = audio.some(([a, b]) => hover >= a && hover <= b);
    const conv = conversations.find((c) => hover >= c.start && hover <= c.end);
    const parts = [formatTime(hover, tz)];
    if (conv) parts.push(conv.title);
    else if (recording) parts.push("recorded");
    return parts.join(" · ");
  }, [hover, audio, conversations, tz]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <Swatch className="h-2.5 w-3 rounded-[3px] bg-series-1" label="Audio recorded" />
        <Swatch className="h-1.5 w-3 rounded-[3px] bg-series-2" label="Conversations" />
        <Swatch className="h-2.5 w-0.5 rounded-full bg-series-3" label="Bookmarks" />
      </div>
      <div
        ref={track}
        className="relative h-11 rounded-md bg-surface-2"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* 3-hour gridlines */}
        {hours.map((t, i) =>
          i > 0 && i % 3 === 0 ? (
            <span
              key={t}
              aria-hidden
              className="absolute inset-y-0 w-px bg-line-strong/50"
              style={{ left: pct(t) }}
            />
          ) : null,
        )}
        {audio.map(([a, b]) => (
          <span
            key={a}
            aria-hidden
            className="absolute top-1.5 h-3.5 rounded-[3px] bg-series-1"
            style={{ left: pct(a), width: width(a, b) }}
          />
        ))}
        {conversations.map((c) => (
          <span
            key={c.id}
            aria-hidden
            className="absolute top-6 h-1.5 rounded-[3px] bg-series-2"
            style={{ left: pct(c.start), width: width(c.start, c.end) }}
          />
        ))}
        {bookmarks.map((b) => (
          <span
            key={b.id}
            aria-hidden
            className="absolute top-[31px] h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-series-3"
            style={{ left: pct(b.at) }}
          />
        ))}
        {/* One button per hour: keyboard-accessible jumps; mouse clicks use the exact time. */}
        {hours.map((t) => (
          <button
            key={t}
            type="button"
            aria-label={`Jump to ${formatTime(t, tz)}`}
            className="absolute inset-y-0 cursor-crosshair focus-visible:z-10 focus-visible:bg-accent/10"
            style={{ left: pct(t), width: width(t, t + HOUR) }}
            onClick={(e) => onPick(e.detail > 0 ? (timeAt(e.clientX) ?? t) : t)}
          />
        ))}
        {hover !== null ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-ink/60"
              style={{ left: pct(hover) }}
            />
            <span
              className="pointer-events-none absolute -top-7 z-20 -translate-x-1/2 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11px] whitespace-nowrap text-ink shadow-pop"
              style={{ left: `clamp(48px, ${pct(hover)}, calc(100% - 48px))` }}
            >
              {hoverInfo}
            </span>
          </>
        ) : null}
      </div>
      <div className="relative h-4 text-[11px] text-ink-3 tabular">
        {hours.map((t, i) =>
          i % 3 === 0 ? (
            <span
              key={t}
              className={cn(
                "absolute -translate-x-1/2 first:translate-x-0",
                i % 6 !== 0 && "max-sm:hidden",
              )}
              style={{ left: pct(t) }}
            >
              {formatHour(t, tz)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
});
