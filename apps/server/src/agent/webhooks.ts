import { createHmac } from "node:crypto";
import { getSettings } from "../settings";

export type AgentEvent =
  | {
      type: "conversation.ended";
      conversationId: string;
      startedAt: string;
      endedAt: string | null;
    }
  | { type: "conversation.refined"; conversationId: string }
  | { type: "bookmark"; at: string; source: string; note: string | null }
  | { type: "test"; message: string };

const EVENT_SETTING: Record<
  AgentEvent["type"],
  "conversationEnded" | "conversationRefined" | "bookmark" | null
> = {
  "conversation.ended": "conversationEnded",
  "conversation.refined": "conversationRefined",
  bookmark: "bookmark",
  test: null,
};

/**
 * POST an event to the user's agent webhook. Signed like many webhook providers:
 *   X-Hearloom-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>
 *   X-Hearloom-Timestamp: <unix seconds>
 * Bodies only reference ids/times — the agent fetches content over MCP with its token.
 */
export async function sendAgentEvent(
  userId: string,
  event: AgentEvent,
): Promise<{ ok: boolean; status: number; error: string | null }> {
  const { agent } = await getSettings(userId);
  const setting = EVENT_SETTING[event.type];
  if (!agent.webhookUrl) return { ok: false, status: 0, error: "no webhook configured" };
  if (setting && !agent.events[setting]) return { ok: false, status: 0, error: "event disabled" };
  const body = JSON.stringify({ ...event, userId, sentAt: new Date().toISOString() });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-hearloom-event": event.type,
    "x-hearloom-timestamp": timestamp,
  };
  if (agent.webhookSecret) {
    headers["x-hearloom-signature"] =
      `sha256=${createHmac("sha256", agent.webhookSecret).update(`${timestamp}.${body}`).digest("hex")}`;
  }
  try {
    const res = await fetch(agent.webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? null : (await res.text()).slice(0, 200),
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fire-and-forget variant for pipeline events. */
export function emitAgentEvent(userId: string, event: AgentEvent): void {
  void sendAgentEvent(userId, event).then((r) => {
    if (!r.ok && r.error !== "no webhook configured" && r.error !== "event disabled") {
      console.warn(`[agent] webhook ${event.type} failed: ${r.status} ${r.error}`);
    }
  });
}
