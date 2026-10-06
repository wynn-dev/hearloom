import Foundation
import Network

protocol IngestClientDelegate: AnyObject {
  func ingestOpened(_ client: IngestClient)
  func ingestClosed(_ client: IngestClient, reason: String)
  func ingest(_ client: IngestClient, received message: [String: Any])
}

/// The phone -> server WebSocket (`/ingest`). Reconnects with backoff; resend logic lives in the engine.
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
  private let pathMonitor = NWPathMonitor()
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
      guard let self, path.status == .satisfied, self.state == .waiting else { return }
      self.queue.async { self.connectNow() }
    }
    pathMonitor.start(queue: queue)
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

  func send(text: String) {
    guard state == .open, let task else { return }
    pendingSends += 1
    task.send(.string(text)) { [weak self] error in self?.sent(error) }
  }

  func send(data: Data) {
    guard state == .open, let task else { return }
    pendingSends += 1
    task.send(.data(data)) { [weak self] error in self?.sent(error) }
  }

  func send(json: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: json), let text = String(data: data, encoding: .utf8)
    else { return }
    send(text: text)
  }

  // MARK: private

  private func sent(_ error: Error?) {
    queue.async {
      self.pendingSends = max(0, self.pendingSends - 1)
      if let error { Log.warn("ingest: send failed: \(error.localizedDescription)") }
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
    guard state != .idle else { return }
    lastError = reason
    let wasOpen = state == .open
    teardown(code: .abnormalClosure)
    if wasOpen { delegate?.ingestClosed(self, reason: reason) }
    scheduleRetry()
  }

  private func scheduleRetry() {
    guard endpoint != nil else { return }
    state = .waiting
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
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 20, repeating: 20)
    timer.setEventHandler { [weak self] in
      guard let self, gen == self.generation else { return }
      self.task?.sendPing { error in
        if let error { self.queue.async { if gen == self.generation { self.failed("ping: \(error.localizedDescription)") } } }
      }
    }
    timer.resume()
    pingTimer = timer
  }

  // MARK: URLSessionWebSocketDelegate (delivered on `queue`)

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard webSocketTask === task else { return }
    state = .open
    backoff = 1
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
      lastError = "unauthorized"
      Log.error("ingest: server rejected the session token (401)")
    }
    failed(error?.localizedDescription ?? "completed")
  }
}
