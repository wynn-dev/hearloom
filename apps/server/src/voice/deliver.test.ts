import { expect, test } from "bun:test";
import { deliverWithRetries, type PostResult } from "./deliver";

function run(results: PostResult[], spokenAgoMs = 2_000) {
  let now = 1_000_000;
  const spokenAt = now - spokenAgoMs;
  const attempts: number[] = [];
  const outcome = deliverWithRetries(
    async (attempt) => {
      attempts.push(attempt);
      return results[attempt - 1] ?? { error: "no more" };
    },
    spokenAt,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  return { outcome, attempts };
}

test("202 on the first attempt", async () => {
  const r = run([{ status: 202, body: '{"status":"accepted"}' }]);
  expect(await r.outcome).toEqual({ status: "sent", reason: null, attempts: 1, httpStatus: 202 });
});

test("retries 500 and network errors, then succeeds", async () => {
  const r = run([{ status: 500, body: "" }, { error: "ECONNREFUSED" }, { status: 202, body: "" }]);
  expect(await r.outcome).toMatchObject({ status: "sent", attempts: 3 });
});

test("a duplicate counts as delivered", async () => {
  const r = run([{ status: 200, body: '{"status":"duplicate"}' }]);
  expect((await r.outcome).status).toBe("sent");
});

test("401 fails at once; ignored route fails", async () => {
  const a = run([{ status: 401, body: "" }]);
  expect(await a.outcome).toEqual({
    status: "failed",
    reason: "http_401",
    attempts: 1,
    httpStatus: 401,
  });
  const b = run([{ status: 200, body: '{"status":"ignored"}' }]);
  expect(await b.outcome).toMatchObject({ status: "failed", reason: "route_ignored" });
});

test("gives up after 3 attempts", async () => {
  const r = run([
    { status: 503, body: "" },
    { status: 503, body: "" },
    { status: 429, body: "" },
  ]);
  expect(await r.outcome).toMatchObject({ status: "failed", reason: "http_429", attempts: 3 });
});

test("never sends a command older than 60 s; stops retrying once it is", async () => {
  const old = run([{ status: 202, body: "" }], 61_000);
  expect(await old.outcome).toMatchObject({ status: "expired", attempts: 0 });
  expect(old.attempts).toEqual([]);
  const aging = run(
    [
      { status: 500, body: "" },
      { status: 500, body: "" },
    ],
    57_000,
  );
  expect(await aging.outcome).toMatchObject({ status: "expired", attempts: 2 });
});
