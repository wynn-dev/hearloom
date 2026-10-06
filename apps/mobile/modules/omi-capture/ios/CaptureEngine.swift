import Foundation
import UIKit

/// Owns capture end to end so it keeps working when JS isn't running (background relaunch by iOS):
/// pendant -> frame journal -> ingest socket, plus pendant buttons and server-pushed notifications.
/// Everything runs on `queue`.
final class CaptureEngine: NSObject {
  static let shared = CaptureEngine()

  let queue = DispatchQueue(label: "hearloom.capture", qos: .userInitiated)
  private var settings = CaptureStore.load()
  private var token: String? = TokenStore.get()
  private lazy var journal: FrameJournal = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return FrameJournal(root: base.appendingPathComponent("hearloom/journal", isDirectory: true))
  }()
  private lazy var ble: OmiBLE = {
    let b = OmiBLE(queue: queue)
    b.delegate = self
    return b
  }()
  private lazy var uplink: IngestClient = {
    let c = IngestClient(queue: queue)
    c.delegate = self
    return c
  }()

  private var booted = false
  // Current pendant connection.
  private var wearable: WearableInfo?
  private var codec: Int?
  private var charging = false
  private var activeStreamId: String?
  /// Capture time of the last frame, for stamping the next one; cleared when the timeline breaks
  /// (mute, disconnect) so the next frame re-anchors to the wall clock.
  private var lastFrameAt: Int64?
  /// Last frame stored in the active stream (its end time if it stops now).
  private var streamLastFrameAt: Int64?
  private var framesThisStream: Int64 = 0
  // Uplink protocol state, reset on every (re)connect.
  private struct Slot {
    let streamId: String
    var welcomed = false
    var acked: Int64 = -1
    var sent: Int64 = -1
    var byeSent = false
  }
  private var slots: [Int: Slot] = [:]
  private var nextSlot = 0
  private var pumpTimer: DispatchSourceTimer?
  private var lastAckAt: Int64?
  /// The server accepted this phone on the current socket (`ready`).
  private var serverReady = false
  private var lastServerError: String?
  private var lastServerErrorCode: String?
  /// Streams the server refused (unsupported codec, another account's stream). Kept on disk, not retried
  /// until the server or account changes.
  private var rejectedStreams: Set<String> = []
  /// Events that must reach the server even if we're offline now (bookmarks, mutes, ...). An event
  /// leaves the outbox only once the socket has sent it.
  private var outbox: [(id: String, msg: [String: Any])] = []
  private var outboxInflight: Set<String> = []
  /// Counts socket connections, so a late send callback can't touch the next connection's state.
  private var connection = 0
  private static let outboxKey = "hearloom.capture.outbox"
  private static let maxInflightFrames: Int64 = 3000
  private static let batchFrames = 100

  // JS bridge
  private var eventSink: ((String, [String: Any]) -> Void)?
  private var statusScheduled = false

  // MARK: lifecycle

  /// Called from the app delegate at launch (also on background relaunch by state restoration).
  func boot() {
    queue.async {
      guard !self.booted else { return }
      self.booted = true
      self.loadOutbox()
      _ = self.journal
      self.ble.start()
      self.applyTarget()
      self.startUplinkIfPossible()
      Log.info("engine: booted (capture \(self.settings.captureEnabled ? "on" : "off"))")
    }
  }

  func setEventSink(_ sink: ((String, [String: Any]) -> Void)?) {
    queue.async {
      self.eventSink = sink
      self.emitStatus()
    }
  }

  // MARK: JS commands

  func configure(serverURL: String, token: String, phoneId: String) {
    queue.async {
      let changed = self.settings.serverURL != serverURL || self.token != token || self.settings.phoneId != phoneId
      self.settings.serverURL = serverURL
      self.settings.phoneId = phoneId
      CaptureStore.save(self.settings)
      TokenStore.set(token)
      self.token = token
      if changed { self.rejectedStreams = [] }
      // Also retries now if the server refused us earlier (e.g. the phone was just re-registered).
      if changed || self.uplink.state == .idle || self.uplink.state == .waiting { self.startUplinkIfPossible() }
      self.emitStatus()
    }
  }

  func signOut() {
    queue.async {
      // Close the stream locally; the app also tells the server (phones.signOut). Unsent frames stay in
      // the journal and upload if this account signs in again.
      self.endActiveStream()
      self.uplink.stop()
      self.stopPump()
      self.settings.captureEnabled = false
      self.settings.phoneId = nil
      CaptureStore.save(self.settings)
      TokenStore.set(nil)
      self.token = nil
      self.applyTarget()
      self.emitStatus()
    }
  }

  func startScan() { queue.async { self.ble.startScan() } }
  func stopScan() { queue.async { self.ble.stopScan() } }

  func pair(_ peripheralId: String) {
    queue.async {
      self.ble.stopScan()
      self.settings.pairedPeripheralId = peripheralId
      self.settings.captureEnabled = true
      CaptureStore.save(self.settings)
      self.applyTarget()
      self.emitStatus()
    }
  }

  func forget() {
    queue.async {
      self.settings.pairedPeripheralId = nil
      self.settings.captureEnabled = false
      CaptureStore.save(self.settings)
      self.endActiveStream()
      self.applyTarget()
      self.emitStatus()
    }
  }

  func setCaptureEnabled(_ on: Bool) {
    queue.async {
      self.settings.captureEnabled = on
      CaptureStore.save(self.settings)
      if !on { self.endActiveStream() }
      self.applyTarget()
      self.emitStatus()
    }
  }

  func setMuted(_ muted: Bool) {
    queue.async { self.applyMute(muted, fromButton: false) }
  }

  func testHaptic(_ pattern: Int) {
    queue.async { self.ble.haptic(UInt8(clamping: pattern)) }
  }

  func status() -> [String: Any] {
    queue.sync { statusDict() }
  }

  // MARK: capture

  private func applyTarget() {
    let id = settings.captureEnabled ? settings.pairedPeripheralId.flatMap(UUID.init(uuidString:)) : nil
    ble.setTarget(id)
  }

  private func startStream(codec: Int, wearable: WearableInfo) {
    endActiveStream()
    let frameMs = codec == 20 ? 10 : 20
    let meta = StreamMeta(
      id: UUID().uuidString.lowercased(), codec: codec, sampleRate: 16000, frameMs: frameMs, startedAt: nowMs(),
      endedAt: nil, wearable: wearable)
    journal.create(meta)
    activeStreamId = meta.id
    lastFrameAt = nil
    streamLastFrameAt = nil
    framesThisStream = 0
    Log.info("engine: stream \(meta.id) started (codec \(codec))")
    if uplink.state == .open { bind(meta.id) }
  }

  /// Mark the current stream finished at its last frame (like a stream recovered at launch); it is
  /// uploaded, then closed on the server with `bye`.
  private func endActiveStream() {
    guard let id = activeStreamId else { return }
    activeStreamId = nil
    let endedAt = streamLastFrameAt ?? journal.meta(id)?.startedAt ?? nowMs()
    journal.updateMeta(id) { $0.endedAt = endedAt }
    journal.seal(id)
    pump()
  }

  /// Capture time for the next frame. Contiguous frames advance exactly one frame duration (plus any
  /// lost notifications); if we've fallen far behind the wall clock the mic was asleep (silence), so
  /// re-anchor to now. Bursts after a BLE stall keep their earlier, correct times. Times never go
  /// backwards within a stream (the server's chunk timing relies on it).
  private func stamp(frameMs: Int, lost: Int) -> Int64 {
    let now = nowMs()
    let floor = streamLastFrameAt.map { $0 + Int64(frameMs) } ?? 0
    guard let last = lastFrameAt else {
      let at = max(now, floor)
      lastFrameAt = at
      return at
    }
    var at = last + Int64(frameMs * (1 + lost))
    if at < now - 1500 {
      at = now
    } else if at > now + 2000 {
      // An implausible lost count (or the wall clock stepped back): don't run ahead of real time.
      at = max(now, last + Int64(frameMs))
    }
    at = max(at, floor)
    lastFrameAt = at
    return at
  }

  private func applyMute(_ muted: Bool, fromButton: Bool) {
    guard settings.muted != muted else { return }
    settings.muted = muted
    CaptureStore.save(settings)
    lastFrameAt = nil
    enqueueEvent(["t": "event", "kind": muted ? "muted" : "unmuted", "at": nowMs()])
    if fromButton || settings.pendantHaptic { ble.haptic(muted ? 3 : 1) }
    Log.info("engine: \(muted ? "muted" : "unmuted")")
    emitStatus()
  }

  private func handleButton(_ code: Int) {
    let action: String
    switch code {
    case 1: action = settings.button.tap
    case 2: action = settings.button.doubleTap
    case 5: action = settings.button.hold
    default: return
    }
    sendIfOpen(["t": "event", "kind": "button", "value": code, "at": nowMs()])
    switch action {
    case "bookmark":
      enqueueEvent(["t": "event", "kind": "bookmark", "at": nowMs()])
      ble.haptic(1)
      emit("onButton", ["action": "bookmark"])
    case "mute":
      applyMute(!settings.muted, fromButton: true)
    case "ack_nudge":
      enqueueEvent(["t": "event", "kind": "ack_nudge", "at": nowMs()])
      ble.haptic(1)
    default:
      break
    }
  }

  // MARK: uplink

  private func ingestURL() -> URL? {
    guard let s = settings.serverURL, var c = URLComponents(string: s) else { return nil }
    c.scheme = c.scheme == "https" ? "wss" : "ws"
    c.path = (c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path) + "/ingest"
    return c.url
  }

  private func startUplinkIfPossible() {
    guard let url = ingestURL(), let token, settings.phoneId != nil else { return }
    uplink.start(url: url, token: token)
  }

  private func bind(_ streamId: String) {
    guard let meta = journal.meta(streamId), let phoneId = settings.phoneId,
          !rejectedStreams.contains(streamId) else { return }
    if slots.values.contains(where: { $0.streamId == streamId }) { return }
    let slot = nextSlot
    nextSlot = (nextSlot + 1) % 256
    slots[slot] = Slot(streamId: streamId)
    var hello: [String: Any] = [
      "t": "hello", "v": 1, "slot": slot, "phoneId": phoneId,
      "stream": [
        "id": meta.id, "codec": meta.codec, "sampleRate": meta.sampleRate, "frameMs": meta.frameMs,
        "startedAt": meta.startedAt,
      ],
    ]
    if let w = meta.wearable { hello["wearable"] = w.json }
    uplink.send(json: hello)
  }

  private func startPump() {
    guard pumpTimer == nil else { return }
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + 0.3, repeating: 0.3)
    t.setEventHandler { [weak self] in self?.pump() }
    t.resume()
    pumpTimer = t
  }

  private func stopPump() {
    pumpTimer?.cancel()
    pumpTimer = nil
  }

  /// Send journaled frames the server hasn't acknowledged, within an in-flight window.
  private func pump() {
    guard uplink.state == .open else { return }
    for (slotId, var slot) in slots where slot.welcomed && !slot.byeSent {
      let id = slot.streamId
      let next = journal.nextSeq(id)
      while slot.sent + 1 < next, slot.sent - slot.acked < CaptureEngine.maxInflightFrames, uplink.pendingSends < 64 {
        let frames = journal.frames(id, from: slot.sent + 1, max: CaptureEngine.batchFrames)
        guard let last = frames.last else { break }
        uplink.send(data: BatchCodec.encode(slot: slotId, frames: frames))
        slot.sent = last.seq
      }
      if let meta = journal.meta(id), let endedAt = meta.endedAt, slot.acked >= next - 1 {
        uplink.send(json: ["t": "bye", "slot": slotId, "endedAt": endedAt])
        slot.byeSent = true
        journal.remove(id)
        Log.info("engine: stream \(id) fully uploaded")
      }
      slots[slotId] = slot.byeSent ? nil : slot
    }
  }

  private func sendIfOpen(_ msg: [String: Any]) {
    if uplink.state == .open { uplink.send(json: msg) }
  }

  private func enqueueEvent(_ msg: [String: Any]) {
    outbox.append((UUID().uuidString, msg))
    if outbox.count > 500 { outbox.removeFirst(outbox.count - 500) }
    saveOutbox()
    flushOutbox()
  }

  private func flushOutbox() {
    guard uplink.state == .open, serverReady else { return }
    let conn = connection
    for (id, msg) in outbox where !outboxInflight.contains(id) {
      let queued = uplink.send(json: msg) { [weak self] ok in
        guard let self else { return }
        if conn == self.connection { self.outboxInflight.remove(id) }
        guard ok else { return } // stays queued; resent after the next `ready`
        self.outbox.removeAll { $0.id == id }
        self.saveOutbox()
      }
      if queued { outboxInflight.insert(id) }
    }
  }

  private func loadOutbox() {
    guard let data = UserDefaults.standard.data(forKey: CaptureEngine.outboxKey),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
    outbox = arr.compactMap { e in
      guard let id = e["id"] as? String, let msg = e["msg"] as? [String: Any] else { return nil }
      return (id, msg)
    }
  }

  private func saveOutbox() {
    let arr = outbox.map { ["id": $0.id, "msg": $0.msg] as [String: Any] }
    if let data = try? JSONSerialization.data(withJSONObject: arr) {
      UserDefaults.standard.set(data, forKey: CaptureEngine.outboxKey)
    }
  }

  private func applyConfig(_ config: [String: Any]) {
    if let b = config["button"] as? [String: Any] {
      settings.button = ButtonConfig(
        tap: b["tap"] as? String ?? settings.button.tap,
        doubleTap: b["doubleTap"] as? String ?? settings.button.doubleTap,
        hold: b["hold"] as? String ?? settings.button.hold)
    }
    if let h = config["pendantHaptic"] as? Bool { settings.pendantHaptic = h }
    CaptureStore.save(settings)
  }

  // MARK: status

  private func statusDict() -> [String: Any] {
    let backlog = journal.streamIds.reduce(Int64(0)) { $0 + journal.unacked($1) }
    var d: [String: Any] = [
      "configured": settings.serverURL != nil && token != nil && settings.phoneId != nil,
      "captureEnabled": settings.captureEnabled,
      "muted": settings.muted,
      "paired": settings.pairedPeripheralId != nil,
      "ble": ble.state.rawValue,
      "uplink": uplink.state.rawValue,
      "backlogFrames": backlog,
      "journalBytes": journal.diskBytes(),
      "framesThisStream": framesThisStream,
      "charging": charging,
      "button": ["tap": settings.button.tap, "doubleTap": settings.button.doubleTap, "hold": settings.button.hold],
    ]
    if let s = settings.serverURL { d["serverURL"] = s }
    if let p = settings.pairedPeripheralId { d["pairedPeripheralId"] = p }
    if let w = wearable { d["wearable"] = w.json }
    if let c = codec { d["codec"] = c }
    if let a = lastAckAt { d["lastAckAt"] = a }
    if let e = uplink.lastError { d["uplinkError"] = e }
    if let e = lastServerError { d["serverError"] = e }
    if let c = lastServerErrorCode { d["serverErrorCode"] = c }
    if !rejectedStreams.isEmpty { d["rejectedStreams"] = rejectedStreams.count }
    if let s = activeStreamId { d["streamId"] = s }
    return d
  }

  /// Throttled status event to JS (at most every 500 ms).
  private func emitStatus() {
    guard eventSink != nil, !statusScheduled else { return }
    statusScheduled = true
    queue.asyncAfter(deadline: .now() + 0.5) {
      self.statusScheduled = false
      self.emit("onStatus", self.statusDict())
    }
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    guard let sink = eventSink else { return }
    DispatchQueue.main.async { sink(name, body) }
  }
}

