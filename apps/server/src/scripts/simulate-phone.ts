/**
 * Pretend to be the iOS app: sign in, register a phone, stream synthetic Omi audio over
 * the ingest socket (with a mic-sleep gap and a reconnect + resend), and print acks.
 *
 *   HEARLOOM_EMAIL=... HEARLOOM_PASSWORD=... pnpm --filter @hearloom/server simulate-phone [--seconds 20]
 */
import { parseArgs } from "node:util";
import type { Contract } from "@hearloom/api";
import { OpusEncoder } from "@hearloom/audio";
import {
  type AudioFrame,
  encodeAudioBatch,
  INGEST_PROTOCOL_VERSION,
  OMI_CODEC,
  type ServerMessage,
} from "@hearloom/shared";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    url: { type: "string", default: process.env.PUBLIC_URL ?? "http://localhost:3000" },
    seconds: { type: "string", default: "20" },
    /** Stream these 16 kHz mono 16-bit WAV files (in order) instead of synthetic tones. */
    wav: { type: "string", multiple: true },
    /** Pace frames in real time (needed to exercise live transcription with Soniox). */
    realtime: { type: "boolean", default: false },
  },
});
const base = values.url!;
const email = process.env.HEARLOOM_EMAIL;
const password = process.env.HEARLOOM_PASSWORD;
if (!email || !password) throw new Error("set HEARLOOM_EMAIL and HEARLOOM_PASSWORD");

const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({ email, password }),
});
const token = signIn.headers.get("set-auth-token");
if (!signIn.ok || !token)
  throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
const auth = { authorization: `Bearer ${token}` };

const rpc: ContractRouterClient<Contract> = createORPCClient(
  new RPCLink({ url: `${base}/rpc`, headers: () => auth }),
);
// Reuse one simulated phone across runs.
const phoneFile = Bun.file(
  `${process.env.DATA_DIR ?? `${import.meta.dir}/../../../../data`}/simulator-phone-id`,
);
const knownPhone = (await phoneFile.exists()) ? (await phoneFile.text()).trim() : undefined;
const { phoneId } = await rpc.phones.register({
  ...(knownPhone ? { id: knownPhone } : {}),
  name: "Simulated iPhone",
  model: "simulator",
  appVersion: "sim",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
await Bun.write(phoneFile, phoneId);
console.log("phone", phoneId);

/** Read a 16 kHz mono 16-bit PCM WAV file. */
async function readWav(path: string): Promise<Int16Array> {
  const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
  const view = new DataView(buf.buffer);
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = new TextDecoder().decode(buf.subarray(o, o + 4));
    const size = view.getUint32(o + 4, true);
    if (id === "fmt ") {
      const channels = view.getUint16(o + 10, true);
      const rate = view.getUint32(o + 12, true);
      const bits = view.getUint16(o + 22, true);
      if (channels !== 1 || rate !== 16000 || bits !== 16) {
        throw new Error(`${path}: need 16 kHz mono 16-bit (afconvert -f WAVE -d LEI16@16000 -c 1)`);
      }
    }
    if (id === "data") return new Int16Array(buf.buffer.slice(o + 8, o + 8 + size));
    o += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

const enc = new OpusEncoder(16000, 1);
const frames: AudioFrame[] = [];
let seq = 0;
if (values.wav?.length) {
  // Clips separated by 0.8 s of quiet, as one continuous recording.
  const parts: Int16Array[] = [];
  for (const path of values.wav) parts.push(await readWav(path), new Int16Array(12_800));
  const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    pcm.set(p, o);
    o += p.length;
  }
  const n = Math.floor(pcm.length / 320);
  const t0 = Date.now() - (values.realtime ? 0 : n * 20 + 1000);
  for (let i = 0; i < n; i++) {
    frames.push({
      seq: seq++,
      at: t0 + i * 20,
      data: enc.encode(pcm.subarray(i * 320, (i + 1) * 320)),
    });
  }
} else {
  // Synthesize speech-like audio: a few tones with syllable-ish amplitude modulation.
  const secs = Number(values.seconds);
  const t0 = Date.now() - secs * 1000 - 15_000;
  for (let i = 0; i < secs * 50; i++) {
    // 15 s mic-sleep gap halfway through (the Omi stops sending during silence).
    const at = t0 + i * 20 + (i >= (secs * 50) / 2 ? 15_000 : 0);
    const pcm = new Int16Array(320);
    for (let s = 0; s < 320; s++) {
      const t = (i * 320 + s) / 16000;
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
      pcm[s] = Math.round(
        6000 * env * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t)),
      );
    }
    frames.push({ seq: seq++, at, data: enc.encode(pcm) });
  }
}
enc.destroy();
const start = frames[0]!.at;
const seconds = (frames.length * 20) / 1000;

