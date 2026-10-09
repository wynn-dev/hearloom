import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown, Link2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Brand } from "../components/brand";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/input";
import { authClient, redeemLinkCode, safeRedirect } from "../lib/auth";
import { cn } from "../lib/cn";
import { linkCodeFor } from "../lib/link";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeRedirect(search.redirect);
    return redirect ? { redirect } : {};
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect } = Route.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = authClient.useSession();

  // Already signed in (or just signed in): go where we were headed — once.
  const left = useRef(false);
  const signedIn = Boolean(session.data);
  useEffect(() => {
    if (!signedIn || left.current) return;
    left.current = true;
    router.history.replace(redirect ?? "/");
  }, [signedIn, redirect, router]);

  /** After either way of signing in: drop anything cached, then the effect above leaves. */
  const signedInNow = async () => {
    queryClient.clear();
    await session.refetch();
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-3">
        <div className="mb-3 flex justify-center">
          <Brand />
        </div>
        <LinkForm onSignedIn={signedInNow} />
        <PasswordForm onSignedIn={signedInNow} />
        <p className="text-center text-xs text-ink-3">Accounts are created by an administrator.</p>
      </div>
    </main>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="flex items-center gap-2 rounded-md bg-bad-soft px-2.5 py-2 text-[13px] text-bad-ink"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      {error}
    </p>
  );
}

/** The usual way in: a code (or its link) from a device that is already signed in. */
function LinkForm({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = linkCodeFor(input, location.origin);
    if (target.error !== undefined) {
      setError(target.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await redeemLinkCode(target.code);
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6 shadow-pop"
    >
      <div>
        <h1 className="text-base font-semibold">Sign in</h1>
        <p className="text-[13px] text-ink-3">Your always-on audio memory.</p>
      </div>
      <Field
        label="Link or code"
        htmlFor="link-code"
        hint={
          <>
            Make one on a signed-in device: <b className="font-medium">Devices → Link a device</b>.
            Or on the server: <code className="font-mono">pnpm link-device --email you@…</code>
          </>
        }
      >
        <Input
          id="link-code"
          required
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX or a link"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-invalid={error ? true : undefined}
          className="font-mono"
        />
      </Field>
      <ErrorLine error={error} />
      <Button type="submit" variant="primary" loading={busy} className="justify-center">
        <Link2 aria-hidden />
        Link this browser
      </Button>
    </form>
  );
}

/** Passwords still work while everyone moves to linked devices. */
function PasswordForm({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        setError(result.error.message || result.error.statusText || "Sign-in failed");
        return;
      }
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Can't reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="password-form"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-6 py-3 text-[13px] text-ink-2 hover:text-ink"
      >
        Sign in with a password instead
        <ChevronDown
          className={cn("size-4 text-ink-3 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open ? (
        <form
          id="password-form"
          onSubmit={submit}
          className="flex flex-col gap-4 border-t border-line px-6 pt-4 pb-6"
        >
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <ErrorLine error={error} />
          <Button type="submit" loading={busy} className="justify-center">
            Sign in
          </Button>
        </form>
      ) : null}
    </div>
  );
}
