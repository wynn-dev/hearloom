/** "Link device" sign-in helpers for the console (pure: no DOM, no network). */
import { parseLinkInput } from "@hearloom/shared";

/** The code from a `/link` page's hash (`#code=XXXX-XXXX-XXXX`), or null. */
export function codeFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("code")?.trim();
  return code ? code : null;
}

/**
 * What was pasted into the login page: the code to redeem, or why it can't be used here. The console
 * only signs in to the server it is served from, so a link for another server is refused rather than
 * redeemed against this one (where the code means nothing).
 */
export function linkCodeFor(
  input: string,
  origin: string,
): { code: string; error?: undefined } | { code?: undefined; error: string } {
  if (!input.trim()) return { error: "Paste a link or a code." };
  const parsed = parseLinkInput(input);
  if (!parsed) {
    return { error: "That isn't a link code. It looks like XXXX-XXXX-XXXX, or a link with one." };
  }
  if (parsed.server && parsed.server !== origin.replace(/\/+$/, "")) {
    return {
      error: `That link is for ${parsed.server}, not this server. Open the link itself, or sign in there.`,
    };
  }
  return { code: parsed.code };
}

/** "4:59" until `expiresAt` (whole seconds left, never more than it has); "0:00" once it has passed. */
export function formatCountdown(expiresAt: Date | number, now: number): string {
  const end = typeof expiresAt === "number" ? expiresAt : expiresAt.getTime();
  const total = Math.max(0, Math.floor((end - now) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
