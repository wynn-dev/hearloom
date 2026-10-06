import ExpoModulesCore

public class OmiCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OmiCapture")

    Events("onStatus", "onDevices", "onButton")

    OnCreate {
      CaptureEngine.shared.boot()
    }

    OnStartObserving { [weak self] in
      CaptureEngine.shared.setEventSink { name, body in
        self?.sendEvent(name, body)
      }
    }

    OnStopObserving {
      CaptureEngine.shared.setEventSink(nil)
    }

    Function("getStatus") { () -> [String: Any] in
      CaptureEngine.shared.status()
    }

    Function("configure") { (serverURL: String, token: String, phoneId: String) in
      CaptureEngine.shared.configure(serverURL: serverURL, token: token, phoneId: phoneId)
    }

    Function("signOut") {
      CaptureEngine.shared.signOut()
    }

    Function("startScan") {
      CaptureEngine.shared.startScan()
    }

    Function("stopScan") {
      CaptureEngine.shared.stopScan()
    }

    Function("pair") { (peripheralId: String) in
      CaptureEngine.shared.pair(peripheralId)
    }

    Function("forget") {
      CaptureEngine.shared.forget()
    }

    Function("setCaptureEnabled") { (enabled: Bool) in
      CaptureEngine.shared.setCaptureEnabled(enabled)
    }

    Function("setMuted") { (muted: Bool) in
      CaptureEngine.shared.setMuted(muted)
    }

    Function("testHaptic") { (pattern: Int) in
      CaptureEngine.shared.testHaptic(pattern)
    }

    Function("getLogs") { () -> [String] in
      Log.recent()
    }
  }
}
