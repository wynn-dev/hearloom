/**
 * A stand-in for the Soniox real-time WebSocket (tests): opens at once, records what's sent,
 * answers the end-of-audio message with `finished`, and lets a test play the server.
 */
export class FakeWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWs[] = [];

  readyState = FakeWs.CONNECTING;
  binaryType = "";
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeWs.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWs.OPEN;
      this.onopen?.();
    });
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (data === "")
      queueMicrotask(() => {
        this.message({ tokens: [], finished: true });
        this.close();
      });
  }

  close(): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    queueMicrotask(() => this.onclose?.());
  }

  /** The server sends a message. */
  message(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The connection drops. */
  drop(): void {
    this.readyState = FakeWs.CLOSED;
    this.onclose?.();
  }

  /** JSON control messages sent (start request, finalize, keepalive). */
  get controls(): Record<string, unknown>[] {
    return this.sent
      .filter((d): d is string => typeof d === "string" && d !== "")
      .map((d) => JSON.parse(d));
  }

  /** Milliseconds of 16 kHz PCM16 audio sent. */
  get audioMs(): number {
    return this.sent.reduce((n, d) => n + (typeof d === "string" ? 0 : d.byteLength / 32), 0);
  }

  static install(): () => void {
    const real = globalThis.WebSocket;
    FakeWs.instances = [];
    globalThis.WebSocket = FakeWs as never;
    return () => {
      globalThis.WebSocket = real;
    };
  }
}

/** Let queued microtasks and promise callbacks run. */
export const settle = () => new Promise((r) => setTimeout(r, 0));
