import type { RealtimeEvent } from "@hearloom/api";
import type { Sql } from "postgres";
import { type AgentEvent, emitAgentEvent } from "./agent/webhooks";
import { invalidate } from "./realtime";

type Key = Extract<RealtimeEvent, { t: "invalidate" }>["keys"][number];

/**
 * Cross-process "something changed" events over Postgres LISTEN/NOTIFY: the worker publishes,
 * the server relays them to connected consoles.
 */
const CHANNEL = "hearloom_events";

export async function publishChange(
  sql: Sql,
  userId: string,
  keys: Key[],
  agentEvent?: AgentEvent,
): Promise<void> {
  await sql.notify(CHANNEL, JSON.stringify({ userId, keys, agentEvent }));
}

export async function relayChanges(sql: Sql): Promise<void> {
  await sql.listen(
    CHANNEL,
    (payload) => {
      try {
        const { userId, keys, agentEvent } = JSON.parse(payload) as {
          userId: string;
          keys: Key[];
          agentEvent?: AgentEvent;
        };
        invalidate(userId, keys);
        if (agentEvent) emitAgentEvent(userId, agentEvent);
      } catch {}
    },
    // Events missed while reconnecting can't be recovered: refresh everything instead.
    () => {},
  );
}
