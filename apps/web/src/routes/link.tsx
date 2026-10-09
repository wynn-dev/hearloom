import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Link2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Brand } from "../components/brand";
import { Button, buttonClass } from "../components/ui/button";
import { Spinner } from "../components/ui/misc";
import { authClient, redeemLinkCode } from "../lib/auth";
import { codeFromHash } from "../lib/link";
import { client } from "../lib/orpc";

/**
 * Where a "Link device" web link lands (`/link#code=…`): signs this browser in with the code. Public,
 * like /login. The code rides in the hash, so it never reaches the server's logs; it is dropped from
 * the address bar (and history) as soon as the page has read it.
 */
export const Route = createFileRoute("/link")({
  component: LinkPage,
});

/**
 * The code this page was opened with. Kept here between the first render and the hash being
 * removed, since StrictMode renders twice (and the second render must still see it).
 */
let openedWith: string | null = null;

function readCode(): string | null {
  const code = codeFromHash(location.hash);
  if (code) openedWith = code;
  return openedWith;
}

type Phase = "idle" | "redeeming" | "done" | { error: string };

function LinkPage() {
  const [code] = useState(readCode);
  useLayoutEffect(() => {
    // Out of the address bar and history: keep the router's state, drop the hash.
    if (location.hash) {
      history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    }
    return () => {
      openedWith = null;
    };
  }, []);
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("idle");

  /** `replace`: this browser is signed in already; that sign-in ends once the code has worked. */
  const redeem = async (code: string, replace: boolean) => {
    setPhase("redeeming");
    const previous = replace ? session.data?.session.id : undefined;
    try {
      // Redeem first: a wrong or used code leaves the current sign-in alone.
      await redeemLinkCode(code);
      // The old session's cookie is gone; end it too (when it was the same account: another
      // account's sessions are its own to manage, under Devices).
      if (previous) await client.sessions.revoke({ id: previous }).catch(() => {});
      queryClient.clear();
      setPhase("done");
      await session.refetch();
      await navigate({ to: "/", replace: true });
    } catch (err) {
      setPhase({ error: err instanceof Error ? err.message : "Sign-in failed" });
    }
  };

  // Not signed in: use the code straight away (once; StrictMode runs effects twice).
  const started = useRef(false);
  const signedIn = Boolean(session.data);
  const settled = !session.isPending || signedIn;
  useEffect(() => {
    if (!code || !settled || signedIn || phase !== "idle" || started.current) return;
    started.current = true;
    void redeem(code, false);
  });

  if (!code) {
    return (
      <Frame title="Link this browser">
        <p className="text-[13px] text-ink-2">
          This page signs a browser in with a link from a signed-in device, and the link it was
          opened with had no code.
        </p>
        <p className="text-[13px] text-ink-2">
          Get one on a signed-in device: <b>Devices → Link a device</b>, and open its browser link
          here. Or, on the server:{" "}
          <code className="font-mono text-xs">pnpm link-device --email you@…</code>
        </p>
        <Link to="/login" className={buttonClass("secondary", "md", "justify-center")}>
          Go to sign-in
        </Link>
      </Frame>
    );
  }

  if (typeof phase === "object") {
    return (
      <Frame title="Couldn't link this browser">
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md bg-bad-soft px-2.5 py-2 text-[13px] text-bad-ink"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          {phase.error}
        </p>
        <p className="text-[13px] text-ink-2">
          Codes work once, for 5 minutes. Make a new one on a signed-in device (Devices → Link a
          device), or sign in another way.
        </p>
        <Link to="/login" className={buttonClass("secondary", "md", "justify-center")}>
          Go to sign-in
        </Link>
      </Frame>
    );
  }

  if (phase === "idle" && signedIn && session.data) {
    return (
      <Frame title="Already signed in">
        <p className="text-[13px] text-ink-2">
          You're signed in as{" "}
          <span className="font-medium text-ink">{session.data.user.email}</span>. This link signs
          the browser in as the account it was made for.
        </p>
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="justify-center" onClick={() => redeem(code, true)}>
            <Link2 aria-hidden />
            Sign in as the linked account instead
          </Button>
          <Button
            className="justify-center"
            onClick={() => void navigate({ to: "/", replace: true })}
          >
            Keep me signed in
          </Button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame title="Linking this browser…">
      <div className="flex items-center gap-2 text-[13px] text-ink-2" role="status">
        <Spinner />
        {phase === "done" ? "Signed in. Opening Hearloom…" : "Signing in…"}
      </div>
    </Frame>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6 shadow-pop">
          <h1 className="text-base font-semibold">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}
