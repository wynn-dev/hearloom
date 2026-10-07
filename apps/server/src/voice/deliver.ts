/** Delays before each attempt (the first is immediate): 3 attempts within about 20 s. */
export const ATTEMPT_DELAYS_MS = [0, 2_000, 6_000];
/** Never start an attempt for a command spoken longer ago than this (it would be stale). */
export const MAX_AGE_MS = 60_000;
export const ATTEMPT_TIMEOUT_MS = 5_000;

export type PostResult = { status: number; body: string } | { error: string };

export interface DeliveryOutcome {
  status: "sent" | "failed" | "expired";
  /** Why it failed (http_401, route_ignored, timeout…). */
  reason: string | null;
  attempts: number;
  httpStatus: number | null;
}

/**
 * Deliver a voice command with retries: network errors, 5xx and 429 are retried; other 4xx fail
 * at once (a 401 means a wrong secret: retrying won't help). Hermes answers `{"status":"duplicate"}`
 * when it already has the event id (a retry after a lost response): that's a success;
 * `{"status":"ignored"}` means the route's event filter doesn't take voice commands.
 */
export async function deliverWithRetries(
  post: (attempt: number) => Promise<PostResult>,
  spokenAt: number,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeliveryOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let last: DeliveryOutcome = {
    status: "expired",
    reason: "too_old",
    attempts: 0,
    httpStatus: null,
  };
  for (const [i, delay] of ATTEMPT_DELAYS_MS.entries()) {
    if (delay > 0) await sleep(delay);
    if (now() - spokenAt > MAX_AGE_MS) {
      return i === 0 ? last : { ...last, status: "expired" };
    }
    const r = await post(i + 1);
    if ("error" in r) {
      last = { status: "failed", reason: r.error, attempts: i + 1, httpStatus: null };
      continue;
    }
    const answer = parseStatus(r.body);
    if (r.status >= 200 && r.status < 300) {
      if (answer === "ignored")
        return { status: "failed", reason: "route_ignored", attempts: i + 1, httpStatus: r.status };
      return { status: "sent", reason: null, attempts: i + 1, httpStatus: r.status };
    }
    last = { status: "failed", reason: `http_${r.status}`, attempts: i + 1, httpStatus: r.status };
    if (r.status !== 429 && r.status < 500) return last;
  }
  return last;
}

function parseStatus(body: string): string | null {
  try {
    const v = JSON.parse(body) as { status?: unknown };
    return typeof v?.status === "string" ? v.status : null;
  } catch {
    return null;
  }
}

/** Human text for a failure reason, for the console and the failure notification. */
export function describeFailure(reason: string | null): string {
  if (!reason) return "unknown error";
  if (reason === "no_webhook") return "no webhook URL is set";
  if (reason === "route_ignored") return "the agent's webhook route doesn't accept voice.command";
  if (reason === "too_old") return "it was too old to send";
  if (reason === "http_401" || reason === "http_403") return "the webhook secret was rejected";
  if (reason.startsWith("http_")) return `the agent answered HTTP ${reason.slice(5)}`;
  return reason;
}
