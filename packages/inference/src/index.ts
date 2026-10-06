/**
 * Typed wrappers around sherpa-onnx (native ONNX Runtime) for the models Hearloom runs locally.
 * Model files are fetched with `pnpm --filter @hearloom/server download-models`.
 * These call into a native addon: run them in a child process so a native crash can't take down
 * the ingest server.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error sherpa-onnx-node ships JS with JSDoc types only.
import sherpa from "sherpa-onnx-node";

export const SAMPLE_RATE = 16000;

export const MODEL_FILES = {
  vad: "silero_vad_v6.onnx",
  tagger: "sherpa-onnx-ced-base-audio-tagging-2024-04-19/model.int8.onnx",
  taggerLabels: "sherpa-onnx-ced-base-audio-tagging-2024-04-19/class_labels_indices.csv",
  // 3D-Speaker CAM++ (zh+en, 200k speakers): raw cosine separates speakers well on Opus audio,
  // unlike WeSpeaker ResNet293 whose raw scores overlapped badly in our tests (docs/models.md).
  speaker: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
} as const;

export const SPEAKER_MODEL_ID = "3dspeaker-campplus-zh-en-advanced";

export function modelPath(modelsDir: string, file: string): string {
  const p = join(modelsDir, file);
  if (!existsSync(p)) {
    throw new Error(`model not found: ${p} (run: pnpm --filter @hearloom/server download-models)`);
  }
  return p;
}

export function hasModel(modelsDir: string, file: string): boolean {
  return existsSync(join(modelsDir, file));
}

/** Int16 PCM -> Float32 in [-1, 1]. */
export function toFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

// ---- Voice activity detection --------------------------------------------------------------

export interface VadOptions {
  threshold?: number;
  minSilenceSec?: number;
  minSpeechSec?: number;
  maxSpeechSec?: number;
}

export interface SpeechSegment {
  /** Sample index from the start of this VAD session. */
  start: number;
  samples: Float32Array;
}

/** Streaming Silero VAD (v6). Feed any amount of audio; completed utterance segments pop out. */
export class VadSession {
  private vad: {
    acceptWaveform(s: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    front(): SpeechSegment;
    pop(): void;
    flush(): void;
    reset(): void;
  };
  private pending = new Float32Array(0);
  static readonly WINDOW = 512;

  constructor(modelsDir: string, opts: VadOptions = {}) {
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: modelPath(modelsDir, MODEL_FILES.vad),
          threshold: opts.threshold ?? 0.5,
          minSilenceDuration: opts.minSilenceSec ?? 0.6,
          minSpeechDuration: opts.minSpeechSec ?? 0.25,
          windowSize: VadSession.WINDOW,
          maxSpeechDuration: opts.maxSpeechSec ?? 20,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: 0,
      },
      60,
    );
  }

  /** Feed samples; returns segments that just completed, and whether speech is ongoing now. */
  accept(samples: Float32Array): { segments: SpeechSegment[]; speaking: boolean } {
    let buf = samples;
    if (this.pending.length > 0) {
      buf = new Float32Array(this.pending.length + samples.length);
      buf.set(this.pending);
      buf.set(samples, this.pending.length);
    }
    let o = 0;
    for (; o + VadSession.WINDOW <= buf.length; o += VadSession.WINDOW) {
      this.vad.acceptWaveform(buf.subarray(o, o + VadSession.WINDOW));
    }
    this.pending = buf.slice(o);
    return { segments: this.drain(), speaking: this.vad.isDetected() };
  }

  /** End of audio (e.g. mic sleep): emit any segment in progress. */
  flush(): SpeechSegment[] {
    this.vad.flush();
    const segs = this.drain();
    this.vad.reset();
    this.pending = new Float32Array(0);
    return segs;
  }

  private drain(): SpeechSegment[] {
    const out: SpeechSegment[] = [];
    while (!this.vad.isEmpty()) {
      const s = this.vad.front();
      out.push({ start: s.start, samples: Float32Array.from(s.samples) });
      this.vad.pop();
    }
    return out;
  }
}

// ---- Sound tagging (AudioSet) ---------------------------------------------------------------

export interface AudioTag {
  /** AudioSet class index (0..526). */
  index: number;
  name: string;
  prob: number;
}

export class SoundTagger {
  private tagger: {
    createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void };
    compute(stream: unknown, topK: number): AudioTag[];
  };

  constructor(modelsDir: string, numThreads = 2) {
    this.tagger = new sherpa.AudioTagging({
      model: { ced: modelPath(modelsDir, MODEL_FILES.tagger), numThreads },
      labels: modelPath(modelsDir, MODEL_FILES.taggerLabels),
      topK: 10,
    });
  }

  /** Top-K AudioSet classes for a window (CED-base, trained on 16 kHz). */
  tag(samples: Float32Array, topK = 10): AudioTag[] {
    const s = this.tagger.createStream();
    s.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    return this.tagger.compute(s, topK);
  }
}

// ---- Speaker embeddings ---------------------------------------------------------------------

export class SpeakerEmbedder {
  private ext: {
    dim: number;
    createStream(): {
      acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
      inputFinished(): void;
    };
    compute(stream: unknown): Float32Array;
  };
  readonly model = SPEAKER_MODEL_ID;

  constructor(modelsDir: string, numThreads = 2) {
    this.ext = new sherpa.SpeakerEmbeddingExtractor({
      model: modelPath(modelsDir, MODEL_FILES.speaker),
      numThreads,
      debug: 0,
    });
  }

  get dim(): number {
    return this.ext.dim;
  }

  /** L2-normalized speaker embedding. Needs ≥ ~1 s of speech to be meaningful. */
  embed(samples: Float32Array): Float32Array {
    const s = this.ext.createStream();
    s.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    s.inputFinished();
    return normalize(Float32Array.from(this.ext.compute(s)));
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}
