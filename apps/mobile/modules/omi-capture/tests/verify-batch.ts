// Decodes the Swift-encoded batch with the server's TypeScript decoder and checks every field.
import { decodeAudioBatch } from "../../../../../packages/shared/src/ingest";

const file = process.argv[2] ?? "/tmp/hl-swift-batch.bin";
const batch = decodeAudioBatch(new Uint8Array(await Bun.file(file).arrayBuffer()));
let bad = 0;
if (batch.slot !== 3) bad++;
batch.frames.forEach((f, i) => {
  const at = 1_760_000_000_000 + i * 20 + (i >= 25 ? 100 : 0);
  const data = Array.from({ length: 10 + i }, (_, j) => (j * 7 + i) & 0xff);
  if (
    f.seq !== 7000 + i ||
    f.at !== at ||
    f.data.length !== data.length ||
    f.data.some((b, j) => b !== data[j])
  )
    bad++;
});
if (batch.frames.length !== 50) bad++;
if (bad) {
  console.error(`ts: ${bad} mismatch(es) decoding the Swift batch`);
  process.exit(1);
}
console.log("ts: Swift batch decodes identically (50 frames, slot 3)");
