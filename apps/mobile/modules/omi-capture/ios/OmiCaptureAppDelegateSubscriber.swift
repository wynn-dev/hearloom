import ExpoModulesCore
import UIKit

/// Boots the capture engine as early as possible, so CoreBluetooth state restoration can hand us the
/// pendant when iOS relaunches the app in the background (JS may not be running then).
public class OmiCaptureAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    CaptureEngine.shared.boot()
    return true
  }
}
