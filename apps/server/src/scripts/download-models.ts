/**
 * Download the local models used by the live pipeline into MODELS_DIR (default DATA_DIR/models).
 *   pnpm --filter @hearloom/server download-models [--all]
 * Default set: VAD, sound tagging, speaker embeddings. `--all` adds pyannote segmentation
 * (offline diarization fallback).
 *
 * Archives are streamed straight into `tar` (no temp file), extracting only the files we use, so
 * the progress bar covers download and extraction together.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { modelsDir } from "../env";

const SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
/** Give up on an attempt when no data arrives for this long. */
const STALL_MS = 30_000;
const ATTEMPTS = 3;

interface Model {
  name: string;
  url: string;
  /** Path (relative to the models dir) that exists once installed. */
  check: string;
  /** Approximate download size, for the plan shown before starting. */
  mb: number;
  /** A .tar.bz2: extract only these paths (relative to the models dir). */
  archive?: string[];
  optional?: boolean;
}

const CED = "sherpa-onnx-ced-base-audio-tagging-2024-04-19";
const PYANNOTE = "sherpa-onnx-pyannote-segmentation-3-0";
const MODELS: Model[] = [
  {
    name: "Silero VAD v6",
    url: "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
    check: "silero_vad_v6.onnx",
    mb: 2,
  },
  {
    name: "CED-base audio tagging (AudioSet, 527 classes)",
    url: `${SHERPA}/audio-tagging-models/${CED}.tar.bz2`,
    check: `${CED}/model.int8.onnx`,
    mb: 387,
    // The archive also has the fp32 model (~330 MB) and test WAVs; we only run the int8 model.
    archive: [`${CED}/model.int8.onnx`, `${CED}/class_labels_indices.csv`],
  },
  {
    name: "3D-Speaker CAM++ speaker embeddings (zh+en)",
    url: `${SHERPA}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
    check: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    mb: 28,
  },
  {
    name: "pyannote segmentation 3.0",
    url: `${SHERPA}/speaker-segmentation-models/${PYANNOTE}.tar.bz2`,
    check: `${PYANNOTE}/model.onnx`,
    mb: 7,
    archive: [`${PYANNOTE}/model.onnx`],
    optional: true,
  },
];

// ---- output -----------------------------------------------------------------------------------

const tty = process.stdout.isTTY;
const mb = (bytes: number) => (bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** One progress line, redrawn in place on a terminal; every 10 % otherwise (logs, CI). */
class Progress {
  private readonly started = Date.now();
  private lastDraw = 0;
  private lastDecile = -1;

  constructor(private readonly total: number | null) {}

  update(done: number, final = false): void {
    const now = Date.now();
    const secs = (now - this.started) / 1000;
    const rate = done / Math.max(secs, 0.001);
    const pct = this.total ? Math.min(100, (done / this.total) * 100) : null;
    let line = `  ${mb(done)}${this.total ? ` / ${mb(this.total)}` : ""} MB`;
    if (pct !== null) line = `  ${bar(pct)} ${pct.toFixed(0).padStart(3)}%${line}`;
    line += `  ${mb(rate)} MB/s`;
    if (this.total && rate > 0 && !final) line += `  ETA ${clock((this.total - done) / rate)}`;
    if (tty) {
      if (!final && now - this.lastDraw < 100) return;
      this.lastDraw = now;
      process.stdout.write(`\r\x1b[2K${line}`);
      if (final) process.stdout.write("\n");
    } else if (pct !== null) {
      const decile = Math.floor(pct / 10);
      // 100 % is printed by the final update (with the average speed, no ETA).
      if ((decile > this.lastDecile && pct < 100) || final) {
        this.lastDecile = decile;
        console.log(line);
      }
    } else if (final) console.log(line);
  }

  clear(): void {
    if (tty) process.stdout.write("\r\x1b[2K");
  }
}

function bar(pct: number, width = 24): string {
  const full = Math.round((pct / 100) * width);
  return `[${"#".repeat(full)}${"-".repeat(width - full)}]`;
}

async function sizeOf(path: string): Promise<number> {
  const s = await stat(path);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const e of await readdir(path)) total += await sizeOf(join(path, e));
  return total;
}

// ---- download ---------------------------------------------------------------------------------

/** Temp paths to remove if we're interrupted. */
const temps = new Set<string>();
process.on("SIGINT", () => {
  if (tty) process.stdout.write("\n");
  console.log("interrupted; cleaning up partial downloads");
  for (const t of temps) Bun.spawnSync(["rm", "-rf", t]);
  process.exit(130);
});

/** Stream `url` into `sink`, drawing progress; aborts if the connection stalls. */
async function stream(url: string, sink: (chunk: Uint8Array) => Promise<void>): Promise<void> {
  const abort = new AbortController();
  let timer = setTimeout(() => abort.abort(), STALL_MS);
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(), STALL_MS);
  };
  try {
    const res = await fetch(url, { redirect: "follow", signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || null;
    const progress = new Progress(total);
    let done = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      kick();
      await sink(value);
      done += value.length;
      progress.update(done);
    }
    progress.update(done, true);
  } catch (err) {
    if (abort.signal.aborted)
      throw new Error(`no data for ${STALL_MS / 1000} s (connection stalled)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFile(m: Model, dir: string): Promise<void> {
  const tmp = join(dir, `.download-${process.pid}-${Date.now()}`);
  temps.add(tmp);
  try {
    const out = Bun.file(tmp).writer();
    await stream(m.url, async (chunk) => {
      out.write(chunk);
      await out.flush();
    });
    await out.end();
    await rename(tmp, join(dir, m.check));
  } finally {
    temps.delete(tmp);
    await rm(tmp, { force: true });
  }
}

/** Download and extract in one pass: the response is piped into tar's stdin. */
async function downloadArchive(m: Model, dir: string): Promise<void> {
  // Extract into a temp dir, then move into place, so a failed attempt leaves nothing behind.
  const tmp = join(dir, `.extract-${process.pid}-${Date.now()}`);
  temps.add(tmp);
  try {
    await mkdir(tmp, { recursive: true });
    const tar = Bun.spawn(["tar", "-xjf", "-", "-C", tmp, ...(m.archive ?? [])], {
      stdin: "pipe",
      stderr: "pipe",
    });
    try {
      await stream(m.url, async (chunk) => {
        tar.stdin.write(chunk);
        await tar.stdin.flush(); // backpressure: decompression can be slower than the network
      });
    } finally {
      await tar.stdin.end();
    }
    if ((await tar.exited) !== 0)
      throw new Error(`tar failed: ${(await new Response(tar.stderr).text()).trim()}`);
    const top = m.check.split("/")[0]!;
    await rm(join(dir, top), { recursive: true, force: true });
    await rename(join(tmp, top), join(dir, top));
  } finally {
    temps.delete(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---- main -------------------------------------------------------------------------------------

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { all: { type: "boolean", default: false } },
});
const dir = modelsDir;
await mkdir(dir, { recursive: true });

const wanted = MODELS.filter((m) => !m.optional || values.all);
const missing = wanted.filter((m) => !existsSync(join(dir, m.check)));
console.log(`Models → ${dir}`);
for (const m of wanted) {
  const have = !missing.includes(m);
  console.log(`  ${have ? "✓" : "·"} ${m.name}${have ? "" : `  (~${m.mb} MB)`}`);
}
if (missing.length === 0) {
  console.log("All models are installed.");
  process.exit(0);
}
const totalMb = missing.reduce((n, m) => n + m.mb, 0);
console.log(`Downloading ${missing.length} model(s), ~${totalMb} MB in total.\n`);

const started = Date.now();
for (const [i, m] of missing.entries()) {
  console.log(`[${i + 1}/${missing.length}] ${m.name}`);
  console.log(`  ${m.url}`);
  if (m.archive) console.log("  downloading and extracting (only the files Hearloom uses)");
  const t0 = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await (m.archive ? downloadArchive(m, dir) : downloadFile(m, dir));
      break;
    } catch (err) {
      new Progress(null).clear();
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= ATTEMPTS) {
        console.error(`  ✗ failed after ${ATTEMPTS} attempts: ${msg}`);
        console.error("  Run the command again to retry; installed models are kept.");
        process.exit(1);
      }
      console.log(`  ! attempt ${attempt} failed: ${msg}; retrying in ${attempt * 2} s`);
      await Bun.sleep(attempt * 2000);
    }
  }
  if (!existsSync(join(dir, m.check))) {
    console.error(`  ✗ expected ${m.check} after install`);
    process.exit(1);
  }
  const top = m.check.split("/")[0]!;
  const onDisk = await sizeOf(join(dir, top));
  console.log(`  ✓ done in ${clock((Date.now() - t0) / 1000)}, ${mb(onDisk)} MB on disk\n`);
}
console.log(`All models installed in ${clock((Date.now() - started) / 1000)} → ${dir}`);
