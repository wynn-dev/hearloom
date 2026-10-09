import CoreBluetooth
import Foundation

/// Omi GATT layout (consumer pendant "CV1", firmware >= 3.0.20). Mirrors packages/shared/src/omi.ts.
enum OmiUUID {
  private static func omi(_ short: String) -> CBUUID { CBUUID(string: "\(short)-E8F2-537E-4F6C-D104768A1214") }
  static let audioService = omi("19B10000")
  static let audioData = omi("19B10001")
  static let audioCodec = omi("19B10002")
  static let settingsService = omi("19B10010")
  static let chargingStatus = omi("19B10013")
  static let featuresService = omi("19B10020")
  static let features = omi("19B10021")
  static let timeService = omi("19B10030")
  static let timeSet = omi("19B10031")
  static let buttonService = CBUUID(string: "23BA7924-0000-1000-7450-346EAC492E92")
  static let button = CBUUID(string: "23BA7925-0000-1000-7450-346EAC492E92")
  static let hapticService = CBUUID(string: "CAB1AB95-2EA5-4F4D-BB56-874B72CFC984")
  static let haptic = CBUUID(string: "CAB1AB96-2EA5-4F4D-BB56-874B72CFC984")
  static let storageService = CBUUID(string: "30295780-4301-EABD-2904-2849ADFEAE43")
  static let storageControl = CBUUID(string: "30295781-4301-EABD-2904-2849ADFEAE43")
  static let storageStatus = CBUUID(string: "30295782-4301-EABD-2904-2849ADFEAE43")
  static let batteryService = CBUUID(string: "180F")
  static let batteryLevel = CBUUID(string: "2A19")
  static let deviceInfoService = CBUUID(string: "180A")
  static let model = CBUUID(string: "2A24")
  static let serial = CBUUID(string: "2A25")
  static let firmware = CBUUID(string: "2A26")
  static let hardware = CBUUID(string: "2A27")

  static let services: [CBUUID] = [
    audioService, settingsService, featuresService, timeService, buttonService, hapticService, batteryService,
    deviceInfoService, storageService,
  ]
}

/// Reassembles `[pkt_idx u16][sub_idx u8][payload]` notifications into codec frames.
/// When the MTU is large enough for a whole frame (always on modern iPhones) every notification is one
/// frame and is emitted immediately; otherwise fragments are buffered until the next `sub_idx = 0`.
struct FrameAssembler {
  private var lastPkt = -1
  private var lastSub = -1
  private var parts: [Data] = []
  var fragmentationPossible = false

  mutating func reset() {
    lastPkt = -1
    lastSub = -1
    parts = []
  }

  /// Returns completed frames and how many notifications were lost right before them.
  mutating func push(_ packet: Data) -> (frames: [Data], lost: Int) {
    guard packet.count >= 4 else { return ([], 0) }
    let bytes = [UInt8](packet.prefix(3))
    let pkt = Int(bytes[0]) | (Int(bytes[1]) << 8)
    let sub = Int(bytes[2])
    let payload = packet.subdata(in: (packet.startIndex + 3)..<packet.endIndex)
    var lost = 0
    if lastPkt >= 0 {
      let expected = (lastPkt + 1) & 0xFFFF
      if pkt != expected { lost = (pkt - expected + 0x10000) & 0xFFFF }
    }
    defer {
      lastPkt = pkt
      lastSub = sub
    }
    if !fragmentationPossible {
      return sub == 0 ? ([payload], lost) : ([], lost)
    }
    var out: [Data] = []
    if sub == 0 {
      if parts.count == 1 || (parts.count > 1 && lost == 0) { out.append(parts.reduce(Data(), +)) }
      parts = [payload]
    } else if lost == 0 && sub == lastSub + 1 && !parts.isEmpty {
      parts.append(payload)
    } else {
      parts = []
    }
    return (out, lost)
  }
}

