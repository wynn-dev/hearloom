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
const { phoneId } = await rpc.phones.register({
  name: "Simulated iPhone",
  model: "simulator",
  appVersion: "sim",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
console.log("phone", phoneId);

// Synthesize speech-like audio: a few tones with syllable-ish amplitude modulation.
const enc = new OpusEncoder(16000, 1);
const seconds = Number(values.seconds);
const start = Date.now() - seconds * 1000 - 15_000;
const frames: AudioFrame[] = [];
let seq = 0;
for (let i = 0; i < seconds * 50; i++) {
  // 15 s mic-sleep gap halfway through (the Omi stops sending during silence).
  const at = start + i * 20 + (i >= (seconds * 50) / 2 ? 15_000 : 0);
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
enc.destroy();

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
        for (let i = 0; i < pending.length; i += 50) {
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

const half = Math.floor(frames.length / 2) + 37;
console.log(`streaming ${frames.length} frames (${seconds}s) on stream ${streamId}`);
const a1 = await session(0, half);
console.log(`first connection acked through seq ${a1}; reconnecting...`);
const a2 = await session(a1 + 1, frames.length);
console.log(`second connection acked through seq ${a2}`);

// Let the server close the idle chunk, then list what it stored.
await Bun.sleep(Number(process.env.CHUNK_IDLE_MS ?? 8000) + 1500);
const timeline = await rpc.timeline.range({ from: new Date(start - 1000), to: new Date() });
for (const c of timeline.chunks) {
  console.log(`chunk ${c.startAt.toISOString()} ${c.durationMs}ms ${c.byteSize}B ${base}${c.url}`);
}
const status = await rpc.status.live();
console.log("wearables:", status.wearables.map((w) => `${w.name} ${w.batteryLevel}%`).join(", "));
