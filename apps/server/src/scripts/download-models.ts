/**
 * Download the local models used by the live pipeline into DATA_DIR/models.
 *   pnpm --filter @hearloom/server download-models [--all]
 * Default set: VAD, sound tagging, speaker embeddings. `--all` adds Parakeet v3 (local ASR) and
 * pyannote segmentation (offline diarization fallback).
 */
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { env } from "../env";

const SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

interface Model {
  name: string;
  url: string;
  /** Path (relative to the models dir) that exists once installed. */
  check: string;
  /** Archives are extracted into the models dir. */
  archive?: boolean;
  optional?: boolean;
}

const MODELS: Model[] = [
  {
    name: "Silero VAD v6",
    url: "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
    check: "silero_vad_v6.onnx",
  },
  {
    name: "CED-base audio tagging (AudioSet, 527 classes)",
    url: `${SHERPA}/audio-tagging-models/sherpa-onnx-ced-base-audio-tagging-2024-04-19.tar.bz2`,
    check: "sherpa-onnx-ced-base-audio-tagging-2024-04-19/model.int8.onnx",
    archive: true,
  },
  {
    name: "3D-Speaker CAM++ speaker embeddings (zh+en)",
    url: `${SHERPA}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
    check: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
  },
  {
    name: "Parakeet TDT 0.6B v3 (local ASR, 25 EU languages)",
    url: `${SHERPA}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    check: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx",
    archive: true,
    optional: true,
  },
  {
    name: "pyannote segmentation 3.0",
    url: `${SHERPA}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    check: "sherpa-onnx-pyannote-segmentation-3-0/model.onnx",
    archive: true,
    optional: true,
  },
];

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { all: { type: "boolean", default: false } },
});
const dir = join(env.DATA_DIR, "models");
await mkdir(dir, { recursive: true });

for (const m of MODELS) {
  if (m.optional && !values.all) continue;
  if (existsSync(join(dir, m.check))) {
    console.log(`✓ ${m.name}`);
    continue;
  }
  console.log(`↓ ${m.name}\n  ${m.url}`);
  const res = await fetch(m.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${m.url}`);
  const tmp = join(dir, `.download-${Date.now()}`);
  await Bun.write(tmp, res);
  if (m.archive) {
    await Bun.$`tar -xjf ${tmp} -C ${dir}`;
    await rm(tmp);
  } else {
    await rename(tmp, join(dir, m.check));
  }
  if (!existsSync(join(dir, m.check)))
    throw new Error(`${m.name}: expected ${m.check} after install`);
  console.log(`✓ ${m.name}`);
}
console.log(`models in ${dir}`);