protocol OmiBLEDelegate: AnyObject {
  func ble(_ ble: OmiBLE, stateChanged state: OmiBLE.State)
  func ble(_ ble: OmiBLE, discovered devices: [OmiBLE.Discovered])
  func ble(_ ble: OmiBLE, readyWithCodec codec: Int, info: WearableInfo)
  func bleDisconnected(_ ble: OmiBLE, peripheralId: String, error: Error?)
  func ble(_ ble: OmiBLE, frames: [Data], lost: Int)
  func ble(_ ble: OmiBLE, battery: Int)
  func ble(_ ble: OmiBLE, charging: Bool)
  func ble(_ ble: OmiBLE, button: Int)
  func ble(_ ble: OmiBLE, storageStatus: StorageStatus)
  func ble(_ ble: OmiBLE, storageNotification: StorageNotification)
}

/// CoreBluetooth central for the Omi pendant, with state restoration so iOS can relaunch the app in the
/// background (a pending `connect` and active notifications keep it eligible).
final class OmiBLE: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  enum State: String {
    case unknown, poweredOff, unauthorized, unsupported, idle, scanning, connecting, discovering, ready
  }

  struct Discovered {
    let id: String
    let name: String
    let rssi: Int
  }

  static let restoreIdentifier = "hearloom.capture.central"

  weak var delegate: OmiBLEDelegate?
  private let queue: DispatchQueue
  private var central: CBCentralManager!
  private(set) var state: State = .unknown {
    didSet { if state != oldValue { delegate?.ble(self, stateChanged: state) } }
  }
  private(set) var peripheral: CBPeripheral?
  private var characteristics: [CBUUID: CBCharacteristic] = [:]
  private var assembler = FrameAssembler()
  private var discovered: [UUID: Discovered] = [:]
  private var info: WearableInfo?
  private var codec: Int?
  private var audioSubscribed = false
  private var announcedReady = false
  /// Services whose characteristics aren't discovered yet, and reads (codec, device info, battery, ...)
  /// not answered yet. Ready waits for both, so it carries complete device info, but at most
  /// `readyTimeout` once audio can flow.
  private var servicesPending = 0
  private var pendingReads: Set<CBUUID> = []
  private var readyDeadlineSet = false
  private static let readyTimeout = 3.0
  /// This connection is being set up (from discover until ready or disconnect). Don't restart it; that
  /// would reset its state.
  private var discovering = false
  /// Counts discovery rounds, so a late ready deadline or watchdog can't act on the next one.
  private var round = 0
  /// Connections in a row that didn't become ready (see `checkNotReady`).
  private var notReadyCount = 0

  /// The pendant we want connected. nil = stay disconnected.
  private(set) var targetId: UUID?

  init(queue: DispatchQueue) {
    self.queue = queue
    super.init()
  }

  /// Must run early at launch so iOS can hand restored peripherals to us.
  func start() {
    guard central == nil else { return }
    central = CBCentralManager(
      delegate: self,
      queue: queue,
      options: [
        CBCentralManagerOptionRestoreIdentifierKey: OmiBLE.restoreIdentifier,
        CBCentralManagerOptionShowPowerAlertKey: false,
      ]
    )
  }

  // MARK: commands (call on `queue`)

  func setTarget(_ id: UUID?) {
    if id != targetId { notReadyCount = 0 } // a new pendant starts without backoff
    targetId = id
    if id == nil {
      if let p = peripheral { central.cancelPeripheralConnection(p) }
      peripheral = nil
      updateHapticPendant()
      state = central.state == .poweredOn ? .idle : state
      return
    }
    connectTarget()
  }

  func startScan() {
    guard central.state == .poweredOn else { return }
    discovered = [:]
    central.scanForPeripherals(withServices: [OmiUUID.audioService], options: nil)
    state = .scanning
  }

  func stopScan() {
    guard central.state == .poweredOn, central.isScanning else { return }
    central.stopScan()
    if state == .scanning { state = peripheral == nil ? .idle : state }
  }

  /// Send a command to the offline-storage service (see StorageCommand).
  func writeStorage(_ command: Data) {
    guard let p = peripheral, let c = characteristics[OmiUUID.storageControl] else { return }
    p.writeValue(command, for: c, type: .withResponse)
  }

  /// Re-read the offline-storage status (unread packets etc.).
  func refreshStorageStatus() {
    guard let p = peripheral, let c = characteristics[OmiUUID.storageStatus] else { return }
    p.readValue(for: c)
  }

  var hasOfflineStorage: Bool { characteristics[OmiUUID.storageControl] != nil }

  /// Pulse the pendant's vibration motor: 1 = 100 ms, 2 = 300 ms, 3 = 500 ms.
  func haptic(_ pattern: UInt8) {
    guard let p = peripheral, let c = characteristics[OmiUUID.haptic] else { return }
    p.writeValue(Data([pattern]), for: c, type: .withResponse)
  }

  /// Told (on `queue`) whenever the pendant's ability to buzz changes.
  var hapticPendantChanged: ((HapticPendant) -> Void)?
  private enum HapticState { case away, cannotBuzz, ready }
  private var hapticState = HapticState.away

  private func updateHapticPendant() {
    let next: HapticState
    if !(announcedReady || discovering) || peripheral?.state != .connected {
      next = .away
    } else if characteristics[OmiUUID.haptic] != nil {
      next = .ready
    } else if announcedReady, servicesPending <= 0 {
      next = .cannotBuzz // every service is discovered and there's no haptic characteristic
    } else {
      next = .away
    }
    guard next != hapticState else { return }
    hapticState = next
    switch next {
    case .away: hapticPendantChanged?(.away)
    case .cannotBuzz: hapticPendantChanged?(.cannotBuzz)
    case .ready:
      // Called on the haptic player's queue (which keeps the timing). CoreBluetooth objects and this
      // class's state belong to `queue`, so hop the write there, without waiting for it.
      hapticPendantChanged?(.ready { [weak self] pattern in
        guard let self else { return false }
        self.queue.async(qos: .userInteractive, flags: .enforceQoS) {
          guard let p = self.peripheral, p.state == .connected, let c = self.characteristics[OmiUUID.haptic]
          else { return }
          p.writeValue(Data([pattern]), for: c, type: .withResponse)
        }
        return true
      })
    }
  }

  // MARK: connection

  private func connectTarget() {
    guard central.state == .poweredOn, let id = targetId else { return }
    if let p = peripheral, p.identifier == id {
      switch p.state {
      case .connected:
        if !announcedReady && !discovering { discover(p) }
        return
      case .connecting:
        return
      default:
        break
      }
    }
    guard let p = central.retrievePeripherals(withIdentifiers: [id]).first else {
      Log.warn("ble: paired pendant \(id) not known to iOS; scan and pair again")
      state = .idle
      return
    }
    peripheral = p
    p.delegate = self
    state = .connecting
    // No timeout: iOS keeps this pending and connects whenever the pendant is in range,
    // relaunching the app in the background if needed.
    central.connect(p, options: nil)
  }

  private func discover(_ p: CBPeripheral) {
    state = .discovering
    characteristics = [:]
    codec = nil
    audioSubscribed = false
    announcedReady = false
    servicesPending = 0
    pendingReads = []
    readyDeadlineSet = false
    discovering = true
    updateHapticPendant()
    round += 1
    assembler.reset()
    assembler.fragmentationPossible = p.maximumWriteValueLength(for: .withoutResponse) < 163
    info = WearableInfo(peripheralId: p.identifier.uuidString, name: p.name ?? "Omi")
    p.discoverServices(OmiUUID.services)
    // 10 s, doubling while connections keep failing, up to 5 min.
    let r = round
    let wait = min(300.0, 10.0 * Double(1 << min(notReadyCount, 5)))
    queue.asyncAfter(deadline: .now() + wait) { [weak self] in self?.checkNotReady(round: r, after: wait) }
  }

  /// A connection that never became ready (no codec, failed audio subscription, no services) would
  /// sit there recording nothing until it drops, maybe hours later: drop it so iOS reconnects.
  private func checkNotReady(round r: Int, after wait: Double) {
    guard round == r, !announcedReady, let p = peripheral, p.state == .connected else { return }
    notReadyCount += 1
    let why = "codec \(codec.map(String.init) ?? "none"), audio \(audioSubscribed ? "on" : "off")"
    Log.warn("ble: not ready after \(Int(wait)) s (\(why)); reconnecting")
    central.cancelPeripheralConnection(p)
  }

  /// The connection is gone: reset its state and tell the delegate.
  private func connectionLost(_ p: CBPeripheral, error: Error?) {
    announcedReady = false
    audioSubscribed = false
    discovering = false
    updateHapticPendant()
    delegate?.bleDisconnected(self, peripheralId: p.identifier.uuidString, error: error)
  }

  // MARK: CBCentralManagerDelegate

  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]) ?? []
    Log.info("ble: restored \(restored.count) peripheral(s)")
    if let p = restored.first(where: { $0.identifier == targetId }) ?? restored.first {
      peripheral = p
      p.delegate = self
    }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    // iOS reports no disconnect when Bluetooth goes away (off, airplane mode, reset).
    if central.state != .poweredOn, announcedReady || discovering, let p = peripheral {
      Log.info("ble: Bluetooth unavailable; connection lost")
      connectionLost(p, error: nil)
    }
    switch central.state {
    case .poweredOn:
      state = .idle
      connectTarget()
    case .poweredOff:
      state = .poweredOff
    case .unauthorized:
      state = .unauthorized
    case .unsupported:
      state = .unsupported
    default:
      state = .unknown
    }
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber
  ) {
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? "Unknown"
    discovered[peripheral.identifier] = Discovered(id: peripheral.identifier.uuidString, name: name, rssi: rssi.intValue)
    delegate?.ble(self, discovered: discovered.values.sorted { $0.rssi > $1.rssi })
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    Log.info("ble: connected \(peripheral.name ?? "?")")
    discover(peripheral)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    Log.warn("ble: failed to connect: \(error?.localizedDescription ?? "unknown")")
    if targetId == peripheral.identifier { central.connect(peripheral, options: nil) }
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    Log.info("ble: disconnected (\(error?.localizedDescription ?? "clean"))")
    // Already handled if Bluetooth went away first (centralManagerDidUpdateState).
    if announcedReady || discovering { connectionLost(peripheral, error: error) }
    guard central.state == .poweredOn else { return } // poweredOn reconnects via connectTarget
    if targetId == peripheral.identifier {
      state = .connecting
      central.connect(peripheral, options: nil)
    } else {
      state = .idle
    }
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    if let error { return Log.error("ble: service discovery failed: \(error)") } // checkNotReady reconnects
    servicesPending = peripheral.services?.count ?? 0
    for service in peripheral.services ?? [] { peripheral.discoverCharacteristics(nil, for: service) }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    servicesPending -= 1
    defer {
      maybeReady()
      updateHapticPendant()
    }
    if let error { return Log.error("ble: characteristic discovery failed: \(error)") }
    for c in service.characteristics ?? [] {
      characteristics[c.uuid] = c
      switch c.uuid {
      case OmiUUID.audioCodec, OmiUUID.model, OmiUUID.firmware, OmiUUID.hardware, OmiUUID.serial, OmiUUID.features:
        read(c, on: peripheral)
      case OmiUUID.batteryLevel, OmiUUID.chargingStatus:
        read(c, on: peripheral)
        peripheral.setNotifyValue(true, for: c)
      case OmiUUID.button, OmiUUID.storageControl:
        peripheral.setNotifyValue(true, for: c)
      case OmiUUID.storageStatus:
        peripheral.setNotifyValue(true, for: c)
      case OmiUUID.timeSet:
        // The pendant timestamps offline recordings with this clock; set it on every connect.
        var secs = UInt32(Date().timeIntervalSince1970).littleEndian
        peripheral.writeValue(Data(bytes: &secs, count: 4), for: c, type: .withResponse)
      default:
        break
      }
    }
    if service.uuid == OmiUUID.audioService, let audio = characteristics[OmiUUID.audioData] {
      peripheral.setNotifyValue(true, for: audio)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
    if let error { return Log.error("ble: notify \(c.uuid) failed: \(error)") }
    if c.uuid == OmiUUID.audioData {
      audioSubscribed = c.isNotifying
      maybeReady()
    }
    if c.uuid == OmiUUID.storageControl, c.isNotifying { refreshStorageStatus() }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
    // A failed read is answered too.
    let answered = pendingReads.remove(c.uuid) != nil
    defer { if answered { maybeReady() } }
    guard error == nil, let value = c.value else { return }
    switch c.uuid {
    case OmiUUID.audioData:
      let (frames, lost) = assembler.push(value)
      if !frames.isEmpty { delegate?.ble(self, frames: frames, lost: lost) }
    case OmiUUID.audioCodec:
      codec = value.first.map(Int.init)
    case OmiUUID.batteryLevel:
      if let level = value.first {
        info?.battery = Int(level)
        delegate?.ble(self, battery: Int(level))
      }
    case OmiUUID.chargingStatus:
      if let v = value.first { delegate?.ble(self, charging: v != 0) }
    case OmiUUID.button:
      if value.count >= 4 {
        let code = value.withUnsafeBytes { Int(Int32(littleEndian: $0.loadUnaligned(as: Int32.self))) }
        if code != 0 { delegate?.ble(self, button: code) }
      }
    case OmiUUID.storageControl:
      delegate?.ble(self, storageNotification: StorageNotification.parse(value))
    case OmiUUID.storageStatus:
      if let status = StorageStatus(value) { delegate?.ble(self, storageStatus: status) }
    case OmiUUID.model:
      info?.model = String(data: value, encoding: .utf8)
    case OmiUUID.firmware:
      info?.firmware = String(data: value, encoding: .utf8)
    case OmiUUID.hardware:
      info?.hardwareRev = String(data: value, encoding: .utf8)
    case OmiUUID.serial:
      info?.serial = String(data: value, encoding: .utf8)
    default:
      break
    }
  }

  /// Read a characteristic if it's readable; ready waits for the answer.
  private func read(_ c: CBCharacteristic, on p: CBPeripheral) {
    guard c.properties.contains(.read) else { return }
    pendingReads.insert(c.uuid)
    p.readValue(for: c)
  }

  private func maybeReady(force: Bool = false) {
    guard !announcedReady, audioSubscribed, let codec, let info else { return }
    if !force, servicesPending > 0 || !pendingReads.isEmpty {
      // Audio can flow; don't let a read that never answers hold up the stream.
      guard !readyDeadlineSet else { return }
      readyDeadlineSet = true
      let r = round
      queue.asyncAfter(deadline: .now() + OmiBLE.readyTimeout) { [weak self] in
        guard let self, self.round == r, !self.announcedReady else { return }
        Log.warn("ble: \(self.pendingReads.count) read(s), \(self.servicesPending) service(s) unanswered; ready anyway")
        self.maybeReady(force: true)
      }
      return
    }
    announcedReady = true
    discovering = false
    notReadyCount = 0
    state = .ready
    updateHapticPendant()
    Log.info("ble: ready, codec \(codec), mtu-3 \(peripheral?.maximumWriteValueLength(for: .withoutResponse) ?? 0)")
    delegate?.ble(self, readyWithCodec: codec, info: info)
  }
}
