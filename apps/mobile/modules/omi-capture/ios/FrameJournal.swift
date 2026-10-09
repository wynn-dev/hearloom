import Foundation

struct Frame {
  let seq: Int64
  let at: Int64
  let data: Data
}

struct WearableInfo: Codable, Equatable {
  var peripheralId: String
  var name: String
  var model: String?
  var firmware: String?
  var hardwareRev: String?
  var serial: String?
  var battery: Int?

  var json: [String: Any] {
    var d: [String: Any] = ["peripheralId": peripheralId, "name": name]
    if let model { d["model"] = model }
    if let firmware { d["firmware"] = firmware }
    if let hardwareRev { d["hardwareRev"] = hardwareRev }
    if let serial { d["serial"] = serial }
    if let battery { d["battery"] = battery }
    return d
  }
}

struct StreamMeta: Codable {
  let id: String
  let codec: Int
  let sampleRate: Int
  let frameMs: Int
  let startedAt: Int64
  var endedAt: Int64?
  var wearable: WearableInfo?
}

/// Append-only on-disk journal of Opus frames, one directory per capture stream.
/// Frames stay here until the server acknowledges them; segments are deleted once fully acked.
///
/// Layout: `<root>/<streamId>/meta.json` and `<root>/<streamId>/<firstSeq padded>.seg`.
/// Record format (little-endian, same as the server spool): `u64 seq, u64 atMs, u16 len, bytes`.
final class FrameJournal {
  private let root: URL
  private let fm = FileManager.default
  private static let framesPerSegment: Int64 = 1500 // 30 s at 20 ms
  private static let maxTail = 3000

  private struct Open {
    var meta: StreamMeta
    var nextSeq: Int64
    /// Highest seq the server has acknowledged (as far as we know; at launch, before the segment that
    /// still holds frames).
    var acked: Int64 = -1
    var segmentFirstSeq: Int64
    var handle: FileHandle?
    /// Recent frames kept in memory so live sends don't hit the disk.
    var tail: [Frame] = []
  }

  private var streams: [String: Open] = [:]
  /// The last closed segment read from disk, decoded. A backlog upload reads each segment in many
  /// batches; without this every batch re-read and re-decoded the whole file on the capture queue.
  private var decoded: (id: String, firstSeq: Int64, frames: [Frame])?

  init(root: URL) {
    self.root = root
    try? fm.createDirectory(at: root, withIntermediateDirectories: true)
    var excluded = URLResourceValues()
    excluded.isExcludedFromBackup = true
    var r = root
    try? r.setResourceValues(excluded)
    loadExisting()
  }

  // MARK: queries

  var streamIds: [String] { Array(streams.keys) }

  func meta(_ id: String) -> StreamMeta? { streams[id]?.meta }

  func nextSeq(_ id: String) -> Int64 { streams[id]?.nextSeq ?? 0 }

  /// Frames not yet acknowledged by the server.
  func unacked(_ id: String) -> Int64 {
    guard let s = streams[id] else { return 0 }
    return max(0, s.nextSeq - s.acked - 1)
  }

  /// Frames with seq >= `from`, oldest first, at most `max`.
  func frames(_ id: String, from: Int64, max: Int) -> [Frame] {
    guard let s = streams[id], from < s.nextSeq, max > 0 else { return [] }
    if let first = s.tail.first, from >= first.seq {
      let start = Int(from - first.seq)
      return Array(s.tail[start..<min(s.tail.count, start + max)])
    }
    var out: [Frame] = []
    for (firstSeq, url) in segments(id) {
      let next = firstSeq + FrameJournal.framesPerSegment
      if next <= from { continue }
      let open = firstSeq == s.segmentFirstSeq && s.handle != nil
      for f in segmentFrames(id, firstSeq: firstSeq, url: url, open: open) where f.seq >= from {
        out.append(f)
        if out.count >= max { return out }
      }
    }
    return out
  }

