import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/orpc";
import { Button } from "./button";

/** Minimal modal built on the native <dialog> element (focus trap, Esc and top layer for free). */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className={cn(
        "m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink shadow-pop",
        className,
      )}
    >
      {open ? (
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {description ? <p className="mt-1 text-[13px] text-ink-2">{description}</p> : null}
          </div>
          {children}
          {footer ? <div className="flex justify-end gap-2">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** A button that asks for confirmation in a dialog before running an (async) action. */
export function ConfirmButton({
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  children,
  variant = "danger",
  size = "sm",
  disabled,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | undefined;
  children: ReactNode;
  variant?: "danger" | "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "icon";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant={variant} size={size} disabled={disabled} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              loading={busy}
              onClick={run}
              autoFocus
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        {error ? <p className="text-[13px] text-bad-ink">{error}</p> : null}
      </Dialog>
    </>
  );
}
