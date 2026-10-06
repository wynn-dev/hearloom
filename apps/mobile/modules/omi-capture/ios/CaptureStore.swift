import Foundation
import Security

struct ButtonConfig: Codable, Equatable {
  var tap = "bookmark"
  var doubleTap = "mute"
  var hold = "ack_nudge"
}

/// Settings that must survive app relaunches (including background relaunch by iOS).
struct CaptureSettings: Codable {
  var serverURL: String?
  var phoneId: String?
  var pairedPeripheralId: String?
  var captureEnabled = false
  var muted = false
  var button = ButtonConfig()
  var pendantHaptic = true
}

enum CaptureStore {
  private static let key = "hearloom.capture.settings"

  static func load() -> CaptureSettings {
    guard let data = UserDefaults.standard.data(forKey: key),
          let s = try? JSONDecoder().decode(CaptureSettings.self, from: data) else { return CaptureSettings() }
    return s
  }

  static func save(_ s: CaptureSettings) {
    if let data = try? JSONEncoder().encode(s) { UserDefaults.standard.set(data, forKey: key) }
  }
}

/// Session token in the Keychain, readable after first unlock so background relaunches can upload.
enum TokenStore {
  private static let service = "hearloom.capture"
  private static let account = "session-token"

  static func get() -> String? {
    var query = base()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func set(_ token: String?) {
    SecItemDelete(base() as CFDictionary)
    guard let token, let data = token.data(using: .utf8) else { return }
    var attrs = base()
    attrs[kSecValueData as String] = data
    attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(attrs as CFDictionary, nil)
    if status != errSecSuccess { Log.error("keychain write failed: \(status)") }
  }

  private static func base() -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }
}
