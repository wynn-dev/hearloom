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

/// Notices a half-dead socket (nothing arrives, sends still "succeed"): after a ping the server must say
/// something (a pong or any message) within `timeout`. Times are seconds of uptime.
struct ReplyDeadline {
  enum Verdict: Equatable {
    /// Heard from the server since the ping (or still within the deadline).
    case alive
    /// Silence past the deadline: reconnect.
    case dead
    /// The check ran far later than scheduled, so the app was suspended and the silence proves
    /// nothing yet: ping again.
    case stale
  }

  let timeout: Double
  private(set) var waitingSince: Double?

  init(timeout: Double = 10) {
    self.timeout = timeout
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
    let waited = now - since
    if waited < timeout { return .alive }
    return waited > timeout * 2 ? .stale : .dead
  }
}
