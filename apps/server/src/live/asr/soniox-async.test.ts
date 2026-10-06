import { afterEach, expect, test } from "bun:test";
import { SonioxError, transcribeFile } from "./soniox-async";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake Soniox API: `respond` can override any call; returns the log of calls made. */
function fakeApi(respond: (call: string, n: number) => Response | undefined = () => undefined) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call = `${init.method} ${url.replace("https://api.soniox.com/v1", "")}`;
    calls.push(call);
    const override = respond(call, calls.filter((c) => c === call).length);
    if (override) return override;
    const json = (o: unknown) => new Response(JSON.stringify(o));
    if (call === "POST /files") return json({ id: "f1" });
    if (call === "POST /transcriptions") return json({ id: "t1" });
    if (call === "GET /transcriptions/t1") return json({ status: "completed" });
    if (call === "GET /transcriptions/t1/transcript")
      return json({ tokens: [{ text: "hoi", start_ms: 0, end_ms: 300, speaker: "1" }] });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return calls;
}

const opts = { apiKey: "k", model: "stt-async-v5", languageHints: ["en", "nl"] };
const poll = { intervalMs: 1, timeoutMs: 1000 };

test("retries rate-limited calls, returns final tokens and cleans up", async () => {
  const calls = fakeApi((call, n) =>
    call === "POST /transcriptions" && n === 1
      ? new Response("slow down", { status: 429 })
      : undefined,
  );
  const tokens = await transcribeFile(new Int16Array(160), opts, poll, [1, 1]);
  expect(tokens).toEqual([{ text: "hoi", start_ms: 0, end_ms: 300, speaker: "1", is_final: true }]);
  expect(calls.filter((c) => c === "POST /transcriptions")).toHaveLength(2);
  expect(calls.slice(-2)).toEqual(["DELETE /transcriptions/t1", "DELETE /files/f1"]);
});

test("client errors aren't retried, and the uploaded file is still deleted", async () => {
  const calls = fakeApi((call) =>
    call === "POST /transcriptions" ? new Response("bad model", { status: 400 }) : undefined,
  );
  const err = await transcribeFile(new Int16Array(160), opts, poll, [1, 1]).catch((e) => e);
  expect(err).toBeInstanceOf(SonioxError);
  expect(err.retryable).toBe(false);
  expect(calls).toEqual(["POST /files", "POST /transcriptions", "DELETE /files/f1"]);
});

test("a failed transcription is not retryable; giving up on 5xx is", async () => {
  fakeApi((call) =>
    call === "GET /transcriptions/t1"
      ? new Response(JSON.stringify({ status: "error", error_message: "bad audio" }))
      : undefined,
  );
  const failed = await transcribeFile(new Int16Array(160), opts, poll, [1]).catch((e) => e);
  expect(failed.retryable).toBe(false);

  fakeApi((call) => (call === "POST /files" ? new Response("down", { status: 503 }) : undefined));
  const down = await transcribeFile(new Int16Array(160), opts, poll, [1]).catch((e) => e);
  expect(down.retryable).toBe(true);
});
