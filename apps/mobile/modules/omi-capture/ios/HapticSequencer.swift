import Foundation

/// A buzz pattern from the server (`haptic_seq`): pulses played `intervalMs` apart, start to start.
struct HapticSequence: Equatable {
  let id: String
  /// Pattern bytes for the haptic characteristic (1 short, 2 medium, 3 long).
  let pulses: [UInt8]
  let intervalMs: Int64
  /// Monotonic ms (`HapticPlayer.now()`) after which it must not start anymore.
  let expiresAt: Int64

  static let maxPulses = 5

  init(id: String, pulses: [UInt8], intervalMs: Int64, expiresAt: Int64) {
    self.id = id
    self.pulses = pulses
    self.intervalMs = intervalMs
    self.expiresAt = expiresAt
  }

  /// Parse a `haptic_seq` message received at `now`; nil if it has no id or no pulses.
  init?(message msg: [String: Any], receivedAt now: Int64) {
    guard let id = msg["id"] as? String, !id.isEmpty,
          let names = msg["pulses"] as? [Any], !names.isEmpty else { return nil }
    let interval = (msg["intervalMs"] as? NSNumber)?.int64Value ?? 350
    let ttl = (msg["ttlMs"] as? NSNumber)?.int64Value ?? 10_000
    self.init(
      id: id,
      pulses: names.prefix(HapticSequence.maxPulses).map { HapticSequence.pattern($0 as? String) },
      intervalMs: min(max(interval, 0), 5_000),
      expiresAt: now + min(max(ttl, 0), 600_000))
  }

  /// The haptic characteristic byte for a pattern name (unknown names buzz medium, as always).
  static func pattern(_ name: String?) -> UInt8 { name == "short" ? 1 : name == "long" ? 3 : 2 }

  /// How long the motor runs for a pattern byte (firmware: 1 = 100 ms, 2 = 300 ms, 3 = 500 ms).
  static func durationMs(_ pattern: UInt8) -> Int64 { pattern == 1 ? 100 : pattern == 3 ? 500 : 300 }
}

/// How a sequence ended, reported to the server as `haptic_ack`.
struct HapticOutcome: Equatable {
  let id: String
  let played: Bool
  /// `no_pendant` or `expired` when not played.
  let reason: String?

  static func played(_ id: String) -> HapticOutcome { HapticOutcome(id: id, played: true, reason: nil) }
  static func noPendant(_ id: String) -> HapticOutcome { HapticOutcome(id: id, played: false, reason: "no_pendant") }
  static func expired(_ id: String) -> HapticOutcome { HapticOutcome(id: id, played: false, reason: "expired") }

  var json: [String: Any] {
    var d: [String: Any] = ["t": "haptic_ack", "id": id, "played": played]
    if let reason { d["reason"] = reason }
    return d
  }
}

/// The sequencing rules, free of clocks and threads (time is passed in, in ms) so they can be tested:
/// one sequence plays at a time; a sequence that can't start (no pendant, or another is playing) waits
/// in a small queue until its TTL; a pendant that goes away mid-sequence ends it.
struct HapticQueue {
  static let maxHeld = 3
  /// Stillness between the end of one sequence's last pulse and the next sequence, so two patterns
  /// (e.g. "heard" then "failed") are felt as two, not one long run of taps.
  static let stillnessMs: Int64 = 600

  private(set) var held: [HapticSequence] = []
  private var current: (seq: HapticSequence, next: Int, nextAt: Int64)?
  /// The next sequence starts no earlier than this (see `stillnessMs`).
  private var notBefore: Int64 = 0

  var isPlaying: Bool { current != nil }

  /// Queue a sequence; returns the one pushed out if the queue was full.
  mutating func add(_ seq: HapticSequence) -> [HapticOutcome] {
    var out: [HapticOutcome] = []
    if held.count >= HapticQueue.maxHeld { out.append(.noPendant(held.removeFirst().id)) }
    held.append(seq)
    return out
  }

  /// The pendant can't buzz at all (no haptic characteristic): end everything with `no_pendant`.
  mutating func dropAll() -> [HapticOutcome] {
    var out: [HapticOutcome] = []
    if let c = current { out.append(.noPendant(c.seq.id)) }
    out += held.map { .noPendant($0.id) }
    current = nil
    held = []
    return out
  }