  /// Total bytes on disk (for status/limits).
  func diskBytes() -> Int64 {
    var total: Int64 = 0
    if let e = fm.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey]) {
      for case let url as URL in e {
        total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
      }
    }
    return total
  }

  // MARK: mutations

  func create(_ meta: StreamMeta) {
    let dir = root.appendingPathComponent(meta.id, isDirectory: true)
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    streams[meta.id] = Open(meta: meta, nextSeq: 0, segmentFirstSeq: 0, handle: nil)
    writeMeta(meta)
  }

  func updateMeta(_ id: String, _ change: (inout StreamMeta) -> Void) {
    guard var s = streams[id] else { return }
    change(&s.meta)
    streams[id] = s
    writeMeta(s.meta)
  }

  /// Append one frame; returns its seq.
  @discardableResult
  func append(_ id: String, at: Int64, data: Data) -> Int64 {
    guard var s = streams[id] else { return -1 }
    let seq = s.nextSeq
    if s.handle == nil || seq - s.segmentFirstSeq >= FrameJournal.framesPerSegment {
      try? s.handle?.close()
      s.segmentFirstSeq = seq
      let url = segmentURL(id, firstSeq: seq)
      fm.createFile(atPath: url.path, contents: nil)
      s.handle = try? FileHandle(forWritingTo: url)
    }
    let frame = Frame(seq: seq, at: at, data: data)
    do {
      try s.handle?.seekToEnd()
      try s.handle?.write(contentsOf: FrameJournal.encode([frame]))
    } catch {
      Log.error("journal write failed: \(error)")
    }
    s.tail.append(frame)
    if s.tail.count > FrameJournal.maxTail { s.tail.removeFirst(s.tail.count - FrameJournal.maxTail) }
    s.nextSeq = seq + 1
    streams[id] = s
    return seq
  }

  /// Delete everything the server has durably stored (seq <= `through`).
  func trim(_ id: String, through: Int64) {
    guard var s = streams[id] else { return }
    let segs = segments(id)
    for (i, (firstSeq, url)) in segs.enumerated() {
      let lastSeq = i + 1 < segs.count ? segs[i + 1].0 - 1 : s.nextSeq - 1
      let isOpenSegment = firstSeq == s.segmentFirstSeq && s.handle != nil
      if lastSeq <= through && !isOpenSegment {
        try? fm.removeItem(at: url)
        if decoded?.id == id && decoded?.firstSeq == firstSeq { decoded = nil }
      }
    }
    s.acked = max(s.acked, through)
    s.tail.removeAll { $0.seq <= through }
    streams[id] = s
  }

  /// Keep the raw bytes of offline records next to the stream until it's uploaded (the pendant deletes
  /// them as it sends, so a parsing bug must never lose data).
  func appendRaw(_ id: String, _ data: Data) {
    let url = root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("raw.bin")
    if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
    guard let h = try? FileHandle(forWritingTo: url) else { return }
    defer { try? h.close() }
    _ = try? h.seekToEnd()
    try? h.write(contentsOf: data)
  }

  /// Remove a finished, fully uploaded stream. Raw offline records are kept a while longer (see
  /// `rawArchive`), so a parsing bug found later can still be recovered from.
  func remove(_ id: String) {
    if let s = streams[id] { try? s.handle?.close() }
    streams[id] = nil
    if decoded?.id == id { decoded = nil }
    let dir = root.appendingPathComponent(id, isDirectory: true)
    let raw = dir.appendingPathComponent("raw.bin")
    if fm.fileExists(atPath: raw.path) {
      if !fm.fileExists(atPath: rawArchive.path) {
        try? fm.createDirectory(at: rawArchive, withIntermediateDirectories: true)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var r = rawArchive
        try? r.setResourceValues(excluded)
      }
      try? fm.moveItem(at: raw, to: rawArchive.appendingPathComponent("\(id).bin"))
    }
    try? fm.removeItem(at: dir)
  }

  /// Raw pendant records of uploaded offline streams, kept for `rawKeepDays`.
  private var rawArchive: URL { root.deletingLastPathComponent().appendingPathComponent("offline-raw", isDirectory: true) }
  private static let rawKeepDays = 14.0

  private func pruneRawArchive() {
    let cutoff = Date().addingTimeInterval(-FrameJournal.rawKeepDays * 86_400)
    let files = (try? fm.contentsOfDirectory(at: rawArchive, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
    for f in files {
      let date = (try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      if date < cutoff { try? fm.removeItem(at: f) }
    }
  }

  /// Close the open segment file of a stream (it stops receiving frames).
  func seal(_ id: String) {
    guard var s = streams[id] else { return }
    try? s.handle?.close()
    s.handle = nil
    streams[id] = s
  }

  // MARK: private

  private func segmentURL(_ id: String, firstSeq: Int64) -> URL {
    root.appendingPathComponent(id, isDirectory: true)
      .appendingPathComponent(String(format: "%020lld.seg", firstSeq))
  }

  /// A segment's frames; closed segments never change, so the last one read stays decoded.
  private func segmentFrames(_ id: String, firstSeq: Int64, url: URL, open: Bool) -> [Frame] {
    if !open, let d = decoded, d.id == id, d.firstSeq == firstSeq { return d.frames }
    guard let data = try? Data(contentsOf: url) else { return [] }
    let frames = FrameJournal.decode(data)
    if !open { decoded = (id, firstSeq, frames) }
    return frames
  }

  private func segments(_ id: String) -> [(Int64, URL)] {
    let dir = root.appendingPathComponent(id, isDirectory: true)
    let names = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
    return names.compactMap { name -> (Int64, URL)? in
      guard name.hasSuffix(".seg"), let first = Int64(name.dropLast(4)) else { return nil }
      return (first, dir.appendingPathComponent(name))
    }.sorted { $0.0 < $1.0 }
  }

  private func writeMeta(_ meta: StreamMeta) {
    let url = root.appendingPathComponent(meta.id, isDirectory: true).appendingPathComponent("meta.json")
    if let data = try? JSONEncoder().encode(meta) { try? data.write(to: url, options: .atomic) }
  }

  private func loadExisting() {
    let ids = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
    for id in ids {
      let dir = root.appendingPathComponent(id, isDirectory: true)
      let segs = segments(id)
      guard let data = try? Data(contentsOf: dir.appendingPathComponent("meta.json")),
            var meta = try? JSONDecoder().decode(StreamMeta.self, from: data) else {
        // Without its meta a stream can't be uploaded, but its audio may still be recoverable by hand:
        // only delete directories that hold nothing.
        if segs.isEmpty && !fm.fileExists(atPath: dir.appendingPathComponent("raw.bin").path) {
          try? fm.removeItem(at: dir)
        } else {
          Log.error("journal: \(id) has unreadable meta.json; leaving it on disk")
        }
        continue
      }
      var next: Int64 = 0
      var lastAt: Int64 = meta.startedAt
      if let (first, url) = segs.last, let data = try? Data(contentsOf: url) {
        let frames = FrameJournal.decode(data)
        next = (frames.last?.seq ?? (first - 1)) + 1
        lastAt = frames.last?.at ?? lastAt
      }
      // A stream found on disk at launch belongs to a previous process: it can't grow anymore.
      if meta.endedAt == nil {
        meta.endedAt = lastAt
        writeMeta(meta)
      }
      streams[id] = Open(
        meta: meta, nextSeq: next, acked: (segs.first?.0 ?? next) - 1, segmentFirstSeq: segs.last?.0 ?? 0,
        handle: nil)
    }
    if !streams.isEmpty { Log.info("journal: \(streams.count) stream(s) awaiting upload") }
    pruneRawArchive()
  }

  static func encode(_ frames: [Frame]) -> Data {
    var out = Data(capacity: frames.reduce(0) { $0 + 18 + $1.data.count })
    for f in frames {
      var seq = UInt64(f.seq).littleEndian
      var at = UInt64(f.at).littleEndian
      var len = UInt16(f.data.count).littleEndian
      withUnsafeBytes(of: &seq) { out.append(contentsOf: $0) }
      withUnsafeBytes(of: &at) { out.append(contentsOf: $0) }
      withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
      out.append(f.data)
    }
    return out
  }

  static func decode(_ data: Data) -> [Frame] {
    var frames: [Frame] = []
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      var o = 0
      while o + 18 <= raw.count {
        let seq = Int64(raw.loadUnaligned(fromByteOffset: o, as: UInt64.self).littleEndian)
        let at = Int64(raw.loadUnaligned(fromByteOffset: o + 8, as: UInt64.self).littleEndian)
        let len = Int(raw.loadUnaligned(fromByteOffset: o + 16, as: UInt16.self).littleEndian)
        guard o + 18 + len <= raw.count else { break } // torn tail write
        frames.append(Frame(seq: seq, at: at, data: Data(raw[(o + 18)..<(o + 18 + len)])))
        o += 18 + len
      }
    }
    return frames
  }
}
