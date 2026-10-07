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
import { type ContextMinute, ContextMinutes, contextScores, MINUTE } from "../episodes/rules";
import { SonioxSession } from "./asr/soniox";
import { SessionClock, SonioxAssembler, type SonioxToken } from "./asr/soniox-assembler";
import { SonioxError, transcribeFile } from "./asr/soniox-async";
import type { Utterance } from "./asr/types";
import type { BlockTracker } from "./blocks";
import type { EpisodeTracker } from "./episodes";
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
  /** Words to bias recognition toward for this user (the agent's name), from a cache. */
  terms(userId: string): string[];
  /** Ask the server to refresh clients' views for this user. */
  invalidate(userId: string, keys: Array<"timeline" | "status">): void;
  log(message: string): void;
}

/** Audio older than this when it reaches us is backlog (uploaded late), not live. */
const FRESH_MS = 30_000;
/** Close the Soniox session after this much time without speech (we pay per streamed second). */
const SONIOX_IDLE_MS = 45_000;
/** Rotate Soniox sessions well before their 300-minute cap. */
const SONIOX_MAX_SESSION_MS = 4 * 3600_000;
const PRE_ROLL_MS = 500;
/** After a Soniox session fails, wait this long before opening another (speech meanwhile is lost). */
const SONIOX_RETRY_MS = 30_000;
/** Backlog speech sent to Soniox async per request. */
const BACKLOG_BATCH_SAMPLES = 5 * 60 * 16_000;
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
  private vad: VadSession | null = null;
  private readonly history = new PcmHistory();
  private readonly smoother = new SoundEventSmoother();
  /** Absolute time of sample 0 of the current VAD run. */
  private runStartAt = 0;
  private runSamples = 0;
  private lastFrameAt: number | null = null;
  lastActivity = Date.now();
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
  private lastSpeechAt = 0;
  /** Audio time of the end of the latest speech (voice commands wait while the user talks on). */
  private lastSpeechAudioAt = 0;
  private readonly voiceSource: AudioSource;
  /** Wall-clock spans of audio that arrived too late to stream (merged, recent only). */
  private backlogSpans: { from: number; to: number }[] = [];
  private backlog: BacklogBatch | null = null;
  private backlogQueue: Promise<void> = Promise.resolve();
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
    };
  }

  /** Process frames in order (calls are serialized). */
  push(frames: AudioFrame[]): Promise<void> {
    this.queue = this.queue
      .then(() => this.process(frames))
      .catch((err) => this.deps.log(`process: ${err}`));
    return this.queue;
  }

  /**
   * Called periodically: closes the current run after silence and idle Soniox sessions, and sends
   * the backlog batch once its upload goes quiet.
   */
  tick(now = Date.now()): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (this.lastFrameAt !== null && now - this.lastActivity > RUN_GAP_MS + 1000)
          await this.endRun();
        if (this.live && (now - this.lastSpeechAt > SONIOX_IDLE_MS || this.live.closed))
          await this.closeSoniox();
        if (this.backlog && now - this.backlog.addedAt > BACKLOG_IDLE_MS) await this.sendBacklog();
      })
      .catch((err) => this.deps.log(`tick: ${err}`));
    return this.queue;
  }

  async dispose(): Promise<void> {
    await this.queue;
    await this.endRun();
    await this.closeSoniox();
    await this.queue; // the closed session's last utterances
    const pending = (this.backlog?.samples ?? 0) + this.backlogInFlightSamples;
    const done = await Promise.race([
      this.sendBacklog()
        .then(() => this.backlogQueue)
        .then(() => true),
      Bun.sleep(DISPOSE_WAIT_MS).then(() => false),
    ]);
    if (!done)
      this.deps.log(
        `soniox backlog: ${Math.round(pending / 16_000)} s of speech still being transcribed (lost if the process exits)`,
      );
    this.decoder.destroy();
  }

  // ---- decoding & runs --------------------------------------------------------------------

  private async process(frames: AudioFrame[]): Promise<void> {
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
      await this.feed(pcm);
    };

    for (const f of frames) {
      if (this.lastFrameAt === null || f.at - this.lastFrameAt - this.stream.frameMs > RUN_GAP_MS) {
        await flushParts();
        if (this.lastFrameAt !== null) await this.endRun();
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
    this.vad = new VadSession(this.deps.modelsDir);
    this.backlogSpans = []; // the previous run's segments were flushed in endRun
    this.runStartAt = at;
    this.runSamples = 0;
    this.tagFill = 0;
    this.tagSinceHop = 0;
  }

  /** Mic went to sleep (or stream paused): finish speech segments and sound events. */
  private async endRun(): Promise<void> {
    if (this.vad) {
      for (const seg of this.vad.flush()) await this.onSegment(seg);
      this.vad = null;
    }
    for (const ev of this.smoother.flush()) await this.saveSound(ev, true);
    await this.saveContext(this.context.drain());
    this.live?.finalize();
    this.lastFrameAt = null;
  }

  // ---- per-run processing ------------------------------------------------------------------

  private async feed(pcm: Int16Array): Promise<void> {
    const samples = toFloat32(pcm);
    const absAt = this.runStartAt + this.runSamples / 16;
    this.runSamples += samples.length;
    this.history.push(absAt, samples);
    const fresh = Date.now() - absAt < FRESH_MS;
    if (!fresh && this.deps.soniox) this.markBacklog(absAt, absAt + samples.length / 16);

    // Speech detection.
    const { segments, speaking } = this.vad!.accept(samples);
    if (speaking) {
      this.lastSpeechAt = Date.now();
      this.lastSpeechAudioAt = absAt + samples.length / 16;
    }
    if (fresh && this.deps.soniox) {
      if (speaking && !this.live && Date.now() >= this.sonioxRetryAt) this.openSoniox(absAt);
      const session = this.live;
      if (session) session.send(pcm, absAt);
      if (session && Date.now() - session.openedAt > SONIOX_MAX_SESSION_MS)
        await this.closeSoniox();
    }
    for (const seg of segments) await this.onSegment(seg);

    // Sound tagging: 2 s windows every 1 s.
    if (this.deps.tagger) await this.tag(samples);
  }

  private markBacklog(from: number, to: number): void {
    const last = this.backlogSpans[this.backlogSpans.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else this.backlogSpans.push({ from, to });
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
      if (!this.backlog) {
        this.backlog = { segments: [], samples: 0, addedAt: 0 };
        this.deps.blocks.hold(this.stream.userId);
      }
      this.backlog.segments.push({ startAt: from, endAt: from + samples.length / 16, samples });
      this.backlog.samples += samples.length;
      this.backlog.addedAt = Date.now();
    }
    if (this.backlog && this.backlog.samples >= BACKLOG_BATCH_SAMPLES) await this.sendBacklog();
  }

  /**
   * Transcribe the pending backlog batch in the background. At most one batch is in flight:
   * decoding runs far ahead of transcription, so wait rather than pile up audio in memory.
   */
  private async sendBacklog(): Promise<void> {
    const batch = this.backlog;
    this.backlog = null;
    if (!batch) return;
    await this.backlogQueue;
    this.backlogInFlightSamples = batch.samples;
    this.backlogQueue = this.transcribeBacklog(batch)
      .catch((err) => this.deps.log(`soniox backlog: ${err}`))
      .finally(() => {
        this.backlogInFlightSamples = 0;
        this.deps.blocks.release(this.stream.userId);
      });
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
          terms: this.deps.terms(this.stream.userId),
        });
      } catch (err) {
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
    // Speaker labels are per request: make them unique.
    const prefix = `soniox:${crypto.randomUUID().slice(0, 8)}:`;
    const assembler = new SonioxAssembler(clock, cfg.asyncModel, undefined, prefix);
    const utterances = assembler.push(tokens);
    const last = assembler.flush();
    if (last) utterances.push(last);
    for (const u of utterances)
      await this.saveUtterance(u, sliceSegments(batch.segments, u.startAt, u.endAt), false);
  }

  private openSoniox(absAt: number): void {
    const cfg = this.deps.soniox!;
    const session = new SonioxSession(
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
        this.deps.log(`${message}; retrying in ${SONIOX_RETRY_MS / 1000} s`);
        this.sonioxRetryAt = Date.now() + SONIOX_RETRY_MS;
      },
    );
    this.live = session;
    const pre = this.history.slice(absAt - PRE_ROLL_MS, absAt);
    if (pre && pre.length > 0) session.send(toPcm16(pre), absAt - pre.length / 16);
  }

  private async closeSoniox(): Promise<void> {
    const session = this.live;
    this.live = null;
    if (!session) return;
    await session.close();
    if (!session.finished && !session.failed)
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
    let speakerKey = u.speakerKey ? placed.clusters.alias(u.speakerKey) : null;
    let personId: string | null = null;
    let isWearer: boolean | null = null;
    if (audio && audio.length >= MIN_EMBED_SAMPLES && this.deps.embedder) {
      const emb = this.deps.embedder.embed(audio);
      const match = await this.deps.speakers?.identify(userId, emb);
      if (match) {
        personId = match.personId;
        isWearer = match.isSelf;
      }
      // Without an engine-provided speaker label, cluster voices within the chain.
      speakerKey ??= placed.clusters.assign(emb);
    }
    if (fresh) {
      this.deps.episodes.speech(userId, {
        startAt: u.startAt,
        endAt: u.endAt,
        speaker: personId ?? speakerKey,
        isWearer,
      });
    }
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
        },
        this.voiceSource,
      );
    }
  }

  private async tag(samples: Float32Array): Promise<void> {
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
      if (Date.now() - (m.at + MINUTE) < FRESH_MS + MINUTE) this.deps.episodes.context(userId, m);
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
