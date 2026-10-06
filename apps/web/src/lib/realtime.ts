import type { RealtimeEvent } from "@hearloom/api";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { orpc } from "./orpc";

type InvalidateKey = Extract<RealtimeEvent, { t: "invalidate" }>["keys"][number];

/** Server invalidation keys → the oRPC query keys they cover (partial matches). */
const KEYS: Record<InvalidateKey, QueryKey[]> = {
  status: [orpc.status.key(), orpc.wearables.key()],
  timeline: [orpc.timeline.key()],
  notifications: [orpc.notifications.key()],
  phones: [orpc.phones.key(), orpc.status.key()],
};

export type RealtimeState = "connecting" | "open" | "reconnecting";

let state: RealtimeState = "connecting";
const listeners = new Set<() => void>();

function setState(next: RealtimeState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRealtimeState(): RealtimeState {
  return useSyncExternalStore(subscribe, () => state);
}

function parse(data: unknown): RealtimeEvent | null {
  if (typeof data !== "string") return null;
  try {
    const event = JSON.parse(data) as RealtimeEvent;
    return event && typeof event === "object" && "t" in event ? event : null;
  } catch {
    return null;
  }
}

/**
 * Keep a `/realtime` socket open while signed in. The server pushes `invalidate` events and we
 * refetch the matching queries; after a reconnect everything is refetched (events may be lost).
 */
export function useRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    let hasConnected = false;

    const connect = () => {
      clearTimeout(timer);
      setState(hasConnected ? "reconnecting" : "connecting");
      const url = new URL("/realtime", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        attempt = 0;
        setState("open");
        if (hasConnected) void queryClient.invalidateQueries();
        hasConnected = true;
      };
      ws.onmessage = (message) => {
        const event = parse(message.data);
        if (event?.t !== "invalidate") return;
        for (const key of event.keys) {
          for (const queryKey of KEYS[key] ?? []) void queryClient.invalidateQueries({ queryKey });
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (stopped) return;
        setState("reconnecting");
        const base = Math.min(30_000, 1_000 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, base * (0.75 + Math.random() * 0.5));
      };
    };

    // Reconnect right away when the tab comes back or the network returns.
    const kick = () => {
      if (stopped || socket || document.visibilityState !== "visible") return;
      attempt = 0;
      connect();
    };

    connect();
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", kick);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", kick);
      socket?.close();
      socket = null;
      setState("connecting");
    };
  }, [queryClient]);
}