// MARK: - BLE

extension CaptureEngine: OmiBLEDelegate {
  func ble(_ ble: OmiBLE, stateChanged state: OmiBLE.State) {
    emitStatus()
  }

  func ble(_ ble: OmiBLE, discovered devices: [OmiBLE.Discovered]) {
    emit("onDevices", ["devices": devices.map { ["id": $0.id, "name": $0.name, "rssi": $0.rssi] }])
  }

  func ble(_ ble: OmiBLE, readyWithCodec codec: Int, info: WearableInfo) {
    guard codec == 20 || codec == 21 else {
      Log.error("ble: unsupported codec \(codec); update the pendant firmware")
      lastServerError = "Unsupported codec \(codec). Update the Omi firmware."
      emitStatus()
      return
    }
    self.codec = codec
    wearable = info
    startStream(codec: codec, wearable: info)
    enqueueEvent(["t": "wearable", "wearable": info.json, "connected": true, "at": nowMs()])
    emitStatus()
  }

  func ble(_ ble: OmiBLE, infoUpdated info: WearableInfo) {
    wearable = info
    if let id = activeStreamId { journal.updateMeta(id) { $0.wearable = info } }
    sendIfOpen(["t": "wearable", "wearable": info.json, "connected": true, "at": nowMs()])
    emitStatus()
  }

