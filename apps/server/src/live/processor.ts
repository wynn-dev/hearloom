import { OpusDecoder } from "@hearloom/audio";
import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import {
  rms,
  type SoundTagger,
  type SpeakerEmbedder,
  type SpeechSegment,
  toFloat32,
  VadSession,
} from "@hearloom/inference";
import type { AudioFrame } from "@hearloom/shared";
import { eq, sql } from "drizzle-orm";
import { type ContextMinute, ContextMinutes, contextScores } from "../episodes/rules";
import { SonioxSession } from "./asr/soniox";
import { SessionClock, SonioxAssembler, type SonioxToken } from "./asr/soniox-assembler";
import { SonioxError, transcribeFile } from "./asr/soniox-async";
import type { Utterance } from "./asr/types";
import type { BlockTracker } from "./blocks";
import type { EpisodeTracker } from "./episodes";
import { Freshness } from "./freshness";
import { PcmHistory } from "./pcm";
import { type SoundEvent, SoundEventSmoother } from "./sounds";
import type { SpeakerDirectory } from "./speakers";
import type { AudioSource, VoiceDetector } from "./voice/detector";

export interface StreamInfo {
  id: string;
  userId: string;
  codec: number;
  sampleRate: number;
  frameMs: number;
}

export interface LiveDeps {
  db: Db;
  modelsDir: string;
  tagger: SoundTagger | null;
  embedder: SpeakerEmbedder | null;
  speakers: SpeakerDirectory | null;
  blocks: BlockTracker;
  episodes: EpisodeTracker;
  /** null = no transcription. */
  soniox: { apiKey: string; model: string; asyncModel: string; languageHints: string[] } | null;
  /** "Hey <agent>" voice commands and voice teaching (null = off). */
  voice: VoiceDetector | null;
  /** Words to bias recognition toward for this user (the agent's name). */
  terms(userId: string): Promise<string[]>;
  /** The user's own-voice bar for voice commands (transcript lines use it for them too). */
  ownerBar?(userId: string): Promise<number>;
  /** Ask the server to refresh clients' views for this user. */
  invalidate(userId: string, keys: Array<"timeline" | "status">): void;
  /** A stream's live transcription is down (`ok` false, with why) or works again. */
  asrHealth?(userId: string, streamId: string, ok: boolean, message: string | null): void;
  /** Speech detection for a run of audio starting at `startAt` (default: Silero; tests fake it). */
  vad?(startAt: number): Vad;
  log(message: string): void;
}

/** Streaming speech detection (VadSession). */
export interface Vad {
  accept(samples: Float32Array): { segments: SpeechSegment[]; speaking: boolean };
  flush(): SpeechSegment[];
}

/** Close the Soniox session after this much time without speech (we pay per streamed second). */
const SONIOX_IDLE_MS = 45_000;
/** Rotate Soniox sessions well before their 300-minute cap. */
const SONIOX_MAX_SESSION_MS = 4 * 3600_000;
const PRE_ROLL_MS = 500;
/**
 * After a Soniox session fails, wait this long before opening another, by the number of failures
 * in a row (the last repeats). Speech meanwhile, and what the failed session hadn't transcribed,
 * goes to Soniox async.
 */
export const SONIOX_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
/**
 * When frames stop while the user is speaking (an upload or Bluetooth stall), wait this long for
 * them to resume before taking what was said so far as all there is (and cut off).
 */
export const STALL_CAP_MS = 10_000;
/** A live session that lasted this long worked: the retry backoff starts over. */
const SONIOX_HEALTHY_MS = 30_000;
/** After a Soniox async failure, it counts as down this long: live speech isn't rescued into it. */
const ASYNC_DOWN_MS = 120_000;
/** Speaker labels are mapped onto voices across sessions only from this much audio. */
const MIN_LABEL_SAMPLES = 32_000; // 2 s
/** Backlog speech sent to Soniox async per request. */
const BACKLOG_BATCH_SAMPLES = 5 * 60 * 16_000;
/** Speech waiting for Soniox async beyond this is dropped, oldest first (async failing, far behind). */
const BACKLOG_QUEUE_MAX_SAMPLES = 2 * BACKLOG_BATCH_SAMPLES;
/** Send a partial backlog batch after no new backlog speech for this long (upload paused or done). */
const BACKLOG_IDLE_MS = 10_000;
/** Silence between stitched backlog segments (at most their real gap), so words don't run together. */
const BACKLOG_GAP_MS = 300;
/** Retries of a whole backlog batch after a retryable failure (each API call also retries). */
const BACKLOG_RETRY_MS = [30_000, 120_000];
/** How long dispose() waits for backlog still being transcribed. */
const DISPOSE_WAIT_MS = 3_000;
/** Gaps up to this are lost packets (concealed); longer gaps are mic sleep (silence). */
const RUN_GAP_MS = 2000;
const TAG_WINDOW_SAMPLES = 32_000; // 2 s
const TAG_HOP_SAMPLES = 16_000; // 1 s
const TAG_MIN_RMS = 0.003;
const MIN_EMBED_SAMPLES = 16_000; // 1 s

