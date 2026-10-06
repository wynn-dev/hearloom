import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { cn } from "../../lib/cn";

type ToastTone = "good" | "bad" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

type ToastInput = Omit<ToastItem, "id" | "tone"> & { tone?: ToastTone };

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId++;
      setItems((list) => [...list.slice(-3), { tone: "info", ...input, id }]);
      setTimeout(() => dismiss(id), input.tone === "bad" ? 7000 : 4000);
    },
    [dismiss],
  );

  const icons = useMemo(
    () => ({
      good: <CheckCircle2 className="size-4 text-good" aria-hidden />,
      bad: <XCircle className="size-4 text-bad" aria-hidden />,
      info: <Info className="size-4 text-accent" aria-hidden />,
    }),
    [],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "bad" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 shadow-pop",
            )}
          >
            <span className="mt-px">{icons[t.tone]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-ink">{t.title}</p>
              {t.description ? <p className="text-xs text-ink-2">{t.description}</p> : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="cursor-pointer rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext);
}
