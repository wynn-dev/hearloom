/**
 * libopus via bun:ffi. Decoding needs exact packet-loss concealment (opus_decode with a
 * NULL packet yields exactly one frame of PLC), which the WASM decoders don't provide.
 * Install: `brew install opus` (macOS) or `apt install libopus0` (Linux); override with OPUS_LIB.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync } from "node:fs";

const CANDIDATES = [
  process.env.OPUS_LIB,
  "/opt/homebrew/lib/libopus.dylib",
  "/usr/local/lib/libopus.dylib",
  "/usr/lib/x86_64-linux-gnu/libopus.so.0",
  "/usr/lib/aarch64-linux-gnu/libopus.so.0",
  "libopus.so.0",
].filter((p): p is string => Boolean(p));

function load() {
  const path = CANDIDATES.find((p) => !p.startsWith("/") || existsSync(p));
  if (!path) throw new Error("libopus not found; install it or set OPUS_LIB");
  return dlopen(path, {
    opus_decoder_create: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    opus_decode: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    opus_decoder_destroy: { args: [FFIType.ptr], returns: FFIType.void },
    opus_encoder_create: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.ptr,
    },
    opus_encode: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    opus_encoder_destroy: { args: [FFIType.ptr], returns: FFIType.void },
    opus_strerror: { args: [FFIType.i32], returns: FFIType.cstring },
  });
}

let lib: ReturnType<typeof load> | null = null;
const opus = () => {
  lib ??= load();
  return lib.symbols;
};

export const OPUS_APPLICATION_RESTRICTED_LOWDELAY = 2051;

function check(code: number, what: string): number {
  if (code < 0) throw new Error(`${what}: ${opus().opus_strerror(code)}`);
  return code;
}

/** Stateful decoder for one stream. Frames must be fed in order. */
export class OpusDecoder {
  private handle: ReturnType<ReturnType<typeof opus>["opus_decoder_create"]>;
  private readonly pcm: Int16Array;

  constructor(
    readonly sampleRate = 16000,
    readonly channels = 1,
    readonly frameSamples = 320,
  ) {
    const err = new Int32Array(1);
    this.handle = opus().opus_decoder_create(sampleRate, channels, ptr(err));
    if (!this.handle || err[0] !== 0) throw new Error(`opus_decoder_create failed (${err[0]})`);
    // Room for the longest Opus frame (120 ms).
    this.pcm = new Int16Array((sampleRate / 1000) * 120 * channels);
  }

  /** Decode one packet; returns a copy of the PCM samples. */
  decode(packet: Uint8Array): Int16Array {
    if (packet.length <= 1) return this.conceal();
    const n = check(
      opus().opus_decode(
        this.handle,
        ptr(packet),
        packet.length,
        ptr(this.pcm),
        this.pcm.length / this.channels,
        0,
      ),
      "opus_decode",
    );
    return this.pcm.slice(0, n * this.channels);
  }

  /** Packet-loss concealment for exactly one frame. */
  conceal(): Int16Array {
    const n = check(
      opus().opus_decode(this.handle, null, 0, ptr(this.pcm), this.frameSamples, 0),
      "opus_decode(plc)",
    );
    return this.pcm.slice(0, n * this.channels);
  }

  destroy(): void {
    if (this.handle) opus().opus_decoder_destroy(this.handle);
    this.handle = null;
  }
}

/** Encoder matching the Omi firmware's mode (CELT-only low delay). For tests and simulation. */
export class OpusEncoder {
  private handle: ReturnType<ReturnType<typeof opus>["opus_encoder_create"]>;
  private readonly out = new Uint8Array(4000);

  constructor(
    readonly sampleRate = 16000,
    readonly channels = 1,
    application = OPUS_APPLICATION_RESTRICTED_LOWDELAY,
  ) {
    const err = new Int32Array(1);
    this.handle = opus().opus_encoder_create(sampleRate, channels, application, ptr(err));
    if (!this.handle || err[0] !== 0) throw new Error(`opus_encoder_create failed (${err[0]})`);
  }

  encode(pcm: Int16Array): Uint8Array {
    const n = check(
      opus().opus_encode(
        this.handle,
        ptr(pcm),
        pcm.length / this.channels,
        ptr(this.out),
        this.out.length,
      ),
      "opus_encode",
    );
    return this.out.slice(0, n);
  }

  destroy(): void {
    if (this.handle) opus().opus_encoder_destroy(this.handle);
    this.handle = null;
  }
}
