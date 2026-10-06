import Foundation

/// Ingest protocol v1 audio batch (see docs/protocol.md and packages/shared/src/ingest.ts):
/// `u8 0x01, u8 slot, u64 firstSeq, u64 baseTimeMs, u16 count, count × {u32 offsetMs, u16 len, bytes}`.
enum BatchCodec {
  static func encode(slot: Int, frames: [Frame]) -> Data {
    precondition(!frames.isEmpty && frames.count <= 1000)
    let base = frames[0].at
    var out = Data(capacity: 20 + frames.reduce(0) { $0 + 6 + $1.data.count })
    out.append(0x01)
    out.append(UInt8(truncatingIfNeeded: slot))
    append(&out, UInt64(frames[0].seq))
    append(&out, UInt64(base))
    append(&out, UInt16(frames.count))
    for f in frames {
      append(&out, UInt32(clamping: max(0, f.at - base)))
      append(&out, UInt16(f.data.count))
      out.append(f.data)
    }
    return out
  }

  private static func append<T: FixedWidthInteger>(_ data: inout Data, _ value: T) {
    var le = value.littleEndian
    withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
  }
}
