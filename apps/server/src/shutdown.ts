import type { Server } from "bun";

/**
 * Let HTTP requests in flight finish (for up to `graceMs`), then stop and close every connection.
 * A plain `stop()` waits for open websockets (phones, console tabs), which never close on their
 * own; and in Bun 1.3 a `stop(true)` after it no longer closes them. Phones reconnect and resend
 * what wasn't acknowledged.
 */
export async function stopServer(
  server: Pick<Server<unknown>, "stop" | "pendingRequests">,
  graceMs = 3000,
): Promise<void> {
  const until = Date.now() + graceMs;
  while (server.pendingRequests > 0 && Date.now() < until) await Bun.sleep(50);
  await server.stop(true);
}

/**
 * Exit anyway if shutdown takes longer than `ms` (a step that hangs must not keep the server down
 * half-stopped). Audio not flushed yet is in the spool, recovered at the next start.
 */
export function shutdownDeadline(ms: number, exit: (code: number) => void = process.exit): void {
  setTimeout(() => {
    console.error(`[hearloom] shutdown took over ${ms / 1000} s: exiting anyway`);
    exit(1);
  }, ms).unref();
}
