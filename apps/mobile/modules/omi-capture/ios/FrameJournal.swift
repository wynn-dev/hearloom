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
    var segmentFirstSeq: Int64
    var handle: FileHandle?
    /// Recent frames kept in memory so live sends don't hit the disk.
    var tail: [Frame] = []
  }

  private var streams: [String: Open] = [:]

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
      guard let data = try? Data(contentsOf: url) else { continue }
      for f in FrameJournal.decode(data) where f.seq >= from {
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
      if lastSeq <= through && !isOpenSegment { try? fm.removeItem(at: url) }
    }
    s.tail.removeAll { $0.seq <= through }
    streams[id] = s
  }

  /// Remove a finished, fully uploaded stream.
  func remove(_ id: String) {
    if let s = streams[id] { try? s.handle?.close() }
    streams[id] = nil
    try? fm.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
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
      let metaURL = root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("meta.json")
      guard let data = try? Data(contentsOf: metaURL),
            var meta = try? JSONDecoder().decode(StreamMeta.self, from: data) else {
        try? fm.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
        continue
      }
      let segs = segments(id)
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
      streams[id] = Open(meta: meta, nextSeq: next, segmentFirstSeq: segs.last?.0 ?? 0, handle: nil)
    }
    if !streams.isEmpty { Log.info("journal: \(streams.count) stream(s) awaiting upload") }
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
