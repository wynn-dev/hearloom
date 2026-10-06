import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Switch({
  checked,
  onChange,
  disabled,
  id,
  label,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** Accessible name when there is no visible <label htmlFor>. */
  label?: string;
  className?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-line-strong bg-surface-3",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** A full-width settings row: title + description on the left, a control on the right. */
export function SettingRow({
  title,
  description,
  htmlFor,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-60">
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
          {title}
        </label>
        {description ? <p className="text-xs text-ink-3">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
