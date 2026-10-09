import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, Copy, RefreshCw, TimerOff } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toQR } from "toqr";
import { formatCountdown } from "../lib/link";
import { orpc } from "../lib/orpc";
import { qrPath } from "../lib/qr";
import { useNow } from "../lib/time";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { ErrorNotice, Spinner } from "./ui/misc";

/**
 * "Link a device": mints a single-use code when opened and shows it as a QR code (the iPhone app), a
 * link (a browser) and the code itself, then watches until a device uses it or it expires. `userId`:
 * an admin linking someone else's device. Closing stops the polling (the panel unmounts).
 */
export function LinkDeviceDialog({
  open,
  onClose,
  userId,
  title = "Link a device",
}: {
  open: boolean;
  onClose: () => void;
  userId?: string;
  title?: string;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} className="w-[min(26rem,calc(100vw-2rem))]">
      {/* Mounted only while open (Dialog renders nothing closed): each opening mints a fresh code. */}
      <LinkPanel userId={userId} onClose={onClose} />
    </Dialog>
  );
}

/** A QR code as crisp SVG: dark on white with its quiet zone, in light and dark mode alike. */
export function QrCode({ text, className }: { text: string; className?: string }) {
  const { size, d } = useMemo(() => qrPath(toQR(text)), [text]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="QR code"
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function LinkPanel({ userId, onClose }: { userId?: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const now = useNow(1000);
  const create = useMutation(orpc.sessions.createLink.mutationOptions());
  const link = create.data;

  // One code per opening (StrictMode runs effects twice; the ref survives that).
  const minted = useRef(false);
  const { mutate } = create;
  useEffect(() => {
    if (minted.current) return;
    minted.current = true;
    mutate({ userId });
  }, [mutate, userId]);

  const status = useQuery({
    ...orpc.sessions.linkStatus.queryOptions({ input: { id: link?.id ?? "" } }),
    enabled: Boolean(link),
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2000 : false),
  });

  const state = status.data?.status;
  // Don't wait for the next poll to say a code has run out.
  const expired =
    state === "expired" || (state !== "redeemed" && !!link && link.expiresAt.getTime() <= now);

  useEffect(() => {
    if (state === "redeemed") void queryClient.invalidateQueries({ queryKey: orpc.sessions.key() });
  }, [state, queryClient]);

  const footer = (
    <div className="flex justify-end gap-2">
      {expired || create.error ? (
        <Button onClick={() => create.mutate({ userId })} loading={create.isPending}>
          <RefreshCw aria-hidden />
          New code
        </Button>
      ) : null}
      <Button variant={state === "redeemed" ? "primary" : "ghost"} onClick={onClose}>
        {state === "redeemed" ? "Done" : "Close"}
      </Button>
    </div>
  );

  if (create.error) {
    return (
      <>
        <ErrorNotice error={create.error} />
        {footer}
      </>
    );
  }
  if (!link || create.isPending) {
    return (
      <>
        <div className="flex h-64 items-center justify-center text-ink-3">
          <Spinner className="size-5" />
        </div>
        {footer}
      </>
    );
  }

  if (state === "redeemed") {
    const device = status.data?.device;
    return (
      <>
        <div className="flex flex-col items-center gap-2 py-6 text-center" role="status">
          <CircleCheck className="size-10 text-good" aria-hidden />
          <p className="text-[15px] font-semibold">Linked</p>
          <p className="text-[13px] text-ink-2">
            {device ? (
              <>
                <span className="font-medium text-ink">{device.name}</span>
                {device.detail ? ` (${device.detail})` : null} is signed in as {link.email}.
              </>
            ) : (
              <>A device is now signed in as {link.email}.</>
            )}
          </p>
        </div>
        {footer}
      </>
    );
  }

  if (expired) {
    return (
      <>
        <div className="flex flex-col items-center gap-2 py-6 text-center" role="status">
          <TimerOff className="size-10 text-ink-3" aria-hidden />
          <p className="text-[15px] font-semibold">Expired</p>
          <p className="text-[13px] text-ink-2">
            Codes work for 5 minutes. Make a new one when the device is ready.
          </p>
        </div>
        {footer}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col items-center gap-2">
        <QrCode text={link.appUrl} className="size-52 rounded-lg border border-line" />
        <p className="text-center text-[13px] text-ink-2">
          <span className="font-medium text-ink">iPhone:</span> scan with the Camera app, then tap
          the Hearloom banner.
        </p>
      </div>
      <div className="text-center">
        <p className="text-xs text-ink-3">Or enter the code</p>
        <p className="font-mono text-2xl font-semibold tracking-wider select-all">{link.code}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-ink-2">For a browser: open this link</p>
        <CopyField value={link.webUrl} />
      </div>
      <p className="text-center text-xs text-ink-3" aria-live="polite">
        Signs one device in as <span className="font-medium text-ink-2">{link.email}</span> ·
        expires in <span className="tabular">{formatCountdown(link.expiresAt, now)}</span>
      </p>
      {footer}
    </>
  );
}

/** A read-only value with a Copy button (falls back to selecting it where the clipboard is off). */
function CopyField({ value }: { value: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access (plain HTTP on a LAN address): select it for ⌘C instead.
      (document.getElementById(id) as HTMLInputElement | null)?.select();
    }
  };

  return (
    <div className="flex gap-2">
      <Input
        id={id}
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
        aria-label="Link for a browser"
      />
      <Button onClick={copy}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
