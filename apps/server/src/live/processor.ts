import { OpusDecoder } from "@hearloom/audio";
import type { Db } from "@hearloom/db";
import { schema } from "@hearloom/db";
import {
  type LocalAsr,
  rms,
  type SoundTagger,
  type SpeakerEmbedder,
  type SpeechSegment,
  toFloat32,
  VadSession,
} from "@hearloom/inference";
import type { AudioFrame } from "@hearloom/shared";
import { eq } from "drizzle-orm";
import { SonioxSession } from "./asr/soniox";
import type { Utterance } from "./asr/types";
import type { ConversationTracker } from "./conversations";
import { guessLanguage } from "./lang";
import { PcmHistory } from "./pcm";
import { type SoundEvent, SoundEventSmoother } from "./sounds";
import type { SpeakerDirectory } from "./speakers";

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
  localAsr: LocalAsr | null;
  speakers: SpeakerDirectory | null;
  conversations: ConversationTracker;
  soniox: { apiKey: string; model: string; languageHints: string[] } | null;
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
/** Gaps up to this are lost packets (concealed); longer gaps are mic sleep (silence). */
const RUN_GAP_MS = 2000;
const TAG_WINDOW_SAMPLES = 32_000; // 2 s
const TAG_HOP_SAMPLES = 16_000; // 1 s
const TAG_MIN_RMS = 0.003;
const MIN_EMBED_SAMPLES = 16_000; // 1 s

