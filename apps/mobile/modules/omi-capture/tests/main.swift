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

// --- offline storage: firmware packing (transport.c write_to_storage) → BLE chunks → parser ---
do {
    var rng = SystemRandomNumberGenerator()
    var temp = [UInt8](repeating: 0, count: 440)
    var bufferOffset = 0
    var records: [Data] = []
    var flushed: [(data: Data, at: Int64)] = []
    var pending: [(data: Data, at: Int64)] = []
    let t0: Int64 = 1_760_000_000_000
    func writeRecord(_ nowMs: Int64) {
        var r = Data()
        var ts = UInt32(nowMs / 1000).bigEndian
        withUnsafeBytes(of: &ts) { r.append(contentsOf: $0) }
        r.append(contentsOf: temp)
        records.append(r)
        flushed.append(contentsOf: pending)
        pending = []
    }
    for i in 0..<600 {
        let len = Int.random(in: 40...120, using: &rng)
        let frame = Data((0..<len).map { _ in UInt8.random(in: 0...255, using: &rng) })
        let at = t0 + Int64(i) * 20
        let packetSize = len + 1
        if bufferOffset + packetSize > 439 {
            temp[bufferOffset] = UInt8(len)
            writeRecord(at)
            bufferOffset = packetSize
            temp[0] = UInt8(len)
            temp.replaceSubrange(1..<(1 + len), with: frame)
            pending = [(frame, at)]
        } else if bufferOffset + packetSize == 439 {
            temp[bufferOffset] = UInt8(len)
            temp.replaceSubrange((bufferOffset + 1)..<(bufferOffset + 1 + len), with: frame)
            pending.append((frame, at))
            bufferOffset = 0
            writeRecord(at)
        } else {
            temp[bufferOffset] = UInt8(len)
            temp.replaceSubrange((bufferOffset + 1)..<(bufferOffset + 1 + len), with: frame)
            bufferOffset += packetSize
            pending.append((frame, at))
        }
    }
    // Ship as DATA notifications of random sizes (MTU-dependent).
    let all = records.reduce(Data(), +)
    var parser = OfflineRecordParser()
    var clock = OfflineClock(frameMs: 20)
    var got: [(Data, Int64)] = []
    var o = 0
    while o < all.count {
        let n = min(all.count - o, Int.random(in: 20...240, using: &rng))
        let note = Data([0x03]) + all.subdata(in: o..<(o + n))
        guard case .data(let chunk) = StorageNotification.parse(note) else { check(false, "data parse"); break }
        for record in parser.push(chunk) {
            let (ts, frames) = OfflineRecordParser.parse(record)
            let times = clock.stamp(recordSeconds: ts, frames: frames.count)
            got.append(contentsOf: zip(frames, times))
        }
        o += n
    }
    check(parser.pendingBytes == 0, "no leftover bytes")
    check(got.count == flushed.count, "offline frame count \(got.count) vs \(flushed.count)")
    check(zip(got, flushed).allSatisfy { $0.0 == $1.data }, "offline frame bytes match")
    let maxSkew = zip(got, flushed).map { abs($0.1 - $1.at) }.max() ?? 0
    check(maxSkew <= 1100, "offline timestamps within ~1 s (max skew \(maxSkew) ms)")
    if case .info(let r, let w, _, _) = StorageNotification.parse(Data([0x02, 0,0,0,0,0,0,0,5, 0,0,0,0,0,0,0,9] + [UInt8](repeating: 0, count: 14))) {
        check(r == 5 && w == 9, "info parse")
    } else { check(false, "info parse") }
    check(StorageCommand.read(from: 258) == Data([0x11, 0,0,0,0,0,0,1,2]), "read command encoding")
    check(StorageCommand.advance(to: 258) == Data([0x12, 0,0,0,0,0,0,1,2]), "advance command encoding")
    check(StorageCommand.stop() == Data([0x03]), "stop command encoding")
    check(OfflineRecordParser.recordSeconds(records[0]) == OfflineRecordParser.parse(records[0]).timestamp, "record seconds")
    print("offline: \(records.count) records, \(got.count) frames, max skew \(maxSkew) ms")
}

// --- journal: raw offline records outlive their uploaded stream ---
do {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("hl-raw-\(UUID().uuidString)")
    let j = FrameJournal(root: base.appendingPathComponent("journal"))
    j.create(StreamMeta(id: "off", codec: 21, sampleRate: 16000, frameMs: 20, startedAt: 1, endedAt: 2, wearable: nil))
    j.appendRaw("off", Data(repeating: 7, count: 444))
    j.remove("off")
    let archived = base.appendingPathComponent("offline-raw/off.bin")
    check((try? Data(contentsOf: archived))?.count == 444, "raw records archived on remove")
    check(!FileManager.default.fileExists(atPath: base.appendingPathComponent("journal/off").path), "stream dir removed")
    try? FileManager.default.removeItem(at: base)
}

