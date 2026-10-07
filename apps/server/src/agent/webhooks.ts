import { createHmac } from "node:crypto";
import type { EpisodeKind, Settings } from "@hearloom/shared";
import { getSettings } from "../settings";

export type AgentEvent =
  | {
      type: "episode.ended";
      episodeId: string;
      kind: EpisodeKind;
      title: string | null;
      startedAt: string;
      endedAt: string;
    }
  | { type: "episode.refined"; episodeId: string }
  | { type: "bookmark"; at: string; source: string; note: string | null }
  | { type: "test"; message: string };

/** Is this event turned on in the user's settings? */
function enabled(settings: Settings, event: AgentEvent): boolean {
  const { events } = settings.agent;
  switch (event.type) {
    case "episode.ended":
      return events.episodeEnded[event.kind];
    case "episode.refined":
      return events.episodeRefined;
    case "bookmark":
      return events.bookmark;
    case "test":
      return true;
  }
}

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
  const settings = await getSettings(userId);
  const { agent } = settings;
  if (!agent.webhookUrl) return { ok: false, status: 0, error: "no webhook configured" };
  if (!enabled(settings, event)) return { ok: false, status: 0, error: "event disabled" };
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
      // Don't follow redirects (could point anywhere) or relay response bodies to the caller.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
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

/** Fire-and-forget variant for pipeline events. */
export function emitAgentEvent(userId: string, event: AgentEvent): void {
  void sendAgentEvent(userId, event).then((r) => {
    if (!r.ok && r.error !== "no webhook configured" && r.error !== "event disabled") {
      console.warn(`[agent] webhook ${event.type} failed: ${r.status} ${r.error}`);
    }
  });
}
