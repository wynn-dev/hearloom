import Foundation
import Network

protocol IngestClientDelegate: AnyObject {
  func ingestOpened(_ client: IngestClient)
  func ingestClosed(_ client: IngestClient, reason: String)
  func ingest(_ client: IngestClient, received message: [String: Any])
}

/// The phone -> server WebSocket (`/ingest`). Reconnects with backoff; resend logic lives in the engine.
/// Backoff only resets once the server accepted the phone (`markHealthy`), so a server that accepts the
/// socket and then rejects us doesn't cause a reconnect loop.
final class IngestClient: NSObject, URLSessionWebSocketDelegate {
  enum State: String { case idle, connecting, open, waiting }

  weak var delegate: IngestClientDelegate?
  private let queue: DispatchQueue
  private var session: URLSession!
  private var task: URLSessionWebSocketTask?
  private var generation = 0
  private var backoff: TimeInterval = 1
  private var retry: DispatchWorkItem?
  private var pingTimer: DispatchSourceTimer?
  private var replyDeadline = ReplyDeadline()
  private static let pingInterval: TimeInterval = 20
  private let pathMonitor = NWPathMonitor()
  private var pathKey: String?
  private var endpoint: (url: URL, token: String)?
  private(set) var state: State = .idle
  private(set) var lastError: String?
  /// Sends handed to URLSession that haven't completed yet (simple backpressure signal).
  private(set) var pendingSends = 0