/** Let other work (the live stream's frames) run before more backlog work. */
const yieldToLive = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Segment {
  startAt: number;
  endAt: number;
  samples: Float32Array;
}

/**
 * Backlog speech waiting to be transcribed in one Soniox async request. While it exists, the user's
 * backlog blocks are held open (BlockTracker.hold).
 */
interface BacklogBatch {
  segments: Segment[];
  samples: number;
  /** When the latest segment was added (processing time). */
  addedAt: number;
}

/** Audio for [from, to] from the segments that overlap it. */
function sliceSegments(segments: Segment[], from: number, to: number): Float32Array {
  const parts: Float32Array[] = [];
  for (const s of segments) {
    if (s.endAt <= from || s.startAt >= to) continue;
    const a = Math.max(0, Math.floor((from - s.startAt) * 16));
    const b = Math.min(s.samples.length, Math.ceil((to - s.startAt) * 16));
    if (b > a) parts.push(s.samples.subarray(a, b));
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function toPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++)
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768)));
  return pcm;
}

/**
 * Turns one capture stream's Opus frames into timeline rows: utterances (with speakers and
 * blocks) and sound events. All times are absolute (unix ms).
 */
export class StreamProcessor {
  private decoder: OpusDecoder;
  private vad: Vad | null = null;
  private readonly history = new PcmHistory();
  private readonly smoother = new SoundEventSmoother();
  /** Absolute time of sample 0 of the current VAD run. */
  private runStartAt = 0;
  private runSamples = 0;
  private lastFrameAt: number | null = null;
  lastActivity = Date.now();
  /** When frames last arrived (wall clock; processing may lag behind). */
  private framesArrivedAt = Date.now();
  // Sound tagging buffer for the current run.
  private tagBuf = new Float32Array(TAG_WINDOW_SAMPLES);
  private tagFill = 0;
  private tagSinceHop = 0;
  private openSoundRows = new Map<string, string>();
  /** Speech-context scores per minute, for classifying episodes. */
  private readonly context = new ContextMinutes();
  // Transcription: Soniox real-time for fresh audio, Soniox async for backlog.
  private live: SonioxSession | null = null;
  private sonioxRetryAt = 0;
  /** Soniox sessions that failed in a row. */
  private sonioxFailures = 0;
  /** Live transcription is reported down (ASR health). */
  private asrDown = false;
  private lastAsrError: string | null = null;
  /** End of the audio routed to Soniox async (backlog, or rescued from the live path). */
  private asyncUntil = 0;
  /** End of the audio sent to a live session. */
  private liveUntil = 0;
  /** Commands that started before this audio time were cut off (the recognizer broke off). */
  private voiceCutBefore = 0;
  /** Soniox async failed recently (see ASYNC_DOWN_MS). */
  private asyncDownUntil = 0;
  /** Lost live speech was logged (once per async outage). */
  private lostLogged = false;
  /** The voice activity detector was in speech at the end of the latest fresh audio. */
  private speakingAtEnd = false;
  /** The run ended mid-speech (frames stopped): finalizing Soniox waits for them to resume. */
  private stallFinalize = false;
  private lastSpeechAt = 0;
  /** Audio time of the end of the latest speech (voice commands wait while the user talks on). */
  private lastSpeechAudioAt = 0;
  /** Audio time of the end of the audio processed so far. */
  private heardUntil = 0;
  private readonly voiceSource: AudioSource;
  private readonly freshness = new Freshness();
  /** Whether the audio being processed is live (see Freshness). */
  private fresh = true;
  /** An utterance runs on at the end of the audio processed so far (see Freshness). */
  private midUtterance = false;
  /** Wall-clock spans of audio that arrived too late to stream (merged, recent only). */
  private backlogSpans: { from: number; to: number }[] = [];
  private backlog: BacklogBatch | null = null;
  /** Batches waiting for Soniox async, oldest first (one more is in flight). */
  private backlogPending: BacklogBatch[] = [];
  private backlogPendingSamples = 0;
  /** Works through `backlogPending`, outside `queue`: the live pipeline never waits on it. */
  private backlogQueue: Promise<void> = Promise.resolve();
  private backlogPumping = false;
  private backlogInFlightSamples = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly stream: StreamInfo,
    private readonly deps: LiveDeps,
  ) {
    this.decoder = new OpusDecoder(16000, 1, (16000 * stream.frameMs) / 1000);
    this.voiceSource = {
      streamId: stream.id,
      audio: (from, to) => this.history.slice(from, to),
      lastSpeechAt: () => this.lastSpeechAudioAt,
      heardUntil: () => {
        const stall = this.stall();
        // Frames stopped mid-speech: not quiet, the rest may still come.
        if (stall === "waiting") return this.heardUntil;
        // No more audio coming (mic asleep, connection gone): quiet from here on.
        return stall === "cut" ||
          this.lastFrameAt === null ||
          Date.now() - this.framesArrivedAt > RUN_GAP_MS
          ? Number.POSITIVE_INFINITY
          : this.heardUntil;
      },
      stall: () => this.stall(),
      cutBefore: () => this.voiceCutBefore,
    };
  }

  /**
   * Process frames in order (calls are serialized). `receivedAt`: when the server received them
   * (unix ms), which decides whether they are live or backlog.
   */
  push(frames: AudioFrame[], receivedAt = Date.now()): Promise<void> {
    this.framesArrivedAt = Date.now();
    this.queue = this.queue
      .then(() => this.process(frames, receivedAt))
      .catch((err) => this.deps.log(`process: ${err}`));
    return this.queue;
  }

  /**
   * Frames stopped arriving while the user was speaking: "waiting" for them (up to
   * `STALL_CAP_MS`), then "cut" (what was being said is cut off) until audio comes again.
   */
  private stall(now = Date.now()): "waiting" | "cut" | null {
    if (!this.speakingAtEnd) return null;
    const idle = now - this.framesArrivedAt;
    if (idle <= RUN_GAP_MS) return null;
    return idle <= STALL_CAP_MS ? "waiting" : "cut";
  }

  /**
   * Called periodically: closes the current run after silence and idle Soniox sessions, and sends
   * the backlog batch once its upload goes quiet.
   */
  tick(now = Date.now()): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (this.lastFrameAt !== null && now - this.lastActivity > RUN_GAP_MS + 1000)
          await this.endRun(this.speakingAtEnd ? "stall" : "end");
        if (this.stallFinalize && this.stall(now) === "cut") {
          // The audio didn't come back: what the recognizer has is all there is, cut short.
          this.stallFinalize = false;
          this.live?.finalize(true);
        }
        this.checkHealthy(now);
        if (this.live && (now - this.lastSpeechAt > SONIOX_IDLE_MS || this.live.closed))
          await this.closeSoniox();
        if (this.backlog && now - this.backlog.addedAt > BACKLOG_IDLE_MS) this.sendBacklog();
      })
      .catch((err) => this.deps.log(`tick: ${err}`));
    return this.queue;
  }

  async dispose(): Promise<void> {
    await this.queue;
    await this.endRun("end");
    await this.closeSoniox();
    await this.queue; // the closed session's last utterances
    // The stream is gone: it isn't down anymore.
    this.setAsrHealth(true, null);
    const pending =
      (this.backlog?.samples ?? 0) + this.backlogPendingSamples + this.backlogInFlightSamples;
    this.sendBacklog();
    const done = await Promise.race([
      this.backlogQueue.then(() => true),
      Bun.sleep(DISPOSE_WAIT_MS).then(() => false),
    ]);
    if (!done)
      this.deps.log(
        `soniox backlog: ${Math.round(pending / 16_000)} s of speech still being transcribed (lost if the process exits)`,
      );
    this.decoder.destroy();
  }

  // ---- decoding & runs --------------------------------------------------------------------

  private async process(frames: AudioFrame[], receivedAt: number): Promise<void> {
    this.lastActivity = Date.now();
    const pcmParts: Int16Array[] = [];
    const flushParts = async () => {
      if (pcmParts.length === 0) return;
      const total = pcmParts.reduce((n, p) => n + p.length, 0);
      const pcm = new Int16Array(total);
      let o = 0;
      for (const p of pcmParts) {
        pcm.set(p, o);
        o += p.length;
      }
      pcmParts.length = 0;
      await this.feed(pcm, receivedAt);
    };

    for (const f of frames) {
      if (this.lastFrameAt === null || f.at - this.lastFrameAt - this.stream.frameMs > RUN_GAP_MS) {
        await flushParts();
        // Audio missing mid-speech: what was being said is cut off.
        if (this.lastFrameAt !== null) await this.endRun(this.speakingAtEnd ? "cut" : "end");
        else if (this.stallFinalize && f.at - this.heardUntil > RUN_GAP_MS)
          this.live?.finalize(true);
        // (Resuming where a stall stopped: the recognizer carries on with the words.)
        this.stallFinalize = false;
        this.startRun(f.at);
      } else {
        // Conceal lost frames so audio stays aligned with wall-clock time.
        const missing = Math.round((f.at - this.lastFrameAt) / this.stream.frameMs) - 1;
        const cap = Math.ceil(RUN_GAP_MS / this.stream.frameMs) + 1;
        for (let i = 0; i < Math.min(missing, cap); i++) pcmParts.push(this.decoder.conceal());
      }
      pcmParts.push(this.decodeFrame(f.data));
      this.lastFrameAt = f.at;
    }
    await flushParts();
  }

  /** One frame of PCM; a corrupt packet is concealed so later times in the run stay right. */
  private decodeFrame(data: Uint8Array): Int16Array {
    if (data.length > 1) {
      try {
        return this.decoder.decode(data);
      } catch (err) {
        this.deps.log(`opus decode: ${err}`);
      }
    }
    return this.decoder.conceal();
  }

  private startRun(at: number): void {
    this.vad = this.deps.vad?.(at) ?? new VadSession(this.deps.modelsDir);
    this.backlogSpans = []; // the previous run's segments were flushed in endRun
    this.runStartAt = at;
    this.runSamples = 0;
    this.freshness.reset();
    this.midUtterance = false;
    this.tagFill = 0;
    this.tagSinceHop = 0;
  }

  /**
   * Mic went to sleep (or stream paused): finish speech segments and sound events. `how`: "stall"
   * (frames stopped mid-speech: they may resume), "cut" (audio is missing mid-speech).
   */
  private async endRun(how: "end" | "stall" | "cut"): Promise<void> {
    if (this.vad) {
      for (const seg of this.vad.flush()) await this.onSegment(seg);
      this.vad = null;
    }
    for (const ev of this.smoother.flush()) await this.saveSound(ev, true);
    await this.saveContext(this.context.drain());
    if (how === "stall") this.stallFinalize = true;
    else this.live?.finalize(how === "cut");
    this.lastFrameAt = null;
  }

  // ---- per-run processing ------------------------------------------------------------------

  private async feed(pcm: Int16Array, receivedAt: number): Promise<void> {
    const samples = toFloat32(pcm);
    const absAt = this.runStartAt + this.runSamples / 16;
    this.runSamples += samples.length;
    this.history.push(absAt, samples);
    // From when the server received the audio, not when we get to it: a busy pipeline must not
    // turn live speech into backlog (unless it's minutes behind).
    const fresh = this.freshness.judge({
      lagMs: receivedAt - absAt,
      ageMs: Date.now() - absAt,
      at: absAt,
      midUtterance: this.midUtterance,
    });
    this.fresh = fresh;
    if (!fresh) {
      // Backlog (an old stream uploading) must not hold up the live stream's audio.
      await yieldToLive();
      if (this.deps.soniox) this.markBacklog(absAt, absAt + samples.length / 16);
    }

    // Speech detection.
    const { segments, speaking } = this.vad!.accept(samples);
    // A segment that just ended is a boundary even if speech goes on (TV, music, a monologue).
    this.midUtterance = speaking && segments.length === 0;
    this.heardUntil = absAt + samples.length / 16;
    this.speakingAtEnd = fresh && speaking;
    if (speaking) {
      this.lastSpeechAt = Date.now();
      this.lastSpeechAudioAt = absAt + samples.length / 16;
    } else if (segments.length > 0) {
      // Speech just stopped: the segment says exactly where. (`speaking` stays on for the VAD's
      // minimum silence, 0.6 s, so the time above runs past the end of the words: a finished
      // voice command would look continued and wait for the assembler's timeout.)
      const last = segments.at(-1)!;
      this.lastSpeechAudioAt = this.runStartAt + (last.start + last.samples.length) / 16;
    }
    if (fresh && this.deps.soniox) await this.transcribeLive(pcm, absAt, speaking, segments);
    for (const seg of segments) await this.onSegment(seg);
    if (!fresh) await this.backlogBackpressure();

    // Sound tagging: 2 s windows every 1 s.
    if (this.deps.tagger) await this.tag(samples, fresh);
  }

  /**
   * Stream fresh audio to Soniox real-time while there's speech. Speech no session can take (one
   * just failed) goes to Soniox async instead.
   */
  private async transcribeLive(
    pcm: Int16Array,
    absAt: number,
    speaking: boolean,
    segments: SpeechSegment[],
  ): Promise<void> {
    const endAt = absAt + pcm.length / 16;
    // It broke: don't feed it (and rescue what it hadn't transcribed).
    if (this.live?.closed) await this.closeSoniox();
    this.checkHealthy(Date.now());
    // Speech still going, or that started and ended within this batch (a catch-up batch can hold a
    // whole "Hey Adri." followed by enough quiet to end it): from its (padded) start, but not what
    // was already transcribed or sent.
    if ((speaking || segments.length > 0) && !this.live) {
      const first = segments[0];
      const start = first ? Math.min(absAt, this.runStartAt + first.start / 16) : absAt;
      const from = Math.max(start - PRE_ROLL_MS, this.asyncUntil, this.liveUntil);
      if (Date.now() >= this.sonioxRetryAt) this.openSoniox(from, absAt);
      else this.notLive(from, endAt);
    }
    const session = this.live;
    if (!session) return;
    session.send(pcm, absAt);
    this.liveUntil = endAt;
    if (Date.now() - session.openedAt > SONIOX_MAX_SESSION_MS) await this.closeSoniox();
  }

  /**
   * Fresh speech no live session can take (waiting to retry one) goes to Soniox async, unless
   * that's down too. A command it was part of is cut off.
   */
  private notLive(from: number, to: number): void {
    this.voiceCutBefore = Math.max(this.voiceCutBefore, to);
    this.setAsrHealth(false, this.lastAsrError);
    if (this.asyncDown()) this.logLost();
    else this.markBacklog(from, to);
  }

  private markBacklog(from: number, to: number): void {
    const last = this.backlogSpans[this.backlogSpans.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else this.backlogSpans.push({ from, to });
    this.asyncUntil = Math.max(this.asyncUntil, to);
  }

  private asyncDown(): boolean {
    return Date.now() < this.asyncDownUntil;
  }

  private logLost(): void {
    if (this.lostLogged) return;
    this.lostLogged = true;
    this.deps.log("soniox: live and async transcription both failing; speech meanwhile is lost");
  }

  private async onSegment(seg: SpeechSegment): Promise<void> {
    // Speech in audio that arrived fresh was streamed to Soniox real-time (if a session was healthy;
    // otherwise it's lost). The parts that arrived late are batched for Soniox async.
    if (!this.deps.soniox) return;
    const startAt = this.runStartAt + seg.start / 16;
    const endAt = startAt + seg.samples.length / 16;
    // Segments come in time order: earlier spans can't overlap later segments.
    while (this.backlogSpans.length > 0 && this.backlogSpans[0]!.to <= startAt)
      this.backlogSpans.shift();
    for (const span of this.backlogSpans) {
      const from = Math.max(span.from, startAt);
      const to = Math.min(span.to, endAt);
      if (to <= from) continue;
      const samples = seg.samples.subarray(
        Math.floor((from - startAt) * 16),
        Math.ceil((to - startAt) * 16),
      );
      this.addBacklog({ startAt: from, endAt: from + samples.length / 16, samples });
    }
    if (this.backlog && this.backlog.samples >= BACKLOG_BATCH_SAMPLES) this.sendBacklog();
  }

  private addBacklog(seg: Segment): void {
    if (!this.backlog) {
      this.backlog = { segments: [], samples: 0, addedAt: 0 };
      this.deps.blocks.hold(this.stream.userId);
    }
    this.backlog.segments.push(seg);
    this.backlog.samples += seg.samples.length;
    this.backlog.addedAt = Date.now();
  }

  /** Audio a failed live session hadn't transcribed goes to Soniox async (up to the last speech). */
  private rescue(session: SonioxSession): void {
    if (this.asyncDown()) {
      this.logLost();
      return;
    }
    const until = this.lastSpeechAudioAt + PRE_ROLL_MS;
    let seconds = 0;
    for (const span of session.untranscribed()) {
      const to = Math.min(span.to, until);
      const samples = to > span.from ? this.history.slice(span.from, to) : null;
      if (!samples || samples.length === 0) continue;
      this.addBacklog({ startAt: span.from, endAt: span.from + samples.length / 16, samples });
      this.asyncUntil = Math.max(this.asyncUntil, span.from + samples.length / 16);
      seconds += samples.length / 16_000;
    }
    if (seconds > 0)
      this.deps.log(`soniox: ${seconds.toFixed(1)} s not transcribed live; sent to async`);
  }

  /**
   * Queue the batch being built for Soniox async, one request at a time in the background. Never
   * waits (see backlogBackpressure); past BACKLOG_QUEUE_MAX_SAMPLES the oldest waiting is dropped.
   */
  private sendBacklog(): void {
    const batch = this.backlog;
    this.backlog = null;
    if (!batch) return;
    this.backlogPending.push(batch);
    this.backlogPendingSamples += batch.samples;
    while (
      this.backlogPendingSamples > BACKLOG_QUEUE_MAX_SAMPLES &&
      this.backlogPending.length > 1
    ) {
      const old = this.backlogPending.shift()!;
      this.backlogPendingSamples -= old.samples;
      this.deps.blocks.release(this.stream.userId);
      this.deps.log(
        `soniox backlog: too much waiting; ${Math.round(old.samples / 16_000)} s of speech dropped`,
      );
    }
    if (!this.backlogPumping) {
      this.backlogPumping = true;
      this.backlogQueue = this.pumpBacklog();
    }
  }

  private async pumpBacklog(): Promise<void> {
    for (let batch = this.backlogPending.shift(); batch; batch = this.backlogPending.shift()) {
      this.backlogPendingSamples -= batch.samples;
      this.backlogInFlightSamples = batch.samples;
      try {
        await this.transcribeBacklog(batch);
      } catch (err) {
        this.deps.log(`soniox backlog: ${err}`);
      } finally {
        this.backlogInFlightSamples = 0;
        this.deps.blocks.release(this.stream.userId);
      }
    }
    this.backlogPumping = false;
  }

  /**
   * Decoding backlog runs far ahead of transcribing it: while this stream's audio is backlog and
   * Soniox async works, wait for a batch to finish rather than pile up audio. Never for live audio,
   * and not while async is failing (then the queue drops its oldest).
   */
  private async backlogBackpressure(): Promise<void> {
    while (!this.fresh && !this.asyncDown() && this.backlogPendingSamples >= BACKLOG_BATCH_SAMPLES)
      await Promise.race([this.backlogQueue, Bun.sleep(1000)]);
  }

  private async transcribeBacklog(batch: BacklogBatch): Promise<void> {
    const cfg = this.deps.soniox!;
    // Stitch the speech together; the clock maps positions in the stitched audio back to wall clock.
    const clock = new SessionClock();
    const gaps = batch.segments.map((seg, i) => {
      const next = batch.segments[i + 1];
      const real = next ? next.startAt - seg.endAt : BACKLOG_GAP_MS;
      return Math.round(Math.max(0, Math.min(BACKLOG_GAP_MS, real)) * 16);
    });
    const audio = new Float32Array(batch.samples + gaps.reduce((n, g) => n + g, 0));
    let o = 0;
    for (const [i, seg] of batch.segments.entries()) {
      audio.set(seg.samples, o);
      clock.sent(seg.startAt, seg.samples.length / 16);
      if (gaps[i]) clock.sent(seg.endAt, gaps[i]! / 16);
      o += seg.samples.length + gaps[i]!;
    }
    const pcm = toPcm16(audio);
    const seconds = Math.round(batch.samples / 16_000);
    let tokens: SonioxToken[] | null = null;
    for (let attempt = 0; !tokens; attempt++) {
      try {
        tokens = await transcribeFile(pcm, {
          apiKey: cfg.apiKey,
          model: cfg.asyncModel,
          languageHints: cfg.languageHints,
          terms: await this.deps.terms(this.stream.userId),
        });
      } catch (err) {
        this.asyncDownUntil = Date.now() + ASYNC_DOWN_MS;
        const wait =
          err instanceof SonioxError && err.retryable ? BACKLOG_RETRY_MS[attempt] : undefined;
        if (wait === undefined) {
          this.deps.log(`soniox backlog: ${err}; ${seconds} s of speech not transcribed`);
          return;
        }
        this.deps.log(`soniox backlog: ${err}; retrying in ${wait / 1000} s`);
        await Bun.sleep(wait);
      }
    }
    this.asyncDownUntil = 0;
    this.lostLogged = false;
    // Speaker labels are per request: make them unique.
    const prefix = `soniox:${crypto.randomUUID().slice(0, 8)}:`;
    const assembler = new SonioxAssembler(clock, cfg.asyncModel, undefined, prefix);
    const utterances = assembler.push(tokens);
    const last = assembler.flush();
    if (last) utterances.push(last);
    for (const u of utterances)
      await this.saveUtterance(u, sliceSegments(batch.segments, u.startAt, u.endAt), false);
  }

  /** Open a live session for audio from `absAt` on, with lead-in from `from`. */
  private openSoniox(from: number, absAt: number): void {
    const cfg = this.deps.soniox!;
    const session: SonioxSession = new SonioxSession(
      {
        apiKey: cfg.apiKey,
        model: cfg.model,
        languageHints: cfg.languageHints,
        terms: this.deps.terms(this.stream.userId),
      },
      (u) => {
        this.queue = this.queue
          .then(() => this.saveUtterance(u, this.history.slice(u.startAt, u.endAt), true))
          .catch((err) => this.deps.log(`soniox utterance: ${err}`));
      },
      (message) => {
        // A session that worked for a while starts the backoff over (not just any that answered:
        // a Soniox that accepts sessions and then kills them would be retried every second).
        if (session.responded && Date.now() - session.openedAt >= SONIOX_HEALTHY_MS)
          this.sonioxFailures = 0;
        const wait = SONIOX_RETRY_MS[Math.min(this.sonioxFailures, SONIOX_RETRY_MS.length - 1)]!;
        this.sonioxFailures++;
        this.sonioxRetryAt = Date.now() + wait;
        this.lastAsrError = message;
        // What the user was saying, and any command it was part of, is cut off.
        if (this.speakingAtEnd)
          this.voiceCutBefore = Math.max(this.voiceCutBefore, this.heardUntil);
        this.deps.log(`${message}; retrying in ${wait / 1000} s (speech meanwhile: async)`);
        // One drop that reconnects at once isn't an outage.
        if (this.sonioxFailures >= 2) this.setAsrHealth(false, message);
      },
      // The wake phrase as soon as the recognizer has it (the pendant buzzes): not queued behind
      // the utterances being saved.
      this.deps.voice
        ? (p) => void this.deps.voice!.partial(this.stream.userId, p, this.voiceSource)
        : undefined,
    );
    this.live = session;
    const pre = from < absAt ? this.history.slice(from, absAt) : null;
    if (pre && pre.length > 0) session.send(toPcm16(pre), absAt - pre.length / 16);
  }

  /** The live session has worked for a while: the backoff starts over, transcription is up. */
  private checkHealthy(now: number): void {
    const s = this.live;
    if (s && !s.closed && s.responded && now - s.openedAt >= SONIOX_HEALTHY_MS) {
      this.sonioxFailures = 0;
      this.setAsrHealth(true, null);
    }
  }

  private setAsrHealth(ok: boolean, message: string | null): void {
    if (this.asrDown === !ok) return;
    this.asrDown = !ok;
    if (ok) this.deps.log("soniox: live transcription works again");
    this.deps.asrHealth?.(this.stream.userId, this.stream.id, ok, message);
  }

  private async closeSoniox(): Promise<void> {
    const session = this.live;
    this.live = null;
    if (!session) return;
    await session.close();
    if (session.failed) this.rescue(session);
    else if (!session.finished)
      this.deps.log("soniox: session closed before confirming the last audio was transcribed");
  }

  // ---- results ----------------------------------------------------------------------------

  private async saveUtterance(
    u: Utterance,
    audio: Float32Array | null,
    fresh: boolean,
  ): Promise<void> {
    const { userId } = this.stream;
    const placed = await this.deps.blocks.place(userId, u.startAt, u.endAt, fresh);
    let personId: string | null = null;
    let isWearer: boolean | null = null;
    let emb: Float32Array | null = null;
    if (audio && audio.length >= MIN_EMBED_SAMPLES && this.deps.embedder) {
      emb = this.deps.embedder.embed(audio);
      const ownerBar = await this.deps.ownerBar?.(userId).catch(() => null);
      const match = await this.deps.speakers?.identify(userId, emb, ownerBar).catch((err) => {
        this.deps.log(`speaker identify: ${err}`);
        return null;
      });
      if (match) {
        personId = match.personId;
        isWearer = match.isSelf;
      }
    }
    // The engine's labels are per session (or request): map them onto the chain's voices (from
    // enough audio to be sure), so a voice keeps its key across sessions. Without labels, cluster
    // voices within the chain.
    const speakerKey = u.speakerKey
      ? placed.clusters.label(
          u.speakerKey,
          u.speakerKey.slice(0, u.speakerKey.lastIndexOf(":") + 1),
          audio && audio.length >= MIN_LABEL_SAMPLES ? emb : null,
        )
      : emb && placed.clusters.assign(emb);
    if (fresh) {
      this.deps.episodes.speech(userId, {
        startAt: u.startAt,
        endAt: u.endAt,
        speaker: personId ?? speakerKey,
        isWearer,
      });
    }
    try {
      await this.deps.db.insert(schema.utterances).values({
        userId,
        blockId: placed.blockId,
        streamId: this.stream.id,
        startAt: new Date(u.startAt),
        endAt: new Date(Math.max(u.endAt, u.startAt)),
        speakerKey,
        personId,
        isWearer,
        text: u.text,
        lang: u.lang,
        confidence: u.confidence,
        source: "live",
        provider: u.provider,
        model: u.model,
      });
      this.deps.invalidate(userId, ["timeline"]);
    } finally {
      // A voice command must not be missed because its line couldn't be stored.
      if (fresh && this.deps.voice) {
        await this.deps.voice.heard(
          userId,
          {
            streamId: this.stream.id,
            text: u.text,
            startAt: u.startAt,
            endAt: u.endAt,
            lang: u.lang,
            speakerKey,
            isSelf: isWearer,
            chainId: placed.chainId,
            ...(u.cutOff ? { cutOff: true } : {}),
          },
          this.voiceSource,
        );
      }
    }
  }

  private async tag(samples: Float32Array, fresh: boolean): Promise<void> {
    let o = 0;
    while (o < samples.length) {
      const room = TAG_WINDOW_SAMPLES - this.tagFill;
      const n = Math.min(room, samples.length - o);
      this.tagBuf.set(samples.subarray(o, o + n), this.tagFill);
      this.tagFill += n;
      this.tagSinceHop += n;
      o += n;
      if (this.tagFill === TAG_WINDOW_SAMPLES && this.tagSinceHop >= TAG_HOP_SAMPLES) {
        this.tagSinceHop = 0;
        // Window end = current position in the run minus what's left of this batch.
        const windowEnd = this.runStartAt + (this.runSamples - (samples.length - o)) / 16;
        const windowStart = windowEnd - TAG_WINDOW_SAMPLES / 16;
        // Quiet windows aren't worth tagging, but still count as misses for open events.
        const loud = rms(this.tagBuf) >= TAG_MIN_RMS;
        // Tagging is the costly part: for backlog, let the live stream go first at every window.
        if (loud && !fresh) await yieldToLive();
        // Speech-context classes (television, narration…) rarely make the top 10: ask for more.
        const all = loud ? this.deps.tagger!.tag(this.tagBuf, 50) : [];
        const tags = all.slice(0, 10);
        if (loud) this.context.add(windowStart, windowEnd, contextScores(all));
        await this.saveContext(this.context.drain(windowStart - 5_000));
        const { opened, closed } = this.smoother.push(tags, windowStart, windowEnd);
        for (const ev of opened) await this.saveSound(ev, false);
        for (const ev of closed) await this.saveSound(ev, true);
        for (const ev of this.smoother.openEvents()) await this.extendSound(ev);
        // Slide by one hop.
        this.tagBuf.copyWithin(0, TAG_HOP_SAMPLES);
        this.tagFill = TAG_WINDOW_SAMPLES - TAG_HOP_SAMPLES;
      }
    }
  }

  /** Store finished context minutes; recent ones also go to the live episode tracker. */
  private async saveContext(minutes: ContextMinute[]): Promise<void> {
    const { userId } = this.stream;
    for (const m of minutes) {
      const c = schema.contextSamples;
      // Two streams can cover the same minute: keep the one with more tagged audio.
      await this.deps.db
        .insert(c)
        .values({ userId, at: new Date(m.at), windows: m.windows, scores: m.scores })
        .onConflictDoUpdate({
          target: [c.userId, c.at],
          set: { windows: sql`excluded.windows`, scores: sql`excluded.scores` },
          setWhere: sql`excluded.windows >= ${c.windows}`,
        });
      if (this.fresh) this.deps.episodes.context(userId, m);
    }
  }

  private soundKey(ev: SoundEvent): string {
    return `${ev.audioset}@${ev.startAt}`;
  }

  /** Insert when an event opens; update its end as it continues; finalize on close. */
  private async saveSound(ev: SoundEvent, final: boolean): Promise<void> {
    const key = this.soundKey(ev);
    const existing = this.openSoundRows.get(key);
    const kind = ev.endAt - ev.startAt >= 10_000 ? "state" : "point";
    if (existing) {
      await this.deps.db
        .update(schema.soundEvents)
        .set({ endAt: new Date(ev.endAt), confidence: ev.confidence, kind })
        .where(eq(schema.soundEvents.id, existing));
    } else {
      const [row] = await this.deps.db
        .insert(schema.soundEvents)
        .values({
          userId: this.stream.userId,
          streamId: this.stream.id,
          startAt: new Date(ev.startAt),
          endAt: new Date(ev.endAt),
          label: ev.label,
          kind,
          confidence: ev.confidence,
          audiosetLabels: [ev.audioset],
          source: "live",
          model: "ced-base",
        })
        .returning({ id: schema.soundEvents.id });
      if (!final && row) this.openSoundRows.set(key, row.id);
    }
    if (final) {
      this.openSoundRows.delete(key);
      void this.deps.episodes
        .soundEnded(this.stream.userId, ev.startAt, ev.endAt)
        .catch((err) => this.deps.log(`sound episode: ${err}`));
    }
    this.deps.invalidate(this.stream.userId, ["timeline"]);
  }

  private lastExtend = new Map<string, number>();

  private async extendSound(ev: SoundEvent): Promise<void> {
    const key = this.soundKey(ev);
    const id = this.openSoundRows.get(key);
    if (!id) return;
    const last = this.lastExtend.get(key) ?? 0;
    if (ev.endAt - last < 10_000) return; // throttle long states
    this.lastExtend.set(key, ev.endAt);
    await this.deps.db
      .update(schema.soundEvents)
      .set({ endAt: new Date(ev.endAt), kind: ev.endAt - ev.startAt >= 10_000 ? "state" : "point" })
      .where(eq(schema.soundEvents.id, id));
  }
}
