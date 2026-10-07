/**
 * Records a short clip from the browser mic as 16 kHz mono PCM16, the pendant's format. The
 * browser's own processing (echo cancellation, noise suppression, gain control) is turned off so
 * the voice sounds like it does to the pendant mic; the server then puts the clip through the
 * pendant's codec before learning from it.
 */
export const MIC_RATE = 16_000;
const MAX_SECONDS = 12;

export interface Recording {
  stop(): Promise<Int16Array>;
  cancel(): void;
  /** Input level 0..1 (for a meter). */
  level(): number;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  // Resampled by the browser to 16 kHz where it can (Firefox can't mix rates: resample below).
  let ctx = new AudioContext({ sampleRate: MIC_RATE });
  let source: MediaStreamAudioSourceNode;
  try {
    source = ctx.createMediaStreamSource(stream);
  } catch {
    void ctx.close();
    ctx = new AudioContext();
    source = ctx.createMediaStreamSource(stream);
  }
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let total = 0;
  let level = 0;
  node.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    if (total < MAX_SECONDS * ctx.sampleRate) {
      chunks.push(Float32Array.from(data));
      total += data.length;
    }
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    level = level * 0.6 + peak * 0.4;
  };
  source.connect(node);
  // A script processor only runs when connected to the output (it outputs silence).
  node.connect(ctx.destination);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    node.disconnect();
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
  };
  return {
    level: () => level,
    cancel: close,
    async stop() {
      close();
      const rate = ctx.sampleRate;
      const joined = new Float32Array(total);
      let o = 0;
      for (const c of chunks) {
        joined.set(c.subarray(0, Math.min(c.length, total - o)), o);
        o += c.length;
        if (o >= total) break;
      }
      // Some browsers ignore the requested rate: resample if needed.
      const samples = rate === MIC_RATE ? joined : resample(joined, rate, MIC_RATE);
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++)
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767)));
      return pcm;
    },
  };
}

/**
 * Resample for speech: a moving average over the decimation factor (a crude low-pass against
 * aliasing), then linear interpolation.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  const width = Math.max(1, Math.round(from / to));
  const smooth = new Float32Array(input.length);
  let acc = 0;
  for (let i = 0; i < input.length; i++) {
    acc += input[i]!;
    if (i >= width) acc -= input[i - width]!;
    smooth[i] = acc / Math.min(width, i + 1);
  }
  const out = new Float32Array(Math.floor((input.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const a = Math.floor(x);
    const b = Math.min(smooth.length - 1, a + 1);
    out[i] = smooth[a]! + (smooth[b]! - smooth[a]!) * (x - a);
  }
  return out;
}

/** Base64 of PCM16 little-endian bytes (for the upload). */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
