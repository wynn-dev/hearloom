import { createHmac } from "node:crypto";
import { getSettings } from "../settings";

/** An event for the user's agent. Receivers dedupe on `id`, so a retry must reuse it. */
export interface WebhookEvent {
  id: string;
  type: string;
  [field: string]: unknown;
}

export interface WebhookResult {
  ok: boolean;
  /** HTTP status; 0 when no request was made or it failed before a response. */
  status: number;
  error: string | null;
}

/**
 * Standard Webhooks (https://www.standardwebhooks.com) signature, as Hermes checks it:
 * `v1,<base64 HMAC-SHA256(key, "{id}.{timestamp}.{body}")>`. The key is the base64 part of a
 * `whsec_…` secret, or the secret's UTF-8 bytes otherwise.
 */
export function webhookSignature(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): string {
  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/**
 * POST an event to the user's agent webhook (settings `agent.webhookUrl`), signed with
 * `agent.webhookSecret` when one is set. One attempt; the caller decides about retries.
 * The body is the event plus `userId` and `sentAt`.
 */
export async function sendWebhook(
  userId: string,
  event: WebhookEvent,
  opts: { timeoutMs?: number } = {},
): Promise<WebhookResult> {
  const { agent } = await getSettings(userId);
  if (!agent.webhookUrl) return { ok: false, status: 0, error: "no webhook configured" };
  const body = JSON.stringify({ ...event, userId, sentAt: new Date().toISOString() });
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "webhook-id": event.id,
    "webhook-timestamp": String(timestamp),
  };
  if (agent.webhookSecret) {
    headers["webhook-signature"] = webhookSignature(agent.webhookSecret, event.id, timestamp, body);
  }
  try {
    const res = await fetch(agent.webhookUrl, {
      method: "POST",
      headers,
      body,
      // Don't follow redirects (could point anywhere) or relay response bodies to the caller.
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    await res.body?.cancel();
    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? null : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
