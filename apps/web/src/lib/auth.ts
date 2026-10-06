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