  func bleDisconnected(_ ble: OmiBLE, peripheralId: String, error: Error?) {
    // Keep the stream open: if the pendant comes back, the next connection starts a new stream and
    // closes this one. An open stream tells the server capture is still intended (for alerts).
    lastFrameAt = nil
    if let w = wearable {
      enqueueEvent(["t": "wearable", "wearable": w.json, "connected": false, "at": nowMs()])
    }
    emitStatus()
  }

  func ble(_ ble: OmiBLE, frames: [Data], lost: Int) {
    guard let id = activeStreamId, let meta = journal.meta(id), !settings.muted else { return }
    for (i, frame) in frames.enumerated() {
      let at = stamp(frameMs: meta.frameMs, lost: i == 0 ? lost : 0)
      journal.append(id, at: at, data: frame)
      streamLastFrameAt = at
      framesThisStream += 1
    }
    if framesThisStream % 50 == 0 { emitStatus() }
  }

  func ble(_ ble: OmiBLE, battery: Int) {
    wearable?.battery = battery
    sendIfOpen([
      "t": "event", "kind": "battery", "value": battery, "peripheralId": wearable?.peripheralId ?? "", "at": nowMs(),
    ])
    emitStatus()
  }

  func ble(_ ble: OmiBLE, charging: Bool) {
    self.charging = charging
    sendIfOpen([
      "t": "event", "kind": "charging", "value": charging, "peripheralId": wearable?.peripheralId ?? "", "at": nowMs(),
    ])
    emitStatus()
  }

