import { cn } from "../lib/cn";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6 shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <g stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
        <path d="M9 13v6" />
        <path d="M14 9v14" />
        <path d="M19 11v10" />
        <path d="M24 14v4" />
      </g>
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Logo />
      <span className="text-[15px] font-semibold tracking-tight text-ink">Hearloom</span>
    </span>
  );
}
