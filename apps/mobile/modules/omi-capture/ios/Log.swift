import Foundation
import os

/// Logging to os_log plus a small in-memory ring the app can show for debugging.
enum Log {
  private static let logger = Logger(subsystem: "hearloom.capture", category: "capture")
  private static let lock = NSLock()
  private static var ring: [String] = []
  private static let formatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withTime, .withColonSeparatorInTime, .withFractionalSeconds]
    return f
  }()

  static func info(_ message: String) { append("I", message); logger.info("\(message, privacy: .public)") }
  static func warn(_ message: String) { append("W", message); logger.warning("\(message, privacy: .public)") }
  static func error(_ message: String) { append("E", message); logger.error("\(message, privacy: .public)") }

  static func recent() -> [String] {
    lock.lock(); defer { lock.unlock() }
    return ring
  }

  private static func append(_ level: String, _ message: String) {
    let line = "\(formatter.string(from: Date())) \(level) \(message)"
    lock.lock(); defer { lock.unlock() }
    ring.append(line)
    if ring.count > 300 { ring.removeFirst(ring.count - 300) }
  }
}

@inline(__always) func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// Monotonic ms for measuring durations: never steps with the wall clock, and keeps counting while the
/// device sleeps (CLOCK_MONOTONIC on Darwin), unlike DispatchTime's uptime.
@inline(__always) func monotonicMs() -> Int64 { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000) }
