import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { refreshSession } from "./auth";
import { isUnauthorized } from "./orpc";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function idOf(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.id === "string" ? value.id : undefined;
}

/**
 * Structural sharing that understands `Date` (oRPC returns real Dates, which TanStack's default
 * treats as always-changed) and matches array items by `id`. Unchanged rows keep their identity
 * across refetches, so memoized list rows don't re-render on every realtime invalidation.
 */
export function shareDeep(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev;
  if (prev instanceof Date && next instanceof Date) {
    return prev.getTime() === next.getTime() ? prev : next;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    const byId = new Map<string, unknown>();
    for (const item of prev) {
      const id = idOf(item);
      if (id !== undefined) byId.set(id, item);
    }
    let same = prev.length === next.length;
    const out = next.map((item, i) => {
      const id = idOf(item);
      const before = id !== undefined && byId.has(id) ? byId.get(id) : prev[i];
      const shared = shareDeep(before, item);
      if (shared !== prev[i]) same = false;
      return shared;
    });
    return same ? prev : out;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const shared = shareDeep(prev[key], next[key]);
      out[key] = shared;
      if (shared !== prev[key] || !(key in prev)) same = false;
    }
    return same ? prev : out;
  }
  return next;
}

function onError(error: unknown): void {
  if (isUnauthorized(error)) refreshSession();
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      structuralSharing: shareDeep,
      retry: (count, error) => !isUnauthorized(error) && count < 2,
    },
    mutations: { retry: false },
  },
});
