import Foundation

/// Turns pendant button notifications into gestures. The Omi firmware notifies 1 (tap) or 2 (double tap)
/// and then, 30-250 ms later, 5 (release) for the same press; its 3 (long press) and 4 (press) are never
/// sent (see packages/shared/src/omi.ts). So a 5 is a hold only when it doesn't trail a tap.
struct ButtonFilter {
  enum Gesture: Equatable { case tap, doubleTap, hold }

  /// A release this soon after a tap/double tap belongs to it.
  static let releaseWindowMs: Int64 = 400

  private var lastTapAt: Int64?

  mutating func gesture(code: Int, at now: Int64) -> Gesture? {
    switch code {
    case 1:
      lastTapAt = now
      return .tap
    case 2:
      lastTapAt = now
      return .doubleTap
    case 5:
      defer { lastTapAt = nil }
      if let t = lastTapAt, now >= t, now - t <= ButtonFilter.releaseWindowMs { return nil }
      return .hold
    default:
      return nil
    }
  }
}