/**
 * Turns one capture stream's Opus frames into timeline rows: utterances (with speakers and
 * conversations) and sound events. All times are absolute (unix ms).
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
  // Live transcription.
  private soniox: SonioxSession | null = null;
  private lastSpeechAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly stream: StreamInfo,
    private readonly deps: LiveDeps,
  ) {
    this.decoder = new OpusDecoder(16000, 1, (16000 * stream.frameMs) / 1000);
  }

  /** Process frames in order (calls are serialized). */
  push(frames: AudioFrame[]): Promise<void> {
    this.queue = this.queue
      .then(() => this.process(frames))
      .catch((err) => this.deps.log(`process: ${err}`));
    return this.queue;
  }

  /** Called periodically: closes the current run after silence, and idle Soniox sessions. */
  tick(now = Date.now()): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (this.lastFrameAt !== null && now - this.lastActivity > RUN_GAP_MS + 1000)
          await this.endRun();
        if (this.soniox && (now - this.lastSpeechAt > SONIOX_IDLE_MS || this.soniox.closed))
          await this.closeSoniox();
      })
      .catch((err) => this.deps.log(`tick: ${err}`));
    return this.queue;
  }

  async dispose(): Promise<void> {
    await this.queue;
    await this.endRun();
    await this.closeSoniox();
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
        for (let i = 0; i < Math.min(missing, 100); i++) pcmParts.push(this.decoder.conceal());
      }
      pcmParts.push(f.data.length <= 1 ? this.decoder.conceal() : this.decoder.decode(f.data));
      this.lastFrameAt = f.at;
    }
    await flushParts();
  }

  private startRun(at: number): void {
    this.vad = new VadSession(this.deps.modelsDir);
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
    this.soniox?.finalize();
    this.lastFrameAt = null;
  }

  // ---- per-run processing ------------------------------------------------------------------

  private async feed(pcm: Int16Array): Promise<void> {
    const samples = toFloat32(pcm);
    const absAt = this.runStartAt + this.runSamples / 16;
    this.runSamples += samples.length;
    this.history.push(absAt, samples);
    const fresh = Date.now() - absAt < FRESH_MS;

    // Speech detection.
    const { segments, speaking } = this.vad!.accept(samples);
    if (speaking) this.lastSpeechAt = Date.now();
    if (fresh && this.deps.soniox) {
      if (speaking && !this.soniox) this.openSoniox(absAt);
      if (this.soniox) this.soniox.send(pcm, absAt);
      if (this.soniox && Date.now() - this.soniox.openedAt > SONIOX_MAX_SESSION_MS)
        await this.closeSoniox();
    }
    for (const seg of segments) await this.onSegment(seg);

    // Sound tagging: 2 s windows every 1 s.
    if (this.deps.tagger) await this.tag(samples);
  }

  private async onSegment(seg: SpeechSegment): Promise<void> {
    const startAt = this.runStartAt + seg.start / 16;
    const endAt = startAt + seg.samples.length / 16;
    const fresh = Date.now() - endAt < FRESH_MS;
    // With Soniox streaming, fresh speech is transcribed there; segments only matter for backlog.
    const useSoniox = this.deps.soniox && fresh;
    if (useSoniox || !this.deps.localAsr) return;
    const r = this.deps.localAsr.transcribe(seg.samples);
    if (!r.text) return;
    await this.saveUtterance(
      {
        startAt,
        endAt,
        text: r.text,
        lang: r.lang ?? guessLanguage(r.text),
        speakerKey: null,
        confidence: null,
        provider: "local",
        model: "parakeet-tdt-0.6b-v3",
      },
      seg.samples,
      fresh,
    );
  }

  private openSoniox(absAt: number): void {
    const cfg = this.deps.soniox!;
    this.soniox = new SonioxSession(
      { apiKey: cfg.apiKey, model: cfg.model, languageHints: cfg.languageHints },
      (u) => {
        this.queue = this.queue
          .then(() => this.saveUtterance(u, this.history.slice(u.startAt, u.endAt), true))
          .catch((err) => this.deps.log(`soniox utterance: ${err}`));
      },
      (message) => this.deps.log(message),
    );
    const pre = this.history.slice(absAt - PRE_ROLL_MS, absAt);
    if (pre && pre.length > 0) {
      const pcm = new Int16Array(pre.length);
      for (let i = 0; i < pre.length; i++)
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(pre[i]! * 32768)));
      this.soniox.send(pcm, absAt - pre.length / 16);
    }
  }

  private async closeSoniox(): Promise<void> {
    const s = this.soniox;
    this.soniox = null;
    if (s) await s.close();
  }

  // ---- results ----------------------------------------------------------------------------

  private async saveUtterance(
    u: Utterance,
    audio: Float32Array | null,
    fresh: boolean,
  ): Promise<void> {
    const { userId } = this.stream;
    const conv = await this.deps.conversations.place(userId, u.startAt, u.endAt, fresh);
    let speakerKey = u.speakerKey;
    let personId: string | null = null;
    let isWearer: boolean | null = null;
    if (audio && audio.length >= MIN_EMBED_SAMPLES && this.deps.embedder) {
      const emb = this.deps.embedder.embed(audio);
      const match = await this.deps.speakers?.identify(userId, emb);
      if (match) {
        personId = match.personId;
        isWearer = match.isSelf;
      }
      // Without an engine-provided speaker label, cluster voices within the conversation.
      speakerKey ??= conv.clusters.assign(emb);
    }
    this.deps.conversations.note(userId, conv.id, u.lang, personId ?? speakerKey);
    await this.deps.db.insert(schema.utterances).values({
      userId,
      conversationId: conv.id,
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
        if (rms(this.tagBuf) >= TAG_MIN_RMS) {
          const tags = this.deps.tagger!.tag(this.tagBuf, 10);
          const { opened, closed } = this.smoother.push(tags, windowStart, windowEnd);
          for (const ev of opened) await this.saveSound(ev, false);
          for (const ev of closed) await this.saveSound(ev, true);
          for (const ev of this.smoother.openEvents()) await this.extendSound(ev);
        }
        // Slide by one hop.
        this.tagBuf.copyWithin(0, TAG_HOP_SAMPLES);
        this.tagFill = TAG_WINDOW_SAMPLES - TAG_HOP_SAMPLES;
      }
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
    if (final) this.openSoundRows.delete(key);
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
