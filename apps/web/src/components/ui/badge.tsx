import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  accent: "bg-accent-soft text-accent-ink border-accent/25",
  good: "bg-good-soft text-good-ink border-good/25",
  warn: "bg-warn-soft text-warn-ink border-warn/35",
  bad: "bg-bad-soft text-bad-ink border-bad/30",
  info: "bg-info-soft text-info-ink border-info-ink/20",
};

const dots: Record<Tone, string> = {
  neutral: "bg-ink-3",
  accent: "bg-accent",
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info-ink",
};

export function Badge({
  tone = "neutral",
  dot = false,
  title,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full border px-1.75 text-[11px] leading-none font-medium whitespace-nowrap",
        "[&_svg]:size-3 [&_svg]:shrink-0",
        tones[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className={cn("size-1.5 rounded-full", dots[tone])} /> : null}
      {children}
    </span>
  );
}