const streamId = crypto.randomUUID();
const wsUrl = `${base.replace(/^http/, "ws")}/ingest`;

async function session(fromSeq: number, limit: number): Promise<number> {
  const ws = new WebSocket(wsUrl, { headers: auth } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  let acked = -1;
  const done = new Promise<void>((resolve, reject) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.t === "welcome") {
        console.log(
          `welcome: server has up to seq ${msg.ackedSeq}; button config`,
          msg.config.button,
        );
        const pending = frames.filter((f) => f.seq > msg.ackedSeq).slice(0, limit);
        if (values.realtime) {
          // One batch per second of audio, like the phone.
          void (async () => {
            for (let i = 0; i < pending.length; i += 50) {
              const batch = pending.slice(i, i + 50);
              const wait = batch[batch.length - 1]!.at - Date.now();
              if (wait > 0) await Bun.sleep(wait);
              ws.send(encodeAudioBatch(0, batch));
            }
          })();
        } else {
          for (let i = 0; i < pending.length; i += 50)
            ws.send(encodeAudioBatch(0, pending.slice(i, i + 50)));
        }
        if (pending.length === 0) resolve();
      } else if (msg.t === "ack") {
        acked = msg.seq;
        const target = Math.min(frames.length - 1, fromSeq + limit - 1);
        if (acked >= target) resolve();
      } else if (msg.t === "error") {
        reject(new Error(`${msg.code}: ${msg.message}`));
      } else {
        console.log("server:", msg);
      }
    };
    ws.onerror = (e) => reject(e);
  });
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  ws.send(
    JSON.stringify({
      t: "hello",
      v: INGEST_PROTOCOL_VERSION,
      slot: 0,
      phoneId,
      stream: {
        id: streamId,
        codec: OMI_CODEC.OPUS_16K_20MS,
        sampleRate: 16000,
        frameMs: 20,
        startedAt: start,
      },
      wearable: {
        peripheralId: "SIM-PERIPHERAL",
        name: "Omi",
        model: "Omi CV 1",
        firmware: "3.0.21",
        battery: 82,
      },
    }),
  );
  await done;
  ws.close();
  return acked;
}

console.log(`streaming ${frames.length} frames (${seconds}s) on stream ${streamId}`);
if (values.realtime) {
  const a = await session(0, frames.length);
  console.log(`acked through seq ${a}`);
} else {
  const half = Math.floor(frames.length / 2) + 37;
  const a1 = await session(0, half);
  console.log(`first connection acked through seq ${a1}; reconnecting...`);
  const a2 = await session(a1 + 1, frames.length);
  console.log(`second connection acked through seq ${a2}`);
}

// Let the server close the idle chunk, then list what it stored.
await Bun.sleep(Number(process.env.CHUNK_IDLE_MS ?? 8000) + 1500);
const timeline = await rpc.timeline.range({ from: new Date(start - 1000), to: new Date() });
for (const c of timeline.chunks) {
  console.log(`chunk ${c.startAt.toISOString()} ${c.durationMs}ms ${c.byteSize}B ${base}${c.url}`);
}
const status = await rpc.status.live();
console.log("wearables:", status.wearables.map((w) => `${w.name} ${w.batteryLevel}%`).join(", "));
