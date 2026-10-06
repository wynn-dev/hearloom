import { createFileRoute, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState } from "react";
import { AppShell } from "../components/app-shell";
import { Brand } from "../components/brand";
import { ErrorNotice, Spinner } from "../components/ui/misc";
import { authClient, safeRedirect } from "../lib/auth";
import { queryClient } from "../lib/query";
import { useRealtime } from "../lib/realtime";

/** Pathless layout for every signed-in page: session gate, realtime socket, app shell. */
export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function FullPageSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-ink-3">
      <Spinner className="size-5" />
    </div>
  );
}

function AppLayout() {
  const session = authClient.useSession();

  if (session.isPending && !session.data) return <FullPageSpinner />;

  if (!session.data) {
    if (session.error) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4">
          <Brand />
          <ErrorNotice
            className="max-w-md"
            error={new Error(`Can't reach the Hearloom server: ${session.error.message}`)}
            onRetry={() => void session.refetch()}
          />
        </div>
      );
    }
    return <RedirectToLogin />;
  }

  return <SignedIn key={session.data.user.id} userId={session.data.user.id} />;
}

/** Whose data the query cache holds. */
let cacheOwner: string | null = null;

/**
 * Navigate to /login exactly once, remembering where we were. (While a navigation is pending the
 * router already reports the *new* location, so deriving the target on every render would loop.)
 */
function RedirectToLogin() {
  const router = useRouter();
  const navigate = useNavigate();
  const [target] = useState(() => {
    const href = safeRedirect(router.state.location.href);
    return href === "/" ? undefined : href;
  });

  useEffect(() => {
    void navigate({ to: "/login", search: target ? { redirect: target } : {}, replace: true });
  }, [navigate, target]);

  return <FullPageSpinner />;
}

function SignedIn({ userId }: { userId: string }) {
  // A different user is signed in now (e.g. switched accounts in another tab): drop the previous
  // user's cached data before any page reads it.
  const [ready, setReady] = useState(cacheOwner === null || cacheOwner === userId);
  useLayoutEffect(() => {
    if (cacheOwner !== null && cacheOwner !== userId) queryClient.clear();
    cacheOwner = userId;
    setReady(true);
  }, [userId]);
  if (!ready) return <FullPageSpinner />;
  return <SignedInShell />;
}

function SignedInShell() {
  useRealtime();
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