  func ble(_ ble: OmiBLE, button: Int) {
    handleButton(button)
  }
}

// MARK: - Uplink

extension CaptureEngine: IngestClientDelegate {
  func ingestOpened(_ client: IngestClient) {
    Log.info("ingest: connected")
    connection += 1
    slots = [:]
    serverReady = false
    outboxInflight = []
    lastServerError = nil
    lastServerErrorCode = nil
    guard let phoneId = settings.phoneId else { return }
    // Register for notifications/config first, then upload backlog streams and the live one.
    uplink.send(json: ["t": "presence", "v": 1, "phoneId": phoneId])
    var ids = journal.streamIds.filter { $0 != activeStreamId }
    if let active = activeStreamId { ids.append(active) }
    for id in ids { bind(id) }
    startPump()
    emitStatus()
  }

  func ingestClosed(_ client: IngestClient, reason: String) {
    Log.warn("ingest: closed (\(reason))")
    slots = [:]
    serverReady = false
    outboxInflight = []
    stopPump()
    emitStatus()
  }

  func ingest(_ client: IngestClient, received msg: [String: Any]) {
    switch msg["t"] as? String {
    case "ready":
      serverReady = true
      uplink.markHealthy()
      if let config = msg["config"] as? [String: Any] { applyConfig(config) }
      flushOutbox()
      emitStatus()
    case "welcome":
      guard let slotId = msg["slot"] as? Int, var slot = slots[slotId] else { return }
      let acked = (msg["ackedSeq"] as? NSNumber)?.int64Value ?? -1
      slot.welcomed = true
      slot.acked = acked
      slot.sent = acked
      slots[slotId] = slot
      journal.trim(slot.streamId, through: acked)
      if let config = msg["config"] as? [String: Any] { applyConfig(config) }
      pump()
    case "ack":
      guard let slotId = msg["slot"] as? Int, var slot = slots[slotId],
            let seq = (msg["seq"] as? NSNumber)?.int64Value else { return }
      if seq > slot.acked {
        slot.acked = seq
        slots[slotId] = slot
        journal.trim(slot.streamId, through: seq)
        lastAckAt = nowMs()
      }
      pump()
      emitStatus()
    case "notify":
      guard let id = msg["id"] as? String else { return }
      LocalNotifier.post(
        id: id,
        title: msg["title"] as? String ?? "",
        body: msg["body"] as? String ?? "",
        category: msg["category"] as? String ?? "HL_NUDGE",
        threadId: msg["threadId"] as? String,
        deepLink: msg["deepLink"] as? String,
        level: msg["interruptionLevel"] as? String ?? "active")
      if let haptic = msg["haptic"] as? String, settings.pendantHaptic {
        ble.haptic(haptic == "short" ? 1 : haptic == "long" ? 3 : 2)
      }
      uplink.send(json: ["t": "notify_ack", "id": id])
    case "haptic":
      let p = msg["pattern"] as? String
      ble.haptic(p == "short" ? 1 : p == "long" ? 3 : 2)
    case "config":
      if let config = msg["config"] as? [String: Any] { applyConfig(config) }
      emitStatus()
    case "error":
      let code = msg["code"] as? String ?? "error"
      let message = msg["message"] as? String ?? ""
      Log.error("ingest: server error \(code): \(message)")
      serverError(code: code, message: message, fatal: msg["fatal"] as? Bool ?? false, slot: msg["slot"] as? Int)
      emitStatus()
    default:
      break
    }
  }

  private func serverError(code: String, message: String, fatal: Bool, slot slotId: Int?) {
    if fatal {
      // unknown_phone (the app re-registers it), protocol_version (needs an app update): a quick
      // retry can't succeed, so wait long instead of reconnecting every second.
      lastServerError = "\(code): \(message)"
      lastServerErrorCode = code
      uplink.pause(code)
      return
    }
    guard let slotId, let slot = slots[slotId] else { return }
    switch code {
    case "seq_gap":
      // An earlier batch never arrived: resend from the server's ack.
      var s = slot
      s.sent = s.acked
      slots[slotId] = s
      pump()
    case "codec", "stream":
      lastServerError = "\(code): \(message)"
      lastServerErrorCode = code
      rejectedStreams.insert(slot.streamId)
      slots[slotId] = nil
    default:
      // The server lost track of this slot (e.g. a failed hello): start over.
      uplink.reset("server error \(code)")
    }
  }
}
