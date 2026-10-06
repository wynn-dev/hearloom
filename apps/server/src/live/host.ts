import type { AudioFrame } from "@hearloom/shared";
import type { Subprocess } from "bun";
import { env } from "../env";
import type { StreamMeta } from "../ingest/stream-writer";
import { invalidate } from "../realtime";
import type { ChildMessage, HostMessage } from "./ipc";
import { resetConversationState, updateLiveState } from "./state";

type ConversationEndedHandler = (userId: string, conversationId: string) => void;

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
  private readonly onEnded = new Set<ConversationEndedHandler>();
  private pending = new Map<string, { resolve: (s: number) => void; reject: (e: Error) => void }>();

  start(): void {
    if (env.LIVE_PIPELINE === "off") {
      console.log("[live] pipeline disabled (LIVE_PIPELINE=off)");
      return;
    }
    this.spawn();
  }

  onConversationEnded(fn: ConversationEndedHandler): void {
    this.onEnded.add(fn);
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
    if (!this.child || !this.ready)
      return Promise.reject(new Error("live pipeline is not running"));
    const requestId = crypto.randomUUID();
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("enrollment timed out"));
      }, 60_000);
      this.pending.set(requestId, {
        resolve: (s) => {
          clearTimeout(timer);
          resolve(s);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ t: "enroll", requestId, userId, personId, utteranceId });
    });
  }

  voiceprintsChanged(userId: string): void {
    this.send({ t: "voiceprints_changed", userId });
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
        resetConversationState();
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
      case "state":
        updateLiveState(msg.userId, msg.patch);
        return;
      case "enrolled": {
        const p = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        if (p) msg.ok ? p.resolve(msg.sampleSeconds) : p.reject(new Error(msg.error));
        return;
      }
      case "conversation_ended":
        for (const fn of this.onEnded) fn(msg.userId, msg.conversationId);
        invalidate(msg.userId, ["timeline"]);
        return;
    }
  }
}

export const livePipeline = new LivePipelineHost();
