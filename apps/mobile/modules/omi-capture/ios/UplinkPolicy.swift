import Foundation

/// Decides which journaled frames the pump sends next. Live first: the server only treats audio as live
/// (voice commands, live transcript) if it arrives within seconds, so backlog streams (older streams,
/// pendant recordings) never compete with the live one. They only go out once every pending live frame
/// has been handed to the socket, and only a little at a time, so a live batch never waits behind much.
enum UploadPlanner {
  struct Lane {
    let slot: Int
    /// The stream the pendant is (or was last) feeding.
    let live: Bool
    let sent: Int64
    let acked: Int64
    /// Next seq the journal will assign (frames < next exist).
    let next: Int64
    /// Backlog goes oldest stream first.
    let startedAt: Int64
  }

  struct Batch: Equatable {
    let slot: Int
    let from: Int64
    let count: Int
  }

  /// Socket sends queued (not yet handed off) above which nothing more is queued.
  static let maxPendingSends = 64
  /// Backlog only goes out while fewer sends than this are queued ...
  static let backlogPendingSends = 4
  /// ... and while fewer than this many backlog frames await an ack (about 20 s of audio).
  static let backlogInflight: Int64 = 1000

  static func plan(
    _ lanes: [Lane], pendingSends: Int, batchFrames: Int, maxInflight: Int64
  ) -> [Batch] {
    var out: [Batch] = []
    var sends = pendingSends
    var liveCaughtUp = true
    for lane in lanes where lane.live {
      var sent = lane.sent
      while sent + 1 < lane.next, sent - lane.acked < maxInflight, sends < maxPendingSends {
        let count = Int(min(Int64(batchFrames), lane.next - sent - 1))
        out.append(Batch(slot: lane.slot, from: sent + 1, count: count))
        sent += Int64(count)
        sends += 1
      }
      if sent + 1 < lane.next { liveCaughtUp = false }
    }
    guard liveCaughtUp else { return out }
    let backlog = lanes.filter { !$0.live }.sorted { ($0.startedAt, $0.slot) < ($1.startedAt, $1.slot) }
    var inflight = backlog.reduce(Int64(0)) { $0 + max(0, $1.sent - $1.acked) }
    for lane in backlog {
      var sent = lane.sent
      while sent + 1 < lane.next, sent - lane.acked < maxInflight, sends < backlogPendingSends,
            inflight < backlogInflight {
        let count = Int(min(Int64(batchFrames), lane.next - sent - 1))
        out.append(Batch(slot: lane.slot, from: sent + 1, count: count))
        sent += Int64(count)
        inflight += Int64(count)
        sends += 1
      }
    }
    return out
  }
}

/// What to do about a non-fatal server error for one stream slot.
enum SlotError {
  enum Action: Equatable {
    /// The server didn't keep frames after its ack: resend from there on the same socket.
    case resendFromAck
    /// The server won't take this stream (unsupported codec, another account's stream).
    case refuseStream
    /// The server lost track of the slot (e.g. a failed hello): start over.
    case reconnect
  }

  static func action(for code: String) -> Action {
    switch code {
    // seq_gap: an earlier batch never arrived. store_failed: a batch arrived but its progress
    // couldn't be persisted.
    case "seq_gap", "store_failed": return .resendFromAck
    case "codec", "stream": return .refuseStream
    default: return .reconnect
    }
  }
}

/// Paces resends from the server's ack. One lost batch makes the server refuse every batch after it,
/// and during a server storage outage every batch fails: each refusal asks for a resend, so without
/// pacing the phone would re-upload the same window as fast as the link allows. The first resend
/// happens at once; while the ack doesn't move, the next waits 1, 2, 4 … 16 s; requests in between
/// collapse into one scheduled resend (so the slot never stalls with its window full).
struct ResendThrottle {
  static let firstDelayMs: Int64 = 1_000
  static let maxDelayMs: Int64 = 16_000

  private var lastAcked: Int64?
  /// When the last resend happened (or is scheduled).
  private var lastAt: Int64 = 0
  /// Wait after `lastAt` before another resend without ack progress.
  private var delayMs: Int64 = 0
  /// A resend is scheduled and not done yet.
  private(set) var scheduled = false

  /// A resend from `acked` was asked for at `now` (monotonic ms). Returns how long to wait before doing
  /// it (0 = now), or nil if one is already scheduled.
  mutating func request(acked: Int64, now: Int64) -> Int64? {
    if scheduled { return nil }
    if lastAcked != acked { delayMs = 0 } // the ack moved: the last resend helped
    let wait = max(0, lastAt + delayMs - now)
    lastAcked = acked
    lastAt = now + wait
    delayMs = delayMs == 0 ? ResendThrottle.firstDelayMs : min(delayMs * 2, ResendThrottle.maxDelayMs)
    scheduled = wait > 0
    return wait
  }

  /// The scheduled resend is due; returns whether to do it. Not if the ack moved meanwhile: the earlier
  /// resend worked, and a refusal still pending will ask again (and go at once, the ack having moved).
  mutating func due(acked: Int64) -> Bool {
    scheduled = false
    return acked == lastAcked
  }
}

/// Notices a half-dead socket (nothing arrives, sends still "succeed"): after a ping the server must say
/// something (a pong or any message) within `timeout`. Times are monotonic seconds that keep counting
/// through sleep.
struct ReplyDeadline {
  enum Verdict: Equatable {
    /// Heard from the server since the ping (or still within the deadline).
    case alive
    /// Silence past the deadline: reconnect.
    case dead
    /// The check itself ran more than `maxLateness` after its deadline, so the app was suspended or
    /// the device asleep and the silence proves nothing yet: ping again.
    case stale
  }

  let timeout: Double
  let maxLateness: Double
  private(set) var waitingSince: Double?

  init(timeout: Double = 10, maxLateness: Double = 2) {
    self.timeout = timeout
    self.maxLateness = maxLateness
  }

  mutating func pinged(at now: Double) {
    if waitingSince == nil { waitingSince = now }
  }

  mutating func heard() {
    waitingSince = nil
  }

  /// Run `timeout` after a ping.
  func verdict(at now: Double) -> Verdict {
    guard let since = waitingSince else { return .alive }
    let late = now - (since + timeout)
    if late < 0 { return .alive }
    return late > maxLateness ? .stale : .dead
  }
}

/// When a network change (see `IngestClient.pathChanged`) may reconnect without the backoff: only a
/// socket that had been up a while. One that just opened goes through the backoff, so flapping
/// Wi-Fi/cellular can't make it reconnect over and over.
enum NetworkChange {
  static let settledMs: Int64 = 10_000

  /// `openForMs`: how long the socket has been open (nil while still connecting).
  static func reconnectAtOnce(openForMs: Int64?) -> Bool {
    guard let openForMs else { return false }
    return openForMs >= settledMs
  }
}
