import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Cookie-based Better Auth client (the console is served from the same origin as the server). */
export const authClient = createAuthClient({
  baseURL: location.origin,
  plugins: [adminClient()],
});

export type Session = typeof authClient.$Infer.Session;

/** Ask Better Auth to refetch the session (e.g. after an RPC came back UNAUTHORIZED). */
export function refreshSession(): void {
  authClient.$store.notify("$sessionSignal");
}

/** Only allow in-app redirect targets (no protocol-relative or absolute URLs). */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/login"))
    return undefined;
  return value;
}

/**
 * Sign this browser in with a "Link device" code: the server sets the session cookie. Throws the
 * server's message if the code is wrong, used or expired. Callers then clear the query cache and
 * refetch the session.
 */
export async function redeemLinkCode(code: string): Promise<{ email: string }> {
  let response: Response;
  try {
    response = await fetch(`${location.origin}/api/auth/link/redeem`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new Error("Can't reach the server");
  }
  const body = (await response.json().catch(() => null)) as {
    user?: { email: string };
    message?: string;
  } | null;
  if (!response.ok || !body?.user) {
    throw new Error(
      body?.message ||
        (response.status === 429
          ? "Too many tries. Wait a few seconds and try again."
          : `Sign-in failed (${response.status})`),
    );
  }
  return { email: body.user.email };
}
