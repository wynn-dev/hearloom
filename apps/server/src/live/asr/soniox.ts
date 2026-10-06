import { SessionClock, SonioxAssembler, type SonioxToken } from "./soniox-assembler";
import type { Utterance } from "./types";

const URL = "wss://stt-rt.soniox.com/transcribe-websocket";

export interface SonioxOptions {
  apiKey: string;
  model: string;
  languageHints: string[];
  /** Names/terms that help recognition (people, places). */
  terms?: string[];
}

/**
 * One Soniox real-time session. We stream 16 kHz PCM only while there's speech (plus pre-roll), so
 * we pay for speech, not silence; `SessionClock` maps Soniox times back to wall clock.
 */
export class SonioxSession {
  private ws: WebSocket;
  private readonly clock = new SessionClock();
  private readonly assembler: SonioxAssembler;
  private ready: Promise<void>;
  private keepalive: ReturnType<typeof setInterval>;
  private lastSendAt = Date.now();
  private closing: Promise<void> | null = null;
  private resolveFinished: (() => void) | null = null;
  readonly openedAt = Date.now();
  closed = false;
  /** The session broke (connection, auth, quota…); what it didn't transcribe needs another engine. */
  failed = false;
  /** Soniox confirmed it processed all audio we sent. */
  finished = false;

  constructor(
    opts: SonioxOptions,
    private readonly onUtterance: (u: Utterance) => void,
    private readonly onError: (message: string) => void,
  ) {
    // Speaker labels restart at 1 in every session: make them unique.
    const speakerPrefix = `soniox:${crypto.randomUUID().slice(0, 8)}:`;
    this.assembler = new SonioxAssembler(this.clock, opts.model, undefined, speakerPrefix);
    this.ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${opts.apiKey}` } } as never);
    this.ws.binaryType = "arraybuffer";
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => {
        this.ws.send(
          JSON.stringify({
            model: opts.model,
            audio_format: "pcm_s16le",
            sample_rate: 16000,
            num_channels: 1,
            language_hints: opts.languageHints,
            enable_language_identification: true,
            enable_speaker_diarization: true,
            enable_endpoint_detection: true,
            max_endpoint_delay_ms: 1500,
            ...(opts.terms?.length ? { context: { terms: opts.terms.slice(0, 100) } } : {}),
          }),
        );
        resolve();
      };
      this.ws.onerror = () => reject(new Error("soniox connection failed"));
    });
    this.ready.catch((e) => this.fail(String(e)));
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    this.ws.onclose = () => {
      this.closed = true;
      clearInterval(this.keepalive);
      const u = this.assembler.flush();
      if (u) this.onUtterance(u);
      if (!this.closing && !this.finished) this.fail("soniox connection closed unexpectedly");
      this.resolveFinished?.();
    };
    // Soniox requires traffic at least every 40 s.
    this.keepalive = setInterval(() => {
      if (
        !this.closed &&
        Date.now() - this.lastSendAt > 15_000 &&
        this.ws.readyState === WebSocket.OPEN
      ) {
        this.ws.send(JSON.stringify({ type: "keepalive" }));
      }
    }, 5000);
  }

  get sentMs(): number {
    return this.clock.totalSentMs;
  }

  /** Whether audio for this wall-clock span was streamed to the session. */
  covers(fromAbs: number, toAbs: number): boolean {
    return this.clock.covers(fromAbs, toAbs);
  }

  /** Stream PCM captured at wall-clock `absMs`. */
  send(pcm: Int16Array, absMs: number): void {
    if (this.closed || this.closing) return;
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice();
    this.clock.sent(absMs, pcm.length / 16);
    this.lastSendAt = Date.now();
    this.ready.then(
      () => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
      },
      () => {}, // reported once by fail()
    );
  }

  /** Ask Soniox to finalize pending tokens now (e.g. the mic went to sleep). */
  finalize(): void {
    this.ready.then(
      () => {
        if (this.ws.readyState === WebSocket.OPEN)
          this.ws.send(JSON.stringify({ type: "finalize" }));
      },
      () => {},
    );
  }

  /** End the stream and wait (briefly) for the last tokens. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        await this.ready;
        if (this.closed || this.finished) return;
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send("");
        await Promise.race([
          new Promise<void>((r) => {
            this.resolveFinished = r;
          }),
          Bun.sleep(5000),
        ]);
      } catch {
        // already failed
      } finally {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
        clearInterval(this.keepalive);
      }
    })();
    return this.closing;
  }

  private onMessage(text: string): void {
    let msg: {
      tokens?: SonioxToken[];
      finished?: boolean;
      error_code?: number;
      error_message?: string;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.error_code) {
      this.fail(`soniox ${msg.error_code}: ${msg.error_message ?? ""}`);
      return;
    }
    if (msg.tokens?.length) for (const u of this.assembler.push(msg.tokens)) this.onUtterance(u);
    if (msg.finished) {
      this.finished = true;
      const u = this.assembler.flush();
      if (u) this.onUtterance(u);
      this.resolveFinished?.();
    }
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.closed = true;
    clearInterval(this.keepalive);
    this.onError(message);
    try {
      this.ws.close();
    } catch {}
  }
}
