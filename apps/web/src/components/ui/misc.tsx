import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/orpc";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn("size-3.5 animate-spin", className)} />;
}

/** Status dot; pass `pulse` for live things. Always pair with a text label. */
export function Dot({
  tone,
  pulse = false,
  className,
}: {
  tone: "good" | "warn" | "bad" | "muted" | "accent";
  pulse?: boolean;
  className?: string;
}) {
  const color = {
    good: "bg-good",
    warn: "bg-warn",
    bad: "bg-bad",
    muted: "bg-line-strong",
    accent: "bg-accent",
  }[tone];
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse ? (
        <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", color)} />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1.5 px-6 py-8 text-center text-ink-3 [&_svg]:size-5",
        className,
      )}
    >
      {icon}
      <p className="font-medium text-ink-2">{title}</p>
      {children ? <div className="max-w-md text-[13px]">{children}</div> : null}
    </div>
  );
}

export function ErrorNotice({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-2 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad-ink",
        className,
      )}
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{errorMessage(error)}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer font-medium underline underline-offset-2"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-2", className)} />;
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} className="h-5" />
      ))}
    </div>
  );
}