  init(queue: DispatchQueue) {
    self.queue = queue
    super.init()
    let ops = OperationQueue()
    ops.underlyingQueue = queue
    ops.maxConcurrentOperationCount = 1
    let config = URLSessionConfiguration.default
    config.waitsForConnectivity = true
    config.timeoutIntervalForRequest = 30
    session = URLSession(configuration: config, delegate: self, delegateQueue: ops)
    pathMonitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      self.queue.async { self.pathChanged(path) }
    }
    pathMonitor.start(queue: queue)
  }

  /// The network came back: connect now instead of after the backoff. The route changed while connected
  /// (the preferred interface: Wi-Fi <-> cellular, VPN up/down): the socket is likely dead without anyone
  /// saying so, so reconnect right away rather than waiting for the ping deadline. (Only the preferred
  /// interface counts: a secondary one coming and going doesn't move the socket, and a VPN that stays
  /// up carries it across Wi-Fi/cellular changes.)
  private func pathChanged(_ path: NWPath) {
    let key = "\(path.status)|" + (path.availableInterfaces.first.map { "\($0.type):\($0.name)" } ?? "none")
    let changed = pathKey != nil && pathKey != key
    pathKey = key
    switch state {
    case .waiting:
      if path.status == .satisfied { connectNow() }
    case .open, .connecting:
      guard changed else { return }
      Log.info("ingest: network changed; reconnecting")
      failed("network changed")
      if path.status == .satisfied { connectNow() }
    case .idle:
      break
    }
  }

  func start(url: URL, token: String) {
    endpoint = (url, token)
    backoff = 1
    connectNow()
  }

  func stop() {
    endpoint = nil
    retry?.cancel()
    teardown(code: .normalClosure)
    state = .idle
  }

  /// The server accepted this phone on the current socket.
  func markHealthy() { backoff = 1 }

  /// Drop the socket and reconnect after the usual backoff (the engine resyncs from `welcome`).
  func reset(_ reason: String) {
    guard state == .open || state == .connecting else { return }
    failed(reason)
  }

  /// The server refused us for a reason a quick retry won't fix (unknown phone, bad token, old
  /// protocol). Try again much later; `start` (new sign-in/config) retries immediately.
  func pause(_ reason: String, seconds: TimeInterval = 300) {
    guard endpoint != nil else { return }
    let wasOpen = state == .open
    lastError = reason
    retry?.cancel()
    teardown(code: .normalClosure)
    if wasOpen { delegate?.ingestClosed(self, reason: reason) }
    state = .waiting
    let work = DispatchWorkItem { [weak self] in self?.connectNow() }
    retry = work
    queue.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  /// Queue a message. `done` runs on `queue` with whether URLSession handed it to the socket; it is not
  /// called if the socket isn't open. A failed send drops the connection: later frames must not arrive
  /// without the ones before them.
  @discardableResult
  func send(text: String, done: ((Bool) -> Void)? = nil) -> Bool {
    guard state == .open, let task else { return false }
    pendingSends += 1
    let gen = generation
    task.send(.string(text)) { [weak self] error in self?.sent(error, gen, done) }
    return true
  }

  @discardableResult
  func send(data: Data) -> Bool {
    guard state == .open, let task else { return false }
    pendingSends += 1
    let gen = generation
    task.send(.data(data)) { [weak self] error in self?.sent(error, gen, nil) }
    return true
  }

  @discardableResult
  func send(json: [String: Any], done: ((Bool) -> Void)? = nil) -> Bool {
    guard let data = try? JSONSerialization.data(withJSONObject: json), let text = String(data: data, encoding: .utf8)
    else { return false }
    return send(text: text, done: done)
  }

  // MARK: private

  private func sent(_ error: Error?, _ gen: Int, _ done: ((Bool) -> Void)?) {
    queue.async {
      guard gen == self.generation else {
        done?(false)
        return
      }
      self.pendingSends = max(0, self.pendingSends - 1)
      done?(error == nil)
      if let error {
        Log.warn("ingest: send failed: \(error.localizedDescription)")
        self.failed("send: \(error.localizedDescription)")
      }
    }
  }

  private func connectNow() {
    guard let endpoint else { return }
    retry?.cancel()
    teardown(code: .goingAway)
    generation += 1
    var req = URLRequest(url: endpoint.url)
    req.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
    let t = session.webSocketTask(with: req)
    t.maximumMessageSize = 4 * 1024 * 1024
    task = t
    state = .connecting
    t.resume()
    receive(generation)
  }

  private func receive(_ gen: Int) {
    task?.receive { [weak self] result in
      guard let self else { return }
      self.queue.async {
        guard gen == self.generation else { return }
        if case .success = result { self.replyDeadline.heard() }
        switch result {
        case .success(.string(let text)):
          if let data = text.data(using: .utf8),
             let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            self.delegate?.ingest(self, received: obj)
          }
          self.receive(gen)
        case .success(.data):
          self.receive(gen)
        case .success:
          self.receive(gen)
        case .failure(let error):
          self.failed(error.localizedDescription)
        }
      }
    }
  }

  private func failed(_ reason: String) {
    // Only the first failure of a connection counts (cancelled sends/receives report errors too).
    guard state == .open || state == .connecting else { return }
    lastError = reason
    let wasOpen = state == .open
    teardown(code: .abnormalClosure)
    if wasOpen { delegate?.ingestClosed(self, reason: reason) }
    scheduleRetry()
  }

  private func scheduleRetry() {
    guard endpoint != nil else { return }
    state = .waiting
    retry?.cancel()
    let delay = backoff
    backoff = min(backoff * 2, 30)
    let work = DispatchWorkItem { [weak self] in self?.connectNow() }
    retry = work
    queue.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func teardown(code: URLSessionWebSocketTask.CloseCode) {
    pingTimer?.cancel()
    pingTimer = nil
    task?.cancel(with: code, reason: nil)
    task = nil
    pendingSends = 0
  }

  private func startPings(_ gen: Int) {
    replyDeadline = ReplyDeadline()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + IngestClient.pingInterval, repeating: IngestClient.pingInterval)
    timer.setEventHandler { [weak self] in self?.ping(gen) }
    timer.resume()
    pingTimer = timer
  }

  /// A WebSocket ping plus a JSON `ping` (the server answers both); any reply, or any other message,
  /// within the deadline proves the socket alive. Without one it's half-dead: reconnect.
  private func ping(_ gen: Int) {
    guard gen == generation, state == .open, let task else { return }
    replyDeadline.pinged(at: IngestClient.uptime())
    task.sendPing { [weak self] error in
      guard let self else { return }
      self.queue.async {
        guard gen == self.generation else { return }
        if let error {
          self.failed("ping: \(error.localizedDescription)")
        } else {
          self.replyDeadline.heard()
        }
      }
    }
    send(json: ["t": "ping", "at": nowMs()])
    queue.asyncAfter(deadline: .now() + replyDeadline.timeout) { [weak self] in self?.checkReply(gen) }
  }

  private func checkReply(_ gen: Int) {
    guard gen == generation, state == .open else { return }
    switch replyDeadline.verdict(at: IngestClient.uptime()) {
    case .alive:
      break
    case .dead:
      Log.warn("ingest: no reply within \(Int(replyDeadline.timeout)) s of a ping; reconnecting")
      failed("no reply to ping")
    case .stale:
      replyDeadline.heard()
      ping(gen)
    }
  }

  private static func uptime() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

  // MARK: URLSessionWebSocketDelegate (delivered on `queue`)

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard webSocketTask === task else { return }
    state = .open
    lastError = nil
    startPings(generation)
    delegate?.ingestOpened(self)
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    guard webSocketTask === task else { return }
    let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    failed("closed \(closeCode.rawValue) \(text)")
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard task === self.task else { return }
    if let http = task.response as? HTTPURLResponse, http.statusCode == 401 {
      Log.error("ingest: server rejected the session token (401)")
      return pause("unauthorized")
    }
    failed(error?.localizedDescription ?? "completed")
  }
}
