import type { SonioxToken } from "./soniox-assembler";

const API = "https://api.soniox.com/v1";
/** Waits before retrying a call that hit a rate limit, server error or network error. */
const CALL_RETRY_MS = [2_000, 10_000, 30_000, 60_000, 120_000];

/** `retryable`: worth trying the whole request again later (rate limit, outage, timeout). */
export class SonioxError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface SonioxAsyncOptions {
  apiKey: string;
  model: string;
  languageHints: string[];
  /** Names/terms that help recognition (people, places). */
  terms?: string[];
}

/** 16 kHz mono PCM16 as a WAV file. */
export function wav(pcm: Int16Array): Uint8Array {
  const data = pcm.byteLength;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 16000, true);
  v.setUint32(28, 16000 * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, data, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, data), 44);
  return out;
}

/**
 * Transcribe recorded audio with the Soniox async API: upload, create a transcription, poll until
 * it's done, fetch the tokens, then delete both (Soniox caps stored files and transcriptions).
 * Each call is retried on rate limits, server and network errors; throws `SonioxError`.
 */
export async function transcribeFile(
  pcm: Int16Array,
  opts: SonioxAsyncOptions,
  poll = { intervalMs: 2000, timeoutMs: 15 * 60_000 },
  retryMs = CALL_RETRY_MS,
): Promise<SonioxToken[]> {
  const call = async <T>(method: string, path: string, body?: FormData | object): Promise<T> => {
    const json = body !== undefined && !(body instanceof FormData);
    for (let attempt = 0; ; attempt++) {
      let failure: string;
      let wait = retryMs[attempt];
      try {
        const res = await fetch(`${API}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            ...(json ? { "Content-Type": "application/json" } : {}),
          },
          body: json ? JSON.stringify(body) : (body as FormData | undefined),
        });
        const text = await res.text();
        if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
        failure = `soniox ${method} ${path} ${res.status}: ${text.slice(0, 300)}`;
        if (res.status !== 429 && res.status < 500) throw new SonioxError(failure, false);
        const after = Number(res.headers.get("retry-after"));
        if (wait !== undefined && after > 0) wait = Math.max(wait, after * 1000);
      } catch (err) {
        if (err instanceof SonioxError || err instanceof SyntaxError) throw err;
        failure = `soniox ${method} ${path}: ${err}`;
      }
      if (wait === undefined) throw new SonioxError(failure, true);
      await Bun.sleep(wait);
    }
  };

  const form = new FormData();
  form.set("file", new Blob([wav(pcm)], { type: "audio/wav" }), "audio.wav");
  const file = await call<{ id: string }>("POST", "/files", form);
  let transcriptionId: string | null = null;
  try {
    const created = await call<{ id: string }>("POST", "/transcriptions", {
      model: opts.model,
      file_id: file.id,
      language_hints: opts.languageHints,
      enable_language_identification: true,
      enable_speaker_diarization: true,
      ...(opts.terms?.length ? { context: { terms: opts.terms.slice(0, 100) } } : {}),
    });
    transcriptionId = created.id;
    const deadline = Date.now() + poll.timeoutMs;
    for (;;) {
      const t = await call<{ status: string; error_message?: string | null }>(
        "GET",
        `/transcriptions/${created.id}`,
      );
      if (t.status === "completed") break;
      if (t.status === "error")
        throw new SonioxError(`soniox transcription failed: ${t.error_message}`, false);
      if (Date.now() > deadline) throw new SonioxError("soniox transcription timed out", true);
      await Bun.sleep(poll.intervalMs);
    }
    const { tokens } = await call<{ tokens: Omit<SonioxToken, "is_final">[] }>(
      "GET",
      `/transcriptions/${created.id}/transcript`,
    );
    return tokens.map((t) => ({ ...t, is_final: true }));
  } finally {
    if (transcriptionId) await call("DELETE", `/transcriptions/${transcriptionId}`).catch(() => {});
    await call("DELETE", `/files/${file.id}`).catch(() => {});
  }
}
