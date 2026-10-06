// macOS test harness for the platform-independent parts of the capture module.
// Run: ./run-tests.sh
import Foundation

var failures = 0
func check(_ cond: @autoclosure () -> Bool, _ msg: String, line: Int = #line) {
  if !cond() { failures += 1; print("FAIL (line \(line)): \(msg)") }
}

let root = FileManager.default.temporaryDirectory.appendingPathComponent("hl-journal-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: root) }

// --- journal: rotation, disk reads beyond the in-memory tail, trim, reload ---
do {
  let j = FrameJournal(root: root)
  let meta = StreamMeta(id: "s1", codec: 21, sampleRate: 16000, frameMs: 20, startedAt: 1_000, endedAt: nil, wearable: nil)
  j.create(meta)
  for i in 0..<3100 {
    j.append("s1", at: Int64(1_000 + i * 20), data: Data([0xB8, UInt8(i & 0xFF), UInt8((i >> 8) & 0xFF)]))
  }
  check(j.nextSeq("s1") == 3100, "nextSeq")
  let early = j.frames("s1", from: 0, max: 100)
  check(early.count == 100 && early.first?.seq == 0 && early.last?.seq == 99, "disk read of early frames")
  check(early[42].data == Data([0xB8, 42, 0]) && early[42].at == 1_000 + 42 * 20, "frame payload/time")
  let span = j.frames("s1", from: 1490, max: 20)
  check(span.map(\.seq) == Array(1490..<1510).map(Int64.init), "read across segment boundary")
  let live = j.frames("s1", from: 3090, max: 100)
  check(live.count == 10 && live.last?.seq == 3099, "tail read")

  j.trim("s1", through: 1600)
  let segs = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("s1").path)
    .filter { $0.hasSuffix(".seg") }.sorted()
  check(segs.count == 2 && segs.first == String(format: "%020lld.seg", 1500), "trim removes fully acked segments: \(segs)")
  check(j.frames("s1", from: 1601, max: 5).first?.seq == 1601, "read after trim")
  check(j.unacked("s1") == 3100 - 1601, "unacked after trim (\(j.unacked("s1")))")

  // A stream whose meta can't be read keeps its audio on disk; an empty leftover dir is cleaned up.
  let fm = FileManager.default
  let bad = root.appendingPathComponent("bad")
  try fm.createDirectory(at: bad, withIntermediateDirectories: true)
  try Data("{".utf8).write(to: bad.appendingPathComponent("meta.json"))
  try FrameJournal.encode([Frame(seq: 0, at: 1, data: Data([1]))]).write(to: bad.appendingPathComponent(String(format: "%020lld.seg", 0)))
  let empty = root.appendingPathComponent("empty")
  try fm.createDirectory(at: empty, withIntermediateDirectories: true)

  // Simulate a crash/relaunch: a new journal instance must find the stream and close it.
  let j2 = FrameJournal(root: root)
  check(j2.nextSeq("s1") == 3100, "reload nextSeq (\(j2.nextSeq("s1")))")
  check(j2.meta("s1")?.endedAt == 1_000 + 3099 * 20, "reloaded stream is ended at its last frame")
  check(j2.frames("s1", from: 3000, max: 200).count == 100, "reload reads frames from disk")
  // At launch the ack inside the oldest segment is unknown: count from its start (1500).
  check(j2.unacked("s1") == 3100 - 1500, "unacked after reload (\(j2.unacked("s1")))")
  check(!j2.streamIds.contains("bad") && fm.fileExists(atPath: bad.path), "unreadable meta is kept, not loaded")
  check(!fm.fileExists(atPath: empty.path), "empty stream dir removed")
  j2.remove("s1")
  check(j2.streamIds.isEmpty, "remove")
} catch {
  failures += 1
  print("FAIL: \(error)")
}

// --- batch codec: export a batch for the TypeScript decoder to verify ---
var frames: [Frame] = []
for i in 0..<50 {
  let gap: Int64 = i >= 25 ? 100 : 0
  let at: Int64 = 1_760_000_000_000 + Int64(i) * 20 + gap
  var bytes: [UInt8] = []
  for j in 0..<(10 + i) { bytes.append(UInt8((j * 7 + i) & 0xFF)) }
  frames.append(Frame(seq: Int64(7_000 + i), at: at, data: Data(bytes)))
}
let batch = BatchCodec.encode(slot: 3, frames: frames)
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/hl-swift-batch.bin"
try batch.write(to: URL(fileURLWithPath: out))
print("wrote \(batch.count)-byte batch to \(out)")

if failures > 0 { print("\(failures) failure(s)"); exit(1) }
print("swift: all checks passed")
