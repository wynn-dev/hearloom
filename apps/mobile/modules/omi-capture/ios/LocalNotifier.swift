import Foundation
import UserNotifications

/// Shows notifications that arrived over the live socket. Uses the same categories and data shape as
/// APNs pushes (`content.data` = `{ hlId, deepLink }` in JS), so actions/taps are handled identically.
enum LocalNotifier {
  static func post(
    id: String, title: String, body: String, category: String, threadId: String?, deepLink: String?, level: String
  ) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.categoryIdentifier = category
    content.threadIdentifier = threadId ?? category
    var data: [String: Any] = ["hlId": id]
    if let deepLink { data["deepLink"] = deepLink }
    content.userInfo = data
    switch level {
    case "passive":
      content.interruptionLevel = .passive
    case "time-sensitive":
      content.interruptionLevel = .timeSensitive
      content.sound = .default
    default:
      content.interruptionLevel = .active
      content.sound = .default
    }
    let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
      if let error { Log.error("notify: could not show \(id): \(error.localizedDescription)") }
    }
  }
}
