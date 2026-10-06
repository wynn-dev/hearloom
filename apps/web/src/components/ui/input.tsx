import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "../../lib/cn";

const base =
  "rounded-md border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-3 transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-60 aria-invalid:border-bad";

/** Full width unless the caller sets a width utility (no class merging library here). */
function control(className: string | undefined, ...extra: string[]) {
  const sized = /(^|\s)w-/.test(className ?? "");
  return cn(base, !sized && "w-full", ...extra, className);
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={control(className, "h-8.5")} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={control(className, "min-h-18 py-2 leading-snug")} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={control(className, "h-8.5 cursor-pointer pr-7")} {...props}>
      {children}
    </select>
  );
}

/** Label + control + hint/error, stacked. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-bad-ink">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}
