import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AudioFrame } from "@hearloom/shared";
import { lostFramePacket, muxOggOpus } from "../audio/ogg";

export interface StreamMeta {
  id: string;
  userId: string;
  codec: number;
  sampleRate: number;
  frameMs: number;
}

export interface FinishedChunk {
  seqStart: number;
  seqEnd: number;
  startAt: Date;
  endAt: Date;
  frameCount: number;
  durationMs: number;
  ogg: Uint8Array;
}

/** Where finished chunks and progress go (the DB + object storage in production). */
export interface ChunkSink {
  saveChunk(meta: StreamMeta, chunk: FinishedChunk): Promise<void>;
  saveProgress(
    meta: StreamMeta,
    p: { ackedSeq: number; lastFrameAt: Date; frames: number; bytes: number },
  ): Promise<void>;
}

export interface WriterOptions {
  spoolDir: string;
  maxChunkMs: number;
  gapMs: number;
  idleMs: number;
}

interface OpenChunk {
  frames: AudioFrame[];
  seqStart: number;
  spoolPath: string;
  metaPath: string;
}

const RECORD_HEADER = 8 + 8 + 2;

/** Write a small file and fsync it. */
async function writeDurable(path: string, data: string | Uint8Array): Promise<void> {
  const fh = await open(path, "w");
  try {
    await fh.write(typeof data === "string" ? new TextEncoder().encode(data) : data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** fsync a directory so newly created/renamed entries survive power loss. */
export async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } catch {
    // Some filesystems don't support fsync on directories.
  } finally {
    await fh.close();
  }
}

function encodeRecords(frames: AudioFrame[]): Uint8Array {
  const size = frames.reduce((n, f) => n + RECORD_HEADER + f.data.length, 0);
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;
  for (const f of frames) {
    view.setBigUint64(o, BigInt(f.seq), true);
    view.setBigUint64(o + 8, BigInt(f.at), true);
    view.setUint16(o + 16, f.data.length, true);
    buf.set(f.data, o + RECORD_HEADER);
    o += RECORD_HEADER + f.data.length;
  }
  return buf;
}

export function decodeRecords(buf: Uint8Array): AudioFrame[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frames: AudioFrame[] = [];
  let o = 0;
  while (o + RECORD_HEADER <= buf.length) {
    const len = view.getUint16(o + 16, true);
    if (o + RECORD_HEADER + len > buf.length) break; // torn tail write: ignore
    frames.push({
      seq: Number(view.getBigUint64(o, true)),
      at: Number(view.getBigUint64(o + 8, true)),
      data: buf.slice(o + RECORD_HEADER, o + RECORD_HEADER + len),
    });
    o += RECORD_HEADER + len;
  }
  return frames;
}

/**
 * Turn a run of frames into a chunk: fill small timing gaps with "lost" packets so the
 * Ogg timeline matches wall-clock time, then mux.
 */
export async function buildChunk(meta: StreamMeta, frames: AudioFrame[]): Promise<FinishedChunk> {
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  const packets: Uint8Array[] = [];
  let prevAt = first.at - meta.frameMs;
  for (const f of frames) {
    const slots = Math.round((f.at - prevAt) / meta.frameMs) - 1;
    if (slots > 0) {
      const filler = lostFramePacket(f.data);
      for (let i = 0; i < slots; i++) packets.push(filler);
    }
    packets.push(f.data);
    prevAt = f.at;
  }
  const ogg = await muxOggOpus(packets, { frameMs: meta.frameMs, sampleRate: meta.sampleRate });
  return {
    seqStart: first.seq,
    seqEnd: last.seq,
    startAt: new Date(first.at),
    endAt: new Date(last.at + meta.frameMs),
    frameCount: frames.length,
    durationMs: packets.length * meta.frameMs,
    ogg,
  };
}

/**
 * Durable writer for one capture stream. Frames are appended to a spool file and fsynced
 * before they are acknowledged; chunks are muxed to Ogg when they close.
 */
/** A batch started after the next expected seq (an earlier batch never arrived). */
export class SeqGapError extends Error {
  constructor(readonly ackedSeq: number) {
    super(`expected seq ${ackedSeq + 1}`);
  }
}

export class StreamWriter {
  private chunk: OpenChunk | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastAt = 0;
  private framesSinceProgress = 0;
  private bytesSinceProgress = 0;
  /** The ack last saved with the stream's progress (it lags `ackedSeq` after a failed save). */
  private savedSeq: number;
  /**
   * Called with newly stored frames (e.g. the live transcription pipeline) and when the server
   * received them (unix ms).
   */
  onFrames?: (meta: StreamMeta, frames: AudioFrame[], receivedAt: number) => void;
  /** Called when the writer has closed its chunk and saved its progress after idling. */
  onIdle?: () => void;

  constructor(
    readonly meta: StreamMeta,
    public ackedSeq: number,
    private readonly sink: ChunkSink,
    private readonly opts: WriterOptions,
  ) {
    this.savedSeq = ackedSeq;
  }

  /**
   * Store frames received at `receivedAt` (unix ms); resolves with the new ack (highest durable
   * seq). Rejects if they (or the progress) couldn't be stored: the phone resends from its ack.
   */
  append(frames: AudioFrame[], receivedAt = Date.now()): Promise<number> {
    return this.enqueue(() => this.appendNow(frames, receivedAt));
  }

  /** Close the open chunk (stream ended, idle, or shutdown). */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      await this.closeChunk();
      await this.saveProgress();
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async appendNow(frames: AudioFrame[], receivedAt: number): Promise<number> {
    const fresh = frames.filter((f) => f.seq > this.ackedSeq);
    if (fresh.length === 0) {
      // A resend after a failed save: the frames are stored, the progress may not be yet.
      await this.saveProgress();
      return this.ackedSeq;
    }
    // Acks are cumulative: storing frames past a hole would let the phone delete the missing ones.
    if (fresh[0]!.seq !== this.ackedSeq + 1) throw new SeqGapError(this.ackedSeq);

    // Split the batch wherever a chunk boundary falls, then spool each part.
    let part: AudioFrame[] = [];
    for (const f of fresh) {
      if (this.shouldSplit(f, part)) {
        await this.spool(part);
        part = [];
        await this.closeChunk();
      }
      part.push(f);
    }
    await this.spool(part);

    // The frames are durable in the spool: from here on they count as stored (a resend is ignored),
    // so the pipeline gets them even if saving the progress fails.
    const last = fresh[fresh.length - 1]!;
    this.ackedSeq = last.seq;
    this.lastAt = last.at;
    this.framesSinceProgress += fresh.length;
    this.bytesSinceProgress += fresh.reduce((n, f) => n + f.data.length, 0);
    this.armIdle();
    this.onFrames?.(this.meta, fresh, receivedAt);
    await this.saveProgress();
    return this.ackedSeq;
  }

  /** Save the stream's progress if it changed since the last successful save. */
  private async saveProgress(): Promise<void> {
    if (this.ackedSeq === this.savedSeq && this.framesSinceProgress === 0) return;
    const ackedSeq = this.ackedSeq;
    await this.sink.saveProgress(this.meta, {
      ackedSeq,
      lastFrameAt: new Date(this.lastAt),
      frames: this.framesSinceProgress,
      bytes: this.bytesSinceProgress,
    });
    this.savedSeq = ackedSeq;
    this.framesSinceProgress = 0;
    this.bytesSinceProgress = 0;
  }

  /** Whether `f` must start a new chunk, given the open chunk plus not-yet-spooled frames. */
  private shouldSplit(f: AudioFrame, pending: AudioFrame[]): boolean {
    const stored = this.chunk?.frames ?? [];
    const prev = pending[pending.length - 1] ?? stored[stored.length - 1];
    if (!prev) return false;
    if (f.at - prev.at - this.meta.frameMs > this.opts.gapMs) return true;
    const first = stored[0] ?? pending[0]!;
    return f.at + this.meta.frameMs - first.at > this.opts.maxChunkMs;
  }

  private async spool(frames: AudioFrame[]): Promise<void> {
    if (frames.length === 0) return;
    if (!this.chunk) {
      const dir = join(this.opts.spoolDir, this.meta.id);
      await mkdir(dir, { recursive: true });
      const seqStart = frames[0]!.seq;
      const metaPath = join(dir, `${seqStart}.json`);
      const spoolPath = join(dir, `${seqStart}.spool`);
      await writeDurable(metaPath, JSON.stringify(this.meta));
      await writeDurable(spoolPath, new Uint8Array(0));
      await fsyncDir(dir);
      this.chunk = { frames: [], seqStart, spoolPath, metaPath };
    }
    const fh = await open(this.chunk.spoolPath, "a");
    try {
      await fh.write(encodeRecords(frames));
      await fh.sync();
    } finally {
      await fh.close();
    }
    this.chunk.frames.push(...frames);
  }

  private async closeChunk(): Promise<void> {
    const chunk = this.chunk;
    if (!chunk) return;
    this.chunk = null;
    if (chunk.frames.length > 0) {
      const finished = await buildChunk(this.meta, chunk.frames);
      await this.sink.saveChunk(this.meta, finished);
    }
    await rm(chunk.spoolPath, { force: true });
    await rm(chunk.metaPath, { force: true });
  }

  private armIdle(): void {
    if (this.disposed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.flush().then(
        () => {
          if (this.savedSeq === this.ackedSeq) this.onIdle?.();
        },
        (err) => {
          // Not idle yet: dropping the writer now would let the next hello resume from a stale
          // ack in the database. Try again later (a chunk that failed to close stays in the spool,
          // recovered at the next start).
          console.error(`[ingest] closing chunk of ${this.meta.id} failed`, err);
          this.armIdle();
        },
      );
    }, this.opts.idleMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** Finalize chunks left in the spool by a crash or restart. Returns max seq per stream. */
export async function recoverSpool(
  spoolDir: string,
  sink: ChunkSink,
): Promise<Map<string, number>> {
  const recovered = new Map<string, number>();
  let streams: string[];
  try {
    streams = await readdir(spoolDir);
  } catch {
    return recovered;
  }
  for (const streamId of streams) {
    const dir = join(spoolDir, streamId);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const metaFile of files) {
      const base = metaFile.slice(0, -".json".length);
      try {
        const meta = JSON.parse(await readFile(join(dir, metaFile), "utf8")) as StreamMeta;
        const frames = decodeRecords(new Uint8Array(await readFile(join(dir, `${base}.spool`))));
        if (frames.length > 0) {
          const chunk = await buildChunk(meta, frames);
          await sink.saveChunk(meta, chunk);
          const maxSeq = frames[frames.length - 1]!.seq;
          recovered.set(streamId, Math.max(recovered.get(streamId) ?? -1, maxSeq));
          await sink.saveProgress(meta, {
            ackedSeq: maxSeq,
            lastFrameAt: new Date(frames[frames.length - 1]!.at),
            frames: 0,
            bytes: 0,
          });
        }
        await rm(join(dir, `${base}.spool`), { force: true });
        await rm(join(dir, metaFile), { force: true });
      } catch (err) {
        // Don't let one bad file block startup: park it for manual inspection.
        console.error(`[ingest] could not recover spool ${streamId}/${base}`, err);
        const parked = join(spoolDir, "..", "spool-failed", streamId);
        await mkdir(parked, { recursive: true });
        for (const name of [metaFile, `${base}.spool`]) {
          await rename(join(dir, name), join(parked, name)).catch(() => {});
        }
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
  return recovered;
}
