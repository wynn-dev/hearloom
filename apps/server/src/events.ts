import type { RealtimeEvent } from "@hearloom/api";
import type { Sql } from "postgres";
import { invalidate } from "./realtime";

type Key = Extract<RealtimeEvent, { t: "invalidate" }>["keys"][number];

/**
 * Cross-process "something changed" events over Postgres LISTEN/NOTIFY: the worker publishes,
 * the server relays them to connected consoles.
 */
const CHANNEL = "hearloom_events";

export async function publishChange(sql: Sql, userId: string, keys: Key[]): Promise<void> {
  await sql.notify(CHANNEL, JSON.stringify({ userId, keys }));
}

export async function relayChanges(sql: Sql): Promise<void> {
  await sql.listen(
    CHANNEL,
    (payload) => {
      try {
        const { userId, keys } = JSON.parse(payload) as { userId: string; keys: Key[] };
        invalidate(userId, keys);
      } catch {}
    },
    // Events missed while reconnecting can't be recovered: refresh everything instead.
    () => {},
  );
}
