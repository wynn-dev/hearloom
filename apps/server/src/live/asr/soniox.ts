import { SessionClock, SonioxAssembler, type SonioxToken } from "./soniox-assembler";
import type { PartialUtterance, Utterance } from "./types";

const URL = "wss://stt-rt.soniox.com/transcribe-websocket";
/**
 * Soniox may close a session after 20 s without audio or a keepalive message: send one after this
 * much quiet (checked every `KEEPALIVE_CHECK_MS`, so gaps stay under ~6 s).
 */
export const KEEPALIVE_IDLE_MS = 5_000;
const KEEPALIVE_CHECK_MS = 1_000;

export interface SonioxOptions {
  apiKey: string;
  model: string;
  languageHints: string[];
  /**
   * Names/terms that help recognition (people, places). The session starts once they're known
   * (audio sent meanwhile waits): they can only be given when it starts.
   */
  terms?: string[] | Promise<string[]>;
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
  /** The start request was sent (keepalives before it aren't part of the protocol). */
  private started = false;
  /** Session time up to which the recognizer's results are final. */
  private finalMs = 0;
  /** The next `<fin>` ends an utterance cut short by a stall. */
  private cutOnFin = false;
  private closing: Promise<void> | null = null;
  private resolveFinished: (() => void) | null = null;
  readonly openedAt = Date.now();
  closed = false;
  /** The session broke (connection, auth, quota…): see `untranscribed()` for what it missed. */
  failed = false;
  /** Soniox confirmed it processed all audio we sent. */
  finished = false;
  /** Soniox answered at least once (the connection works). */
  responded = false;

  constructor(
    opts: SonioxOptions,
    private readonly onUtterance: (u: Utterance) => void,
    private readonly onError: (message: string) => void,
    /** The utterance in progress, after every response that changes it (voice commands). */
    private readonly onPartial?: (p: PartialUtterance) => void,
    /** The first response arrived: the session works. */
    private readonly onResponse?: () => void,
  ) {
    // Speaker labels restart at 1 in every session: make them unique.
    const speakerPrefix = `soniox:${crypto.randomUUID().slice(0, 8)}:`;
    this.assembler = new SonioxAssembler(this.clock, opts.model, undefined, speakerPrefix);
    this.ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${opts.apiKey}` } } as never);
    this.ws.binaryType = "arraybuffer";
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = async () => {
        const terms = await Promise.resolve(opts.terms).catch(() => undefined);
        if (this.ws.readyState !== WebSocket.OPEN) {
          reject(new Error("soniox connection closed before it started"));
          return;
        }
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
            ...(terms?.length ? { context: { terms: terms.slice(0, 100) } } : {}),
          }),
        );
        this.started = true;
        this.lastSendAt = Date.now();
        resolve();
      };
      this.ws.onerror = () => reject(new Error("soniox connection failed"));
    });
    this.ready.catch((e) => this.fail(String(e)));
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    this.ws.onclose = () => {
      this.closed = true;
      clearInterval(this.keepalive);
      if (!this.closing && !this.finished) this.fail("soniox connection closed unexpectedly");
      else this.flush(!this.finished);
      this.resolveFinished?.();
    };
    this.keepalive = setInterval(() => {
      if (
        this.started &&
        !this.closed &&
        Date.now() - this.lastSendAt >= KEEPALIVE_IDLE_MS &&
        this.ws.readyState === WebSocket.OPEN
      ) {
        this.ws.send(JSON.stringify({ type: "keepalive" }));
        this.lastSendAt = Date.now();
      }
    }, KEEPALIVE_CHECK_MS);
  }

  get sentMs(): number {
    return this.clock.totalSentMs;
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

  /**
   * Wall-clock spans of the audio sent that the recognizer hasn't finalized (all of it was lost if
   * the session broke).
   */
  untranscribed(): { from: number; to: number }[] {
    return this.clock.spansFrom(this.finalMs);
  }

  /**
   * Ask Soniox to finalize pending tokens now (e.g. the mic went to sleep). `cutOff`: the audio
   * stopped mid-speech, so the utterance this ends is marked as cut short.
   */
  finalize(cutOff = false): void {
    if (cutOff) this.cutOnFin = true;
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
      /** How much of the audio the recognizer has processed. */
      total_audio_proc_ms?: number;
      /** How much of it has final results. */
      final_audio_proc_ms?: number;
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
    if (!this.responded) {
      this.responded = true;
      this.onResponse?.();
    }
    if (msg.final_audio_proc_ms) this.finalMs = Math.max(this.finalMs, msg.final_audio_proc_ms);
    if (msg.tokens) {
      let fin = false;
      for (const t of msg.tokens) {
        if (!t.is_final) continue;
        if (t.text === "<fin>") fin = true;
        if (t.end_ms !== undefined) this.finalMs = Math.max(this.finalMs, t.end_ms);
      }
      for (const u of this.assembler.push(msg.tokens, this.cutOnFin)) this.onUtterance(u);
      if (fin) this.cutOnFin = false;
      // Also without new tokens: more audio after the last word can settle it as the name.
      if (this.onPartial) {
        const p = this.assembler.partial(msg.tokens, msg.total_audio_proc_ms);
        if (p) this.onPartial(p);
      }
    }
    if (msg.finished) {
      this.finished = true;
      this.finalMs = this.clock.totalSentMs;
      this.flush(false);
      this.resolveFinished?.();
    }
  }

  /** Emit the words already final; `cutOff`: the session ended before their utterance did. */
  private flush(cutOff: boolean): void {
    const u = this.assembler.flush(cutOff);
    if (u) this.onUtterance(u);
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.closed = true;
    clearInterval(this.keepalive);
    // What was already final is kept, but its utterance broke off.
    this.flush(true);
    this.onError(message);
    try {
      this.ws.close();
    } catch {}
  }
}
