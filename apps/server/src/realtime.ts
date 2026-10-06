import type { RealtimeEvent } from "@hearloom/api";
import type { Server } from "bun";

type Key = Extract<RealtimeEvent, { t: "invalidate" }>["keys"][number];

let server: Server<unknown> | null = null;
const pending = new Map<string, Set<Key>>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function attachRealtimeServer(s: Server<unknown>): void {
  server = s;
}

export function topicFor(userId: string): string {
  return `user:${userId}`;
}

/** Tell a user's open consoles to refetch some queries (debounced, coalesced). */
export function invalidate(userId: string, keys: Key[]): void {
  const set = pending.get(userId) ?? new Set<Key>();
  for (const k of keys) set.add(k);
  pending.set(userId, set);
  if (timer === null) timer = setTimeout(flush, 250);
}

function flush(): void {
  timer = null;
  if (!server) return;
  for (const [userId, keys] of pending) {
    const event: RealtimeEvent = { t: "invalidate", keys: [...keys] };
    server.publish(topicFor(userId), JSON.stringify(event));
  }
  pending.clear();
}
