import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

export interface DiarSegment {
  speaker: string;
  start: number;
  end: number;
}

interface Reply {
  id?: string;
  ready?: boolean;
  segments?: DiarSegment[];
  error?: string;
}

/**
 * Client for the FluidAudio sidecar (sidecars/diarizer): offline diarization on the Neural Engine.
 * One long-lived process; requests are serialized.
 */
export class Diarizer {
  private proc: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private ready: Promise<void> | null = null;
  private waiters = new Map<string, (r: Reply) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly bin: string) {}

  static available(bin: string): boolean {
    return Boolean(bin) && existsSync(bin);
  }

  private start(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      const proc = Bun.spawn([this.bin], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      this.proc = proc;
      let buffered = "";
      const decoder = new TextDecoder();
      void (async () => {
        for await (const chunk of proc.stdout) {
          buffered += decoder.decode(chunk, { stream: true });
          let nl = buffered.indexOf("\n");
          while (nl >= 0) {
            const line = buffered.slice(0, nl).trim();
            buffered = buffered.slice(nl + 1);
            nl = buffered.indexOf("\n");
            if (!line.startsWith("{")) continue;
            const reply = JSON.parse(line) as Reply;
            if (reply.ready === true) resolve();
            else if (reply.ready === false)
              reject(new Error(reply.error ?? "diarizer failed to start"));
            else if (reply.id) this.waiters.get(reply.id)?.(reply);
          }
        }
      })();
      void proc.exited.then((code) => {
        this.proc = null;
        this.ready = null;
        reject(new Error(`diarizer exited (${code})`));
        for (const w of this.waiters.values()) w({ error: `diarizer exited (${code})` });
        this.waiters.clear();
      });
    });
    return this.ready;
  }

  /** Diarize 16 kHz mono audio. Times in the result are seconds from the start of `samples`. */
  diarize(samples: Float32Array): Promise<DiarSegment[]> {
    const run = this.queue.then(async () => {
      await this.start();
      const id = crypto.randomUUID();
      const path = join(tmpdir(), `hearloom-diar-${id}.f32`);
      await Bun.write(path, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
      try {
        const reply = await new Promise<Reply>((resolve) => {
          this.waiters.set(id, resolve);
          this.proc!.stdin.write(`${JSON.stringify({ id, audio: path })}\n`);
          this.proc!.stdin.flush();
        });
        if (reply.error) throw new Error(reply.error);
        return reply.segments ?? [];
      } finally {
        this.waiters.delete(id);
        await unlink(path).catch(() => {});
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  stop(): void {
    this.proc?.kill();
  }
}
