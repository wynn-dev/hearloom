import { BatteryWarning } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { formatDateTime, formatRelative } from "../lib/time";

/** Relative timestamp ("5 min. ago") with the absolute time on hover. */
export function RelTime({
  date,
  now,
  tz,
  className,
}: {
  date: Date | null | undefined;
  now: number;
  tz: string;
  className?: string;
}) {
  if (!date) return <span className={cn("text-ink-3", className)}>never</span>;
  return (
    <time dateTime={date.toISOString()} title={formatDateTime(date, tz)} className={className}>
      {formatRelative(date, now)}
    </time>
  );
}

/**
 * Battery meter: the fill carries severity (accent → warning → critical) over a lighter track of
 * the same ramp; the percentage is always printed so color never carries meaning alone.
 */
export function BatteryMeter({ level, low = 15 }: { level: number | null; low?: number }) {
  if (level === null) return <span className="text-ink-3">—</span>;
  const pct = Math.max(0, Math.min(100, Math.round(level)));
  const severity = pct <= low ? "bad" : pct <= Math.max(30, low * 2) ? "warn" : "ok";
  const fill = { bad: "bg-bad", warn: "bg-warn", ok: "bg-accent" }[severity];
  const track = { bad: "bg-bad-soft", warn: "bg-warn-soft", ok: "bg-accent-track/60" }[severity];
  return (
    <span className="inline-flex items-center gap-2" title={`Battery ${pct}%`}>
      <span aria-hidden className={cn("relative h-1.5 w-12 overflow-hidden rounded-full", track)}>
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", fill)}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="tabular text-ink-2">{pct}%</span>
      {severity === "bad" ? (
        <BatteryWarning className="size-3.5 text-bad" aria-label="Low battery" />
      ) : null}
    </span>
  );
}

/** Short stat used in page summary rows. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="truncate text-lg font-semibold text-ink">{value}</p>
      {hint ? <p className="truncate text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}
