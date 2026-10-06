import Foundation

/// Audio the pendant recorded on its own (phone out of range), as stored by stock firmware ≥ 3.0.20.
///
/// Wire format (omi/firmware/omi/src/lib/core/storage.c, sd_card.c, transport.c):
/// - DATA notifications carry arbitrary slices of back-to-back 444-byte records.
/// - Record: `u32 BE unix seconds` + 440-byte payload of `[len u8][opus frame]…`. When the next frame
///   doesn't fit, the firmware writes its length byte at the end and starts the next record with it,
///   leaving stale bytes after — so parsing stops at a zero length or a frame that would end past
///   byte 439.
struct OfflineRecordParser {
    static let recordSize = 444
    static let payloadSize = 440

    private var buffer = Data()

    /// Feed the bytes of one DATA notification (without its 0x03 type byte); returns whole records.
    mutating func push(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var records: [Data] = []
        while buffer.count >= Self.recordSize {
            records.append(Data(buffer.prefix(Self.recordSize)))
            buffer.removeFirst(Self.recordSize)
        }
        return records
    }

    var pendingBytes: Int { buffer.count }

    mutating func reset() { buffer = Data() }

    /// Timestamp and Opus frames of one record.
    static func parse(_ record: Data) -> (timestamp: UInt32, frames: [Data]) {
        let bytes = [UInt8](record)
        guard bytes.count == recordSize else { return (0, []) }
        let ts = UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3])
        var frames: [Data] = []
        var o = 0
        let payload = Array(bytes[4...])
        while o < payloadSize {
            let len = Int(payload[o])
            if len == 0 || o + 1 + len > payloadSize - 1 { break }
            frames.append(Data(payload[(o + 1)..<(o + 1 + len)]))
            o += 1 + len
        }
        return (ts, frames)
    }
}

/// Assigns capture times to offline frames. Records only carry whole seconds, so frames advance a
/// running clock by one frame duration and re-anchor to the record time after gaps (mic sleep).
struct OfflineClock {
    private var clockMs: Int64?
    let frameMs: Int64

    init(frameMs: Int = 20) { self.frameMs = Int64(frameMs) }

    mutating func stamp(recordSeconds: UInt32, frames: Int) -> [Int64] {
        let anchor = Int64(recordSeconds) * 1000
        // The record time is when it was written, i.e. near the end of its audio.
        let start = anchor - Int64(frames) * frameMs
        var t = clockMs ?? start
        if abs(t - start) > 2000 { t = start }
        var out: [Int64] = []
        for _ in 0..<frames {
            out.append(t)
            t += frameMs
        }
        clockMs = t
        return out
    }
}

enum StorageCommand {
    static func info() -> Data { Data([0x10]) }

    /// Read everything from `startSeq` (the firmware deletes data as it is delivered).
    static func read(from startSeq: UInt64) -> Data {
        var d = Data([0x11])
        var be = startSeq.bigEndian
        withUnsafeBytes(of: &be) { d.append(contentsOf: $0) }
        return d
    }

    static func stop() -> Data { Data([0x03]) }
}

enum StorageNotification {
    case ack(status: UInt8)
    case info(readSeq: UInt64, writeSeq: UInt64, capacity: UInt32, dropped: UInt64)
    case readBegin(startSeq: UInt64, count: UInt32)
    case data(Data)
    case done(status: UInt8, nextSeq: UInt64)
    case unknown

    static func parse(_ value: Data) -> StorageNotification {
        let b = [UInt8](value)
        guard let type = b.first else { return .unknown }
        func be64(_ o: Int) -> UInt64 { b[o..<(o + 8)].reduce(0) { $0 << 8 | UInt64($1) } }
        func be32(_ o: Int) -> UInt32 { b[o..<(o + 4)].reduce(0) { $0 << 8 | UInt32($1) } }
        switch type {
        case 0x01 where b.count >= 2: return .ack(status: b[1])
        case 0x02 where b.count >= 29:
            return .info(readSeq: be64(1), writeSeq: be64(9), capacity: be32(17), dropped: be64(21))
        case 0x05 where b.count >= 13: return .readBegin(startSeq: be64(1), count: be32(9))
        case 0x03: return .data(Data(b.dropFirst()))
        case 0x04 where b.count >= 10: return .done(status: b[1], nextSeq: be64(2))
        default: return .unknown
        }
    }
}

/// `…82` status characteristic: four little-endian u32s.
struct StorageStatus {
    let usedBytes: UInt32
    let unreadPackets: UInt32
    let freeBytes: UInt32
    let rtcValid: Bool

    init?(_ value: Data) {
        let b = [UInt8](value)
        guard b.count >= 16 else { return nil }
        func le32(_ o: Int) -> UInt32 { (0..<4).reduce(0) { $0 | UInt32(b[o + $1]) << (8 * $1) } }
        usedBytes = le32(0)
        unreadPackets = le32(4)
        freeBytes = le32(8)
        rtcValid = le32(12) != 0
    }
}