// --- journal: backlog reads reuse the decoded segment ---
do {
  let base = FileManager.default.temporaryDirectory.appendingPathComponent("hl-cache-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: base) }
  let j = FrameJournal(root: base)
  j.create(StreamMeta(id: "c", codec: 21, sampleRate: 16000, frameMs: 20, startedAt: 0, endedAt: nil, wearable: nil))
  for i in 0..<4600 { j.append("c", at: Int64(i * 20), data: Data([UInt8(i & 0xFF)])) }
  // Frames 0..1599 are older than the in-memory tail: they come from disk.
  check(j.frames("c", from: 0, max: 100).map(\.seq) == Array(0..<100).map(Int64.init), "first disk batch")
  // Clobber the first segment on disk: further reads of it must come from the decoded copy.
  let seg0 = base.appendingPathComponent("c").appendingPathComponent(String(format: "%020lld.seg", 0))
  try Data().write(to: seg0)
  let again = j.frames("c", from: 100, max: 100)
  check(again.map(\.seq) == Array(100..<200).map(Int64.init) && again[5].data == Data([105]), "cached segment read")
  let across = j.frames("c", from: 1450, max: 100)
  check(across.map(\.seq) == Array(1450..<1550).map(Int64.init), "cached read across a segment boundary")
  j.trim("c", through: 1549)
  check(j.frames("c", from: 1550, max: 100).map(\.seq) == Array(1550..<1650).map(Int64.init), "read after trim")
} catch {
  failures += 1
  print("FAIL: \(error)")
}

// --- haptic sequences: spacing, waiting for the pendant, TTL, acks ---
do {
  func seq(_ id: String, _ pulses: [UInt8], interval: Int64 = 350, expiresAt: Int64 = 100_000) -> HapticSequence {
    HapticSequence(id: id, pulses: pulses, intervalMs: interval, expiresAt: expiresAt)
  }
  var writes: [(at: Int64, pattern: UInt8)] = []
  var now: Int64 = 1_000
  let writer: (UInt8) -> Bool = { writes.append((now, $0)); return true }

  // Parsing: pattern names, at most 5 pulses, TTL from receipt.
  let parsed = HapticSequence(
    message: ["t": "haptic_seq", "id": "a", "pulses": ["short", "medium", "long", "short", "short", "long"],
              "intervalMs": 250, "ttlMs": 4000], receivedAt: 500)
  check(parsed == seq("a", [1, 2, 3, 1, 1], interval: 250, expiresAt: 4500), "parse haptic_seq: \(String(describing: parsed))")
  check(HapticSequence(message: ["t": "haptic_seq", "id": "b", "pulses": []], receivedAt: 0) == nil, "no pulses")
  check(HapticSequence(message: ["t": "haptic_seq", "pulses": ["short"]], receivedAt: 0) == nil, "no id")
  check(HapticOutcome.expired("x").json["reason"] as? String == "expired", "ack json")
  check(HapticOutcome.played("x").json["played"] as? Bool == true && HapticOutcome.played("x").json["reason"] == nil, "played ack json")

  // Ready pendant: pulses start-to-start exactly intervalMs apart, ack after the last write.
  var q = HapticQueue()
  check(q.add(seq("s1", [1, 2, 3])).isEmpty, "add")
  var outcomes = q.run(now: now, write: writer)
  check(writes.map(\.pattern) == [1] && outcomes.isEmpty, "first pulse right away")
  check(q.nextWakeAt(ready: true) == 1_350, "next pulse at +interval")
  // A late timer still writes only one pulse, then spaces the next a full interval from it.
  now = 1_500
  outcomes = q.run(now: now, write: writer)
  check(writes.map(\.pattern) == [1, 2] && q.nextWakeAt(ready: true) == 1_850, "late tick doesn't bunch")
  now = 1_850
  outcomes = q.run(now: now, write: writer)
  check(writes.map(\.pattern) == [1, 2, 3] && outcomes == [.played("s1")], "played ack after last pulse")
  check(q.nextWakeAt(ready: true) == nil, "idle")

  // No pendant: held (at most 3), played when it's ready, the oldest pushed out with no_pendant.
  writes = []
  var h = HapticQueue()
  _ = h.add(seq("h1", [1], expiresAt: 10_000))
  _ = h.add(seq("h2", [3], expiresAt: 10_000))
  _ = h.add(seq("h3", [2], expiresAt: 10_000))
  check(h.add(seq("h4", [1, 1], interval: 100, expiresAt: 10_000)) == [.noPendant("h1")], "queue bound")
  now = 2_000
  check(h.run(now: now, write: nil).isEmpty && writes.isEmpty, "held while no pendant")
  check(h.nextWakeAt(ready: false) == 10_000, "wake for TTL while waiting")
  now = 3_000
  outcomes = h.run(now: now, write: writer)
  check(writes.map(\.pattern) == [3] && outcomes == [.played("h2")], "plays once ready")
  // Long pulse (500 ms) + 600 ms of stillness before the next sequence.
  check(h.nextWakeAt(ready: true) == 4_100, "next sequence waits for the last pulse to end + stillness")
  now = 4_099
  check(h.run(now: now, write: writer).isEmpty && writes.count == 1, "not before the stillness")
  now = 4_100
  outcomes = h.run(now: now, write: writer)
  check(writes.map(\.pattern) == [3, 2] && outcomes == [.played("h3")], "second held sequence")
  now = 5_000 // medium (300 ms) + 600
  outcomes = h.run(now: now, write: writer)
  check(writes.map(\.pattern) == [3, 2, 1] && outcomes.isEmpty, "third starts")
  // The pendant goes away mid-sequence: no_pendant, nothing replayed later.
  now = 5_100
  outcomes = h.run(now: now, write: { _ in false })
  check(outcomes == [.noPendant("h4")] && h.held.isEmpty && h.nextWakeAt(ready: true) == nil, "lost mid-sequence")

  // Two queued sequences ("heard" then "failed"): each keeps its own spacing, with stillness between
  // them, so they're felt as 1 + 3 rather than 4 even taps.
  writes = []
  var two = HapticQueue()
  _ = two.add(seq("heard", [1], interval: 250, expiresAt: 20_000))
  _ = two.add(seq("failed", [1, 1, 1], interval: 250, expiresAt: 20_000))
  var acks2: [HapticOutcome] = []
  now = 10_000
  var steps = 0
  while let at = two.nextWakeAt(ready: true), steps < 20 { // drive it like the player's timer does
    now = max(now, at)
    acks2 += two.run(now: now, write: writer)
    steps += 1
  }
  check(writes.map(\.at) == [10_000, 10_700, 10_950, 11_200], "two sequences: \(writes.map(\.at))")
  check(acks2 == [.played("heard"), .played("failed")], "two sequences acked in order: \(acks2)")

  // A pendant that can't buzz ends everything at once.
  var none = HapticQueue()
  _ = none.add(seq("n1", [1]))
  _ = none.add(seq("n2", [2]))
  check(none.dropAll() == [.noPendant("n1"), .noPendant("n2")] && none.nextWakeAt(ready: true) == nil, "dropAll")
  check(HapticSequence.durationMs(1) == 100 && HapticSequence.durationMs(2) == 300 && HapticSequence.durationMs(3) == 500, "pulse durations")

  // TTL: a sequence that can't start in time is dropped as expired.
  var t = HapticQueue()
  _ = t.add(seq("t1", [1], expiresAt: 5_000))
  check(t.run(now: 4_999, write: nil).isEmpty, "not yet expired")
  check(t.run(now: 5_000, write: nil) == [.expired("t1")] && t.held.isEmpty, "expired")
  // Also while waiting behind another sequence.
  writes = []
  now = 6_000
  _ = t.add(seq("t2", [1, 1, 1], interval: 500))
  _ = t.add(seq("t3", [2], expiresAt: 6_600))
  _ = t.run(now: now, write: writer)
  now = 6_500
  _ = t.run(now: now, write: writer)
  now = 7_000
  check(t.run(now: now, write: writer) == [.expired("t3"), .played("t2")], "expired while queued")

  // Real timing through the player's own queue.
  let lock = NSLock()
  var stamps: [Int64] = []
  var acks: [HapticOutcome] = []
  let done = DispatchSemaphore(value: 0)
  let player = HapticPlayer { outcome in
    lock.lock(); acks.append(outcome); lock.unlock()
    done.signal()
  }
  player.play(HapticSequence(id: "rt", pulses: [1, 2, 3], intervalMs: 150, expiresAt: HapticPlayer.now() + 5_000))
  Thread.sleep(forTimeInterval: 0.1) // no pendant yet: held
  player.setPendant(.ready { _ in lock.lock(); stamps.append(HapticPlayer.now()); lock.unlock(); return true })
  check(done.wait(timeout: .now() + 3) == .success, "player finished")
  lock.lock()
  let gaps = zip(stamps.dropFirst(), stamps).map { $0 - $1 }
  check(acks == [.played("rt")] && gaps.count == 2 && gaps.allSatisfy { $0 >= 150 && $0 <= 230 }, "player spacing \(gaps) \(acks)")
  lock.unlock()
  player.setPendant(.away)
  player.play(HapticSequence(id: "gone", pulses: [1], intervalMs: 150, expiresAt: HapticPlayer.now() + 200))
  check(done.wait(timeout: .now() + 3) == .success, "player expiry")
  lock.lock()
  check(acks.last == .expired("gone"), "player TTL drop \(acks)")
  lock.unlock()
  // A pendant without a haptic motor: held and new sequences end at once with no_pendant.
  player.play(HapticSequence(id: "held", pulses: [1], intervalMs: 150, expiresAt: HapticPlayer.now() + 60_000))
  player.setPendant(.cannotBuzz)
  check(done.wait(timeout: .now() + 1) == .success, "held dropped when the pendant can't buzz")
  player.play(HapticSequence(id: "new", pulses: [1], intervalMs: 150, expiresAt: HapticPlayer.now() + 60_000))
  check(done.wait(timeout: .now() + 1) == .success, "new dropped when the pendant can't buzz")
  lock.lock()
  check(Array(acks.suffix(2)) == [.noPendant("held"), .noPendant("new")], "cannotBuzz acks \(acks)")
  lock.unlock()
}

// --- uplink: live stream first, backlog bounded ---
do {
  typealias L = UploadPlanner.Lane
  let live = L(slot: 7, live: true, sent: 99, acked: 99, next: 350, startedAt: 9_000)
  let old = L(slot: 1, live: false, sent: -1, acked: -1, next: 5_000, startedAt: 1_000)
  let older = L(slot: 2, live: false, sent: -1, acked: -1, next: 5_000, startedAt: 500)
  // Live has 250 pending frames: it goes first, and backlog waits until it's caught up.
  var plan = UploadPlanner.plan([old, live], pendingSends: 0, batchFrames: 100, maxInflight: 3000)
  check(plan.first == .init(slot: 7, from: 100, count: 100), "live first: \(plan)")
  check(plan.prefix(3).map(\.slot) == [7, 7, 7] && plan[2].count == 50, "live batches")
  check(plan.dropFirst(3).allSatisfy { $0.slot == 1 }, "backlog after live")
  check(plan.count == 3 + 1, "backlog bounded by pending sends (\(plan.count))")
  // A busy socket: live may still queue, backlog may not.
  plan = UploadPlanner.plan([old, live], pendingSends: 10, batchFrames: 100, maxInflight: 3000)
  check(plan.map(\.slot) == [7, 7, 7], "no backlog behind a busy socket: \(plan)")
  // Live stuck at its in-flight window: not caught up, so no backlog.
  let stuck = L(slot: 7, live: true, sent: 3099, acked: 99, next: 4000, startedAt: 9_000)
  plan = UploadPlanner.plan([old, stuck], pendingSends: 0, batchFrames: 100, maxInflight: 3000)
  check(plan.isEmpty, "live at window blocks backlog: \(plan)")
  // Live caught up: backlog oldest stream first, limited by the backlog in-flight budget.
  let idle = L(slot: 7, live: true, sent: 349, acked: 300, next: 350, startedAt: 9_000)
  plan = UploadPlanner.plan([old, idle, older], pendingSends: 0, batchFrames: 100, maxInflight: 3000)
  check(plan.map(\.slot) == [2, 2, 2, 2] && plan.first?.from == 0, "oldest backlog first: \(plan)")
  let busy = L(slot: 2, live: false, sent: 949, acked: -1, next: 5_000, startedAt: 500)
  plan = UploadPlanner.plan([busy, old], pendingSends: 0, batchFrames: 100, maxInflight: 3000)
  check(plan == [.init(slot: 2, from: 950, count: 100)], "backlog in-flight budget: \(plan)")
  // No live stream bound (pendant away): backlog still flows, bounded.
  plan = UploadPlanner.plan([old], pendingSends: 0, batchFrames: 100, maxInflight: 3000)
  check(plan.count == 4 && plan.allSatisfy { $0.slot == 1 }, "backlog without live")
}

// --- per-slot server errors ---
check(SlotError.action(for: "seq_gap") == .resendFromAck, "seq_gap resends from the ack")
check(SlotError.action(for: "store_failed") == .resendFromAck, "store_failed resends from the ack")
check(SlotError.action(for: "codec") == .refuseStream && SlotError.action(for: "stream") == .refuseStream, "refused streams")
check(SlotError.action(for: "no_stream") == .reconnect, "unknown slot errors reconnect")

// --- ping deadline ---
do {
  var d = ReplyDeadline(timeout: 10)
  check(d.verdict(at: 100) == .alive, "nothing pending")
  d.pinged(at: 100)
  check(d.verdict(at: 109.9) == .alive, "within deadline")
  check(d.verdict(at: 110) == .dead, "silent past the deadline")
  d.heard()
  check(d.verdict(at: 110) == .alive, "pong clears it")
  d.pinged(at: 120)
  d.pinged(at: 125) // a second ping doesn't extend the first one's deadline
  check(d.verdict(at: 130.5) == .dead, "deadline from the first unanswered ping")
  check(d.verdict(at: 132) == .dead, "up to 2 s late is still a verdict")
  check(d.verdict(at: 132.1) == .stale, "check ran >2 s late (suspended/asleep): ping again, don't condemn")
  check(d.verdict(at: 300) == .stale, "check ran very late")
}

// --- network change: reconnect at once only if the socket had settled ---
check(!NetworkChange.reconnectAtOnce(openForMs: nil), "connecting: backoff")
check(!NetworkChange.reconnectAtOnce(openForMs: 9_999), "just opened: backoff")
check(NetworkChange.reconnectAtOnce(openForMs: 10_000), "settled socket: reconnect at once")

// --- resend from ack: paced while the ack doesn't move ---
do {
  var r = ResendThrottle()
  check(r.request(acked: 99, now: 0) == 0, "first resend at once")
  check(r.request(acked: 99, now: 50) == 950 && r.scheduled, "next one waits 1 s")
  check(r.request(acked: 99, now: 60) == nil, "requests collapse into the scheduled one")
  check(r.due(acked: 99) && !r.scheduled, "scheduled resend runs (ack unchanged)")
  check(r.request(acked: 99, now: 1_100) == 1_900, "then 2 s")
  _ = r.due(acked: 99)
  check(r.request(acked: 99, now: 3_000) == 4_000, "then 4 s")
  _ = r.due(acked: 99)
  var waits: [Int64] = []
  var t: Int64 = 7_000
  for _ in 0..<4 {
    let w = r.request(acked: 99, now: t) ?? -1
    waits.append(w)
    t += w
    _ = r.due(acked: 99)
  }
  check(waits == [8_000, 16_000, 16_000, 16_000], "capped at 16 s: \(waits)")
  // The ack moved: back to resending at once.
  check(r.request(acked: 500, now: t + 10) == 0, "ack progress resets the pacing")
  check(r.request(acked: 500, now: t + 20) == 990, "and pacing starts over at 1 s")
  check(!r.due(acked: 700), "a scheduled resend is skipped if the ack moved meanwhile")
  check(r.request(acked: 700, now: t + 1_100) == 0, "next refusal after progress goes at once")
  // Over a 60 s outage with refusals arriving constantly, only a handful of resends happen.
  var o = ResendThrottle()
  var resends = 0
  var nextDue: Int64?
  for ms in stride(from: Int64(0), to: 60_000, by: 20) {
    if let d = nextDue, ms >= d { nextDue = nil; if o.due(acked: 5) { resends += 1 } }
    if let w = o.request(acked: 5, now: ms) { if w == 0 { resends += 1 } else { nextDue = ms + w } }
  }
  check(resends <= 8, "outage resends paced (\(resends))")
}

// --- pendant button: the release after a tap is not a hold ---
do {
  var b = ButtonFilter()
  check(b.gesture(code: 1, at: 1_000) == .tap, "tap")
  check(b.gesture(code: 5, at: 1_244) == nil, "release after tap ignored")
  check(b.gesture(code: 2, at: 5_000) == .doubleTap, "double tap")
  check(b.gesture(code: 5, at: 5_027) == nil, "release after double tap ignored")
  check(b.gesture(code: 5, at: 9_000) == .hold, "release without a tap is a hold")
  check(b.gesture(code: 1, at: 10_000) == .tap, "tap again")
  check(b.gesture(code: 5, at: 10_401) == .hold, "release long after a tap is a hold")
  check(b.gesture(code: 1, at: 11_000) == .tap && b.gesture(code: 5, at: 11_100) == nil
    && b.gesture(code: 5, at: 11_200) == .hold, "only one release is swallowed per tap")
  check(b.gesture(code: 3, at: 12_000) == nil && b.gesture(code: 4, at: 12_000) == nil, "unused codes")
}

if failures > 0 { print("\(failures) failure(s)"); exit(1) }
print("swift: all checks passed")
