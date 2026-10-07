import type { AudioFrame } from "@hearloom/shared";
import type { Subprocess } from "bun";
import { env } from "../env";
import type { StreamMeta } from "../ingest/stream-writer";
import { invalidate } from "../realtime";
import type { ChildMessage, HostMessage } from "./ipc";
import { resetActivity, setActivity } from "./state";
import type { TeachPrompt, TeachResult, VoiceDetection } from "./voice/types";

type BlockClosedHandler = (userId: string, blockId: string) => void;
type VoiceCommandHandler = (detection: VoiceDetection) => void;
type TeachHeardHandler = (userId: string, result: TeachResult) => void;

/**
 * Supervises the live pipeline child process: forwards stored frames, applies state updates,
 * restarts it with backoff if it dies. If the child is down, ingest keeps working (audio is
 * stored), but audio that arrives meanwhile is not transcribed.
 */
export class LivePipelineHost {
  private child: Subprocess | null = null;
  private ready = false;
  private backoffMs = 1000;
  private stopped = false;
  private readonly onBlock = new Set<BlockClosedHandler>();
  private readonly onVoice = new Set<VoiceCommandHandler>();
  private readonly onTeach = new Set<TeachHeardHandler>();
  private pending = new Map<
    string,
    { resolve: (value: never) => void; reject: (e: Error) => void }
  >();

  start(): void {
    if (env.LIVE_PIPELINE === "off") {
      console.log("[live] pipeline disabled (LIVE_PIPELINE=off)");
      return;
    }
    this.spawn();
  }

  /** A block of speech is complete (refine it). */
  onBlockClosed(fn: BlockClosedHandler): void {
    this.onBlock.add(fn);
  }

  /** A wake phrase was heard (deliverable, shadow, or ignored with a reason). */
  onVoiceCommand(fn: VoiceCommandHandler): void {
    this.onVoice.add(fn);
  }

  /** The user said something while teaching their voice. */
  onTeachHeard(fn: TeachHeardHandler): void {
    this.onTeach.add(fn);
  }

  push(meta: StreamMeta, frames: AudioFrame[]): void {
    if (!this.child || !this.ready) return;
    this.send({
      t: "frames",
      stream: {
        id: meta.id,
        userId: meta.userId,
        codec: meta.codec,
        sampleRate: meta.sampleRate,
        frameMs: meta.frameMs,
      },
      frames,
    });
  }

  /** Ask the pipeline (which holds the speaker model) to learn a voiceprint from an utterance. */
  enroll(userId: string, personId: string, utteranceId: string): Promise<number> {
    return this.request<number>((requestId) => ({
      t: "enroll",
      requestId,
      userId,
      personId,
      utteranceId,
    }));
  }

  /** Learn the user's own voice from stored audio (a confirmed voice command). */
  learnVoice(
    userId: string,
    personId: string,
    streamId: string,
    from: number,
    to: number,
  ): Promise<{ voiceprintId: string; seconds: number }> {
    return this.request((requestId) => ({
      t: "learn_voice",
      requestId,
      userId,
      personId,
      streamId,
      from,
      to,
    }));
  }

  /** What the user is asked to say on the Voice page (null: not teaching). */
  teach(userId: string, prompt: TeachPrompt | null): void {
    this.send({ t: "teach", userId, prompt });
  }

  /** A teaching sample recorded in the browser. */
  teachAudio(userId: string, prompt: TeachPrompt, pcm: Int16Array): boolean {
    if (!this.child || !this.ready) return false;
    this.send({ t: "teach_audio", userId, prompt, pcm });
    return true;
  }

  /** Voice settings or samples changed. */
  voiceChanged(userId: string): void {
    this.send({ t: "voice_changed", userId });
  }

  get running(): boolean {
    return this.child !== null && this.ready;
  }

  private request<T>(make: (requestId: string) => HostMessage): Promise<T> {
    if (!this.child || !this.ready)
      return Promise.reject(new Error("live pipeline is not running"));
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("the live pipeline did not answer in time"));
      }, 60_000);
      this.pending.set(requestId, {
        resolve: (value: T) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      } as never);
      this.send(make(requestId));
    });
  }

  voiceprintsChanged(userId: string): void {
    this.send({ t: "voiceprints_changed", userId });
  }

  /** Episodes were edited (the open one may have a new kind). */
  episodesChanged(userId: string): void {
    this.send({ t: "episodes_changed", userId });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.child) {
      this.child.kill("SIGTERM");
      await Promise.race([this.child.exited, Bun.sleep(5000)]);
    }
  }

  private send(msg: HostMessage): void {
    try {
      this.child?.send(msg);
    } catch (err) {
      console.error("[live] send failed", err);
    }
  }

  private spawn(): void {
    const started = Date.now();
    this.ready = false;
    this.child = Bun.spawn(["bun", new URL("./child.ts", import.meta.url).pathname], {
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
      serialization: "advanced",
      ipc: (message) => this.onMessage(message as ChildMessage),
      onExit: (_proc, code) => {
        this.child = null;
        this.ready = false;
        resetActivity();
        for (const p of this.pending.values()) p.reject(new Error("live pipeline restarted"));
        this.pending.clear();
        if (this.stopped) return;
        if (code === 2) {
          console.error("[live] pipeline not started (see above); audio is still recorded");
          return;
        }
        if (Date.now() - started > 60_000) this.backoffMs = 1000;
        console.error(`[live] pipeline exited (${code}); restarting in ${this.backoffMs} ms`);
        setTimeout(() => this.spawn(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      },
    });
  }

  private onMessage(msg: ChildMessage): void {
    switch (msg.t) {
      case "ready":
        this.ready = true;
        return;
      case "log":
        console.log(`[live] ${msg.message}`);
        return;
      case "invalidate":
        invalidate(msg.userId, msg.keys);
        return;
      case "activity":
        setActivity(msg.userId, msg.activity);
        return;
      case "enrolled": {
        const p = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        if (p) msg.ok ? p.resolve(msg.sampleSeconds as never) : p.reject(new Error(msg.error));
        return;
      }
      case "learned": {
        const p = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        if (!p) return;
        if (msg.ok) p.resolve({ voiceprintId: msg.voiceprintId, seconds: msg.seconds } as never);
        else p.reject(new Error(msg.error));
        return;
      }
      case "voice_command":
        for (const fn of this.onVoice) fn(msg.detection);
        return;
      case "teach_heard":
        for (const fn of this.onTeach) fn(msg.userId, msg.result);
        return;
      case "block_closed":
        for (const fn of this.onBlock) fn(msg.userId, msg.blockId);
        return;
    }
  }
}

export const livePipeline = new LivePipelineHost();
