import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Brand } from "../components/brand";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/input";
import { authClient, safeRedirect } from "../lib/auth";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in (or just signed in): go where we were headed — once.
  const left = useRef(false);
  const signedIn = Boolean(session.data);
  useEffect(() => {
    if (!signedIn || left.current) return;
    left.current = true;
    router.history.replace(redirect ?? "/");
  }, [signedIn, redirect, router]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.email({ email: email.trim(), password });
    if (result.error) {
      setError(result.error.message || result.error.statusText || "Sign-in failed");
      setBusy(false);
      return;
    }
    queryClient.clear();
    await session.refetch();
    setBusy(false);
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6 shadow-pop"
        >
          <div>
            <h1 className="text-base font-semibold">Sign in</h1>
            <p className="text-[13px] text-ink-3">Your always-on audio memory.</p>
          </div>
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
          {error ? (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-md bg-bad-soft px-2.5 py-2 text-[13px] text-bad-ink"
            >
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" loading={busy} className="justify-center">
            Sign in
          </Button>
          <p className="text-center text-xs text-ink-3">
            Accounts are created by an administrator.
          </p>
        </form>
      </div>
    </main>
  );
}
