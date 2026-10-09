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
    b.hapticWriterChanged = { [weak self] writer in self?.haptics.setWriter(writer) }
    return b
  }()
  /// Server-sent buzz patterns (`haptic_seq`), timed on their own queue.
  private lazy var haptics = HapticPlayer { [weak self] outcome in
    self?.queue.async { self?.hapticFinished(outcome) }
  }
  private var buttonFilter = ButtonFilter()
  /// Protocol features this app supports, announced in `presence` and `hello`.
  private static let features = ["haptic_seq"]
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
  /// The charging state was reported on this connection (it's read and subscribed, so it can arrive twice).
  private var chargingReported = false
  private var activeStreamId: String?
  /// The active stream takes frames from the current connection. After a disconnect the stream stays
  /// open (it tells the server capture is still intended, for alerts) but takes no more frames; the
  /// next connection ends it at its last frame and starts a new one.
  private var streamLive = false
  /// Frames that arrive after a (re)connect before its stream starts (the pendant sends audio before
  /// codec and device info are read). Journaled into the new stream, stamped by arrival time.
  private var pendingFrames: [(data: Data, lost: Int, arrivedAt: Int64)] = []
  /// Frames not held because `pendingFrames` was full.
  private var pendingDropped = 0
  private static let maxPendingFrames = 1500 // 30 s of 20 ms frames (codec 21), 15 s of 10 ms ones
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

  // Recordings made by the pendant while the phone was away (offline storage).
  private enum OfflineState: String { case idle, requesting, downloading, advancing }
  private var offlineState = OfflineState.idle
  private var offlineStreamId: String?
  private var offlineParser = OfflineRecordParser()
  private var offlineClock = OfflineClock()
  /// Frames saved by the current/last sync.
  private var offlineFrames: Int64 = 0
  private var offlineLastAt: Int64?
  private var offlineUnread: UInt32 = 0
  /// The pendant's data before this seq is stored here (never read it again).
  private var offlineSyncedTo: UInt64 = 0
  /// Failed syncs in a row, and when to try again (ms).
  private var offlineFailures = 0
  private var offlineRetryAt: Int64 = 0
  private var offlineStopSentAt: Int64 = 0

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
    let early = pendingFrames
    if pendingDropped > 0 { Log.warn("engine: \(pendingDropped) frames before ready didn't fit and were dropped") }
    pendingFrames = []
    pendingDropped = 0
    let meta = StreamMeta(
      id: UUID().uuidString.lowercased(), codec: codec, sampleRate: 16000, frameMs: frameMs,
      startedAt: early.first?.arrivedAt ?? nowMs(), endedAt: nil, wearable: wearable)
    journal.create(meta)
    activeStreamId = meta.id
    streamLive = true
    lastFrameAt = nil
    streamLastFrameAt = nil
    framesThisStream = 0
    for f in early { appendFrame(f.data, lost: f.lost, arrivedAt: f.arrivedAt) }
    Log.info("engine: stream \(meta.id) started (codec \(codec), \(early.count) early frames)")
    if uplink.state == .open { bind(meta.id) }
  }

  /// Mark the current stream finished at its last frame (like a stream recovered at launch); it is
  /// uploaded, then closed on the server with `bye`.
  private func endActiveStream() {
    streamLive = false
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
  /// backwards within a stream (the server's chunk timing relies on it). `now` is when the frame arrived.
  private func stamp(frameMs: Int, lost: Int, now: Int64) -> Int64 {
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

  private func appendFrame(_ frame: Data, lost: Int, arrivedAt: Int64) {
    guard let id = activeStreamId, let meta = journal.meta(id) else { return }
    let at = stamp(frameMs: meta.frameMs, lost: lost, now: arrivedAt)
    journal.append(id, at: at, data: frame)
    streamLastFrameAt = at
    framesThisStream += 1
  }

  private func applyMute(_ muted: Bool, fromButton: Bool) {
    guard settings.muted != muted else { return }
    settings.muted = muted
    CaptureStore.save(settings)
    if muted { MuteLog.begin(at: nowMs()) } else { MuteLog.end(at: nowMs()) }
    lastFrameAt = nil
    enqueueEvent(["t": "event", "kind": muted ? "muted" : "unmuted", "at": nowMs()])
    if fromButton || settings.pendantHaptic { ble.haptic(muted ? 3 : 1) }
    Log.info("engine: \(muted ? "muted" : "unmuted")")
    emitStatus()
  }

  private func handleButton(_ code: Int) {
    guard [1, 2, 5].contains(code) else { return }
    sendIfOpen(["t": "event", "kind": "button", "value": code, "at": nowMs()])
    let action: String
    switch buttonFilter.gesture(code: code, at: nowMs()) {
    case .tap: action = settings.button.tap
    case .doubleTap: action = settings.button.doubleTap
    case .hold: action = settings.button.hold
    case nil: return // the release that ends a tap
    }
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
      "t": "hello", "v": 1, "slot": slot, "phoneId": phoneId, "features": CaptureEngine.features,
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

  /// Send journaled frames the server hasn't acknowledged, within an in-flight window: the live stream
  /// first, backlog only once it's caught up (see `UploadPlanner`).
  private func pump() {
    guard uplink.state == .open else { return }
    let lanes = slots.compactMap { slotId, slot -> UploadPlanner.Lane? in
      guard slot.welcomed, !slot.byeSent else { return nil }
      return UploadPlanner.Lane(
        slot: slotId, live: slot.streamId == activeStreamId, sent: slot.sent, acked: slot.acked,
        next: journal.nextSeq(slot.streamId), startedAt: journal.meta(slot.streamId)?.startedAt ?? 0)
    }
    let plan = UploadPlanner.plan(
      lanes, pendingSends: uplink.pendingSends, batchFrames: CaptureEngine.batchFrames,
      maxInflight: CaptureEngine.maxInflightFrames)
    for batch in plan {
      guard var slot = slots[batch.slot], slot.sent + 1 == batch.from else { continue }
      let frames = journal.frames(slot.streamId, from: batch.from, max: batch.count)
      guard let last = frames.last else { continue }
      uplink.send(data: BatchCodec.encode(slot: batch.slot, frames: frames))
      slot.sent = last.seq
      slots[batch.slot] = slot
    }
    for (slotId, slot) in slots where slot.welcomed && !slot.byeSent {
      let id = slot.streamId
      guard let endedAt = journal.meta(id)?.endedAt, slot.acked >= journal.nextSeq(id) - 1 else { continue }
      uplink.send(json: ["t": "bye", "slot": slotId, "endedAt": endedAt])
      slots[slotId] = nil
      journal.remove(id)
      Log.info("engine: stream \(id) fully uploaded")
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
      "offline": [
        "state": offlineState.rawValue, "frames": offlineFrames, "unreadPackets": offlineUnread,
        "ms": offlineFrames * Int64(codec == 20 ? 10 : 20),
      ],
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
    // iOS reports no disconnect when Bluetooth goes away; close out a sync in progress.
    if [.poweredOff, .unauthorized, .unsupported, .unknown].contains(state) {
      finishOffline(reason: "Bluetooth unavailable")
    }
    emitStatus()
  }

  func ble(_ ble: OmiBLE, discovered devices: [OmiBLE.Discovered]) {
    emit("onDevices", ["devices": devices.map { ["id": $0.id, "name": $0.name, "rssi": $0.rssi] }])
  }

  func ble(_ ble: OmiBLE, readyWithCodec codec: Int, info: WearableInfo) {
    guard codec == 20 || codec == 21 else {
      Log.error("ble: unsupported codec \(codec); update the pendant firmware")
      lastServerError = "Unsupported codec \(codec). Update the Omi firmware."
      pendingFrames = []
      pendingDropped = 0
      emitStatus()
      return
    }
    self.codec = codec
    wearable = info
    startStream(codec: codec, wearable: info)
    // Ready comes once device info and battery are read, so this is the connection's only report.
    enqueueEvent(["t": "wearable", "wearable": info.json, "connected": true, "at": nowMs()])
    // A storage status that arrived before the codec was known (fresh app process) was skipped.
    if offlineUnread > 0 { ble.refreshStorageStatus() }
    emitStatus()
  }

  func bleDisconnected(_ ble: OmiBLE, peripheralId: String, error: Error?) {
    // Stop feeding the stream but keep it open (see `streamLive`): it ends at its last frame when the
    // pendant comes back, so frames of the next connection never land in it.
    streamLive = false
    if !pendingFrames.isEmpty {
      Log.warn("engine: dropped \(pendingFrames.count + pendingDropped) frames received before ready")
    }
    pendingFrames = []
    pendingDropped = 0
    lastFrameAt = nil
    chargingReported = false
    finishOffline(reason: "disconnected")
    offlineSyncedTo = 0 // seqs are per pendant/connection; the pendant checkpoints on disconnect
    if let w = wearable {
      enqueueEvent(["t": "wearable", "wearable": w.json, "connected": false, "at": nowMs()])
    }
    emitStatus()
  }

  func ble(_ ble: OmiBLE, frames: [Data], lost: Int) {
    guard !settings.muted, settings.captureEnabled else { return }
    let now = nowMs()
    guard streamLive else {
      // Connected, but this connection's stream isn't started yet: hold them for it.
      for (i, frame) in frames.enumerated() {
        guard pendingFrames.count < CaptureEngine.maxPendingFrames else {
          if pendingDropped == 0 { Log.warn("engine: still no stream after \(pendingFrames.count) frames; dropping") }
          pendingDropped += 1
          continue
        }
        pendingFrames.append((frame, i == 0 ? lost : 0, now))
      }
      return
    }
    for (i, frame) in frames.enumerated() { appendFrame(frame, lost: i == 0 ? lost : 0, arrivedAt: now) }
    if framesThisStream % 50 == 0 { emitStatus() }
  }

  /// The connected pendant; battery and charging arrive before ready sets `wearable` (fresh process).
  private func peripheralId(_ ble: OmiBLE) -> String {
    ble.peripheral?.identifier.uuidString ?? wearable?.peripheralId ?? ""
  }

  func ble(_ ble: OmiBLE, battery: Int) {
    wearable?.battery = battery
    sendIfOpen([
      "t": "event", "kind": "battery", "value": battery, "peripheralId": peripheralId(ble), "at": nowMs(),
    ])
    emitStatus()
  }

  func ble(_ ble: OmiBLE, charging: Bool) {
    guard !chargingReported || charging != self.charging else { return }
    chargingReported = true
    self.charging = charging
    sendIfOpen([
      "t": "event", "kind": "charging", "value": charging, "peripheralId": peripheralId(ble), "at": nowMs(),
    ])
    emitStatus()
  }

  func ble(_ ble: OmiBLE, button: Int) {
    handleButton(button)
  }

  // MARK: offline storage

  func ble(_ ble: OmiBLE, storageStatus: StorageStatus) {
    offlineUnread = storageStatus.unreadPackets
    if !storageStatus.rtcValid { Log.warn("offline: pendant clock not set; it won't record offline yet") }
    if storageStatus.unreadPackets > 0, offlineState == .idle, settings.captureEnabled, codec != nil,
       nowMs() >= offlineRetryAt {
      Log.info("offline: \(storageStatus.unreadPackets) recorded packets waiting on the pendant")
      offlineState = .requesting
      offlineFrames = 0
      // A transfer started by a previous app process would keep sending (and the pendant deletes what
      // it sends); stop it before asking where to start.
      ble.writeStorage(StorageCommand.stop())
      ble.writeStorage(StorageCommand.info())
    }
    emitStatus()
  }

  func ble(_ ble: OmiBLE, storageNotification note: StorageNotification) {
    switch note {
    case .info(let readSeq, let writeSeq, _, let dropped):
      guard offlineState == .requesting else { return }
      if dropped > 0 { Log.warn("offline: pendant dropped \(dropped) packets (storage full?)") }
      // Never re-read what we already stored (if an ADVANCE didn't take, the pendant's pointer lags).
      let from = max(readSeq, offlineSyncedTo)
      guard writeSeq > from else {
        offlineState = .idle
        if offlineSyncedTo > readSeq { ble.writeStorage(StorageCommand.advance(to: offlineSyncedTo)) }
        return
      }
      offlineParser.reset()
      offlineClock = OfflineClock(frameMs: codec == 20 ? 10 : 20)
      offlineState = .downloading
      Log.info("offline: downloading \(writeSeq - from) packets")
      ble.writeStorage(StorageCommand.read(from: from))
    case .readBegin(_, let count):
      guard offlineState == .downloading else {
        Log.warn("offline: unexpected transfer; stopping it")
        stopStrayTransfer()
        return
      }
      Log.info("offline: transfer started (\(count) packets)")
    case .data(let chunk):
      guard offlineState == .downloading else {
        if offlineState != .advancing { stopStrayTransfer() }
        return
      }
      saveOfflineRecords(offlineParser.push(chunk))
      if offlineFrames % 500 < 10 { emitStatus() }
    case .done(let status, let nextSeq):
      guard offlineState == .downloading else { return }
      finishOffline(reason: status == 0 ? "done" : "ended with status \(status)")
      if status == 0 {
        // Everything before nextSeq is on disk here: let the pendant free it, then look again.
        offlineSyncedTo = max(offlineSyncedTo, nextSeq)
        offlineFailures = 0
        offlineState = .advancing
        ble.writeStorage(StorageCommand.advance(to: nextSeq))
      } else {
        offlineFailed()
      }
    case .ack(let status):
      if offlineState == .advancing {
        offlineState = .idle
        if status == 0 {
          ble.refreshStorageStatus()
        } else {
          Log.warn("offline: pendant refused to free synced data (status \(status))")
          offlineFailed()
        }
      } else if status != 0, offlineState != .idle {
        Log.warn("offline: pendant replied status \(status)")
        finishOffline(reason: "status \(status)")
        offlineFailed()
      }
    case .unknown:
      break
    }
  }

  /// A transfer we didn't ask for (e.g. from before an app relaunch) is still sending: stop it, at
  /// most once a second.
  private func stopStrayTransfer() {
    let now = nowMs()
    guard now - offlineStopSentAt > 1000 else { return }
    offlineStopSentAt = now
    ble.writeStorage(StorageCommand.stop())
  }

  /// Back off after a failed sync (e.g. a damaged SD batch fails every read): 1, 2, 4 … 30 min.
  private func offlineFailed() {
    offlineFailures += 1
    let delayMs = Int64(min(30, 1 << min(offlineFailures - 1, 5))) * 60_000
    offlineRetryAt = nowMs() + delayMs
    Log.warn("offline: sync failed \(offlineFailures)×; retrying in \(delayMs / 60_000) min")
  }

  /// Persist each record raw first (the pendant has already deleted it), then its frames. Records
  /// recorded while the user had capture muted are dropped entirely.
  private func saveOfflineRecords(_ records: [Data]) {
    for record in records {
      let seconds = OfflineRecordParser.recordSeconds(record) ?? 0
      if seconds > 1_700_000_000, MuteLog.contains(Int64(seconds) * 1000) { continue }
      let id = ensureOfflineStream(startedAt: seconds > 1_700_000_000 ? Int64(seconds) * 1000 : nowMs())
      journal.appendRaw(id, record)
      let (ts, frames) = OfflineRecordParser.parse(record)
      guard !frames.isEmpty, ts > 1_700_000_000 else { continue }
      let times = offlineClock.stamp(recordSeconds: ts, frames: frames.count)
      for (frame, at) in zip(frames, times) { journal.append(id, at: at, data: frame) }
      offlineFrames += Int64(frames.count)
      offlineLastAt = times.last
    }
  }

  private func ensureOfflineStream(startedAt: Int64) -> String {
    if let id = offlineStreamId { return id }
    let meta = StreamMeta(
      id: UUID().uuidString.lowercased(), codec: codec ?? 21, sampleRate: 16000, frameMs: codec == 20 ? 10 : 20,
      startedAt: startedAt, endedAt: nil, wearable: wearable)
    journal.create(meta)
    offlineStreamId = meta.id
    Log.info("offline: stream \(meta.id) for pendant recordings")
    if uplink.state == .open { bind(meta.id) }
    return meta.id
  }

  private func finishOffline(reason: String) {
    guard offlineState != .idle || offlineStreamId != nil else { return }
    if let id = offlineStreamId {
      let endedAt = offlineLastAt ?? journal.meta(id)?.startedAt ?? nowMs()
      journal.updateMeta(id) { $0.endedAt = endedAt }
      journal.seal(id)
      Log.info("offline: \(reason); \(offlineFrames) frames saved")
    }
    offlineStreamId = nil
    offlineLastAt = nil
    offlineState = .idle
    pump()
    emitStatus()
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
    // Register for notifications/config first, then bind the live stream before the backlog ones.
    uplink.send(json: ["t": "presence", "v": 1, "phoneId": phoneId, "features": CaptureEngine.features])
    if let active = activeStreamId { bind(active) }
    for id in journal.streamIds where id != activeStreamId { bind(id) }
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
      ble.haptic(HapticSequence.pattern(msg["pattern"] as? String))
    case "haptic_seq":
      guard let seq = HapticSequence(message: msg, receivedAt: HapticPlayer.now()) else {
        return Log.warn("ingest: malformed haptic_seq")
      }
      // No pendant to wait for: say so now rather than at the TTL.
      guard settings.captureEnabled, settings.pairedPeripheralId != nil else {
        return hapticFinished(.noPendant(seq.id))
      }
      haptics.play(seq)
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

  private func hapticFinished(_ outcome: HapticOutcome) {
    if !outcome.played { Log.info("haptics: \(outcome.id) not played (\(outcome.reason ?? "?"))") }
    sendIfOpen(outcome.json)
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
    switch SlotError.action(for: code) {
    case .resendFromAck:
      var s = slot
      s.sent = s.acked
      slots[slotId] = s
      pump()
    case .refuseStream:
      lastServerError = "\(code): \(message)"
      lastServerErrorCode = code
      rejectedStreams.insert(slot.streamId)
      slots[slotId] = nil
    case .reconnect:
      uplink.reset("server error \(code)")
    }
  }
}