  /// Do what is due at `now`: drop expired sequences, write a due pulse, start the next sequence.
  /// `write` is nil while the pendant can't buzz; it returns false if the write couldn't be sent.
  /// Writes at most one pulse per sequence per call, so a late timer never bunches pulses together.
  mutating func run(now: Int64, write: ((UInt8) -> Bool)?) -> [HapticOutcome] {
    var out: [HapticOutcome] = []
    held.removeAll { seq in
      guard now >= seq.expiresAt else { return false }
      out.append(.expired(seq.id))
      return true
    }
    while true {
      if current == nil {
        guard write != nil, now >= notBefore, !held.isEmpty else { break }
        current = (held.removeFirst(), 0, now)
      }
      guard var c = current, c.nextAt <= now else { break }
      guard let write, write(c.seq.pulses[c.next]) else {
        // The pendant went away mid-sequence; a half-felt pattern isn't worth replaying later.
        out.append(.noPendant(c.seq.id))
        current = nil
        continue
      }
      c.next += 1
      if c.next < c.seq.pulses.count {
        c.nextAt = now + c.seq.intervalMs
        current = c
        break
      }
      out.append(.played(c.seq.id))
      current = nil
      let last = c.seq.pulses[c.seq.pulses.count - 1]
      notBefore = now + HapticSequence.durationMs(last) + HapticQueue.stillnessMs
    }
    return out
  }

  /// When `run` next has something to do (monotonic ms), or nil if nothing is pending.
  func nextWakeAt(ready: Bool) -> Int64? {
    var times = held.map(\.expiresAt)
    if let c = current {
      times.append(c.nextAt)
    } else if ready, !held.isEmpty {
      times.append(notBefore)
    }
    return times.min()
  }
}

/// Whether the pendant can buzz, as published by the BLE layer.
enum HapticPendant {
  /// Not connected (or not set up yet): sequences wait, up to their TTL.
  case away
  /// Connected, but it has no haptic motor/characteristic: sequences end now with `no_pendant`.
  case cannotBuzz
  /// Ready; the writer queues one pulse write (returns false if it can't).
  case ready(HapticPlayer.Writer)
}

/// Plays `haptic_seq` patterns on the pendant with exact spacing. The timing runs on its own
/// high-priority queue, not the capture queue, so the pulse schedule never drifts with journal and
/// upload work; each write itself is handed to the BLE queue (see `OmiBLE.updateHapticPendant`).
final class HapticPlayer {
  typealias Writer = (UInt8) -> Bool

  private let queue = DispatchQueue(label: "hearloom.haptics", qos: .userInteractive)
  private var line = HapticQueue()
  private var pendant = HapticPendant.away
  private var timer: DispatchSourceTimer?
  /// Called on the player's queue when a sequence is played or dropped.
  private let finished: (HapticOutcome) -> Void

  init(finished: @escaping (HapticOutcome) -> Void) {
    self.finished = finished
  }

  /// Monotonic ms, counting time asleep (TTLs are real time).
  static func now() -> Int64 { monotonicMs() }

  func play(_ seq: HapticSequence) {
    queue.async {
      self.line.add(seq).forEach(self.finished)
      self.run()
    }
  }

  func setPendant(_ pendant: HapticPendant) {
    queue.async {
      self.pendant = pendant
      self.run()
    }
  }

  private func run() {
    let now = HapticPlayer.now()
    var writer: Writer?
    switch pendant {
    case .away: writer = nil
    case .cannotBuzz: line.dropAll().forEach(finished)
    case .ready(let w): writer = w
    }
    line.run(now: now, write: writer).forEach(finished)
    guard let at = line.nextWakeAt(ready: writer != nil) else {
      timer?.cancel()
      timer = nil
      return
    }
    if timer == nil {
      let t = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
      t.setEventHandler { [weak self] in self?.run() }
      t.resume()
      timer = t
    }
    timer?.schedule(deadline: .now() + .milliseconds(Int(max(0, at - now))), leeway: .milliseconds(1))
  }
}
