import { expect, test } from "bun:test";
import { isStopping, shutdownDeadline, stopServer } from "./shutdown";

test("stopping the server lets a request finish, and doesn't wait for open websockets", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      await Bun.sleep(300);
      return new Response("slow");
    },
    websocket: { message() {} },
  });
  const ws = new WebSocket(`ws://localhost:${server.port}`);
  await new Promise((r) => {
    ws.onopen = r;
  });
  const closed = new Promise((r) => {
    ws.onclose = r;
  });
  const slow = fetch(`http://localhost:${server.port}/`).then((r) => r.text());
  await Bun.sleep(50);
  const t0 = Date.now();
  await stopServer(server, 2000);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(await slow).toBe("slow");
  // New requests are refused meanwhile (index.ts answers 503).
  expect(isStopping()).toBe(true);
  await closed;
});

test("a shutdown that hangs exits anyway", async () => {
  const codes: number[] = [];
  shutdownDeadline(50, (code) => codes.push(code));
  await Bun.sleep(100);
  expect(codes).toEqual([1]);
});
