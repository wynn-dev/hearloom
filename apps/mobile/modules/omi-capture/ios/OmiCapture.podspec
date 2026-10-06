Pod::Spec.new do |s|
  s.name           = 'OmiCapture'
  s.version        = '0.1.0'
  s.summary        = 'Omi pendant capture (BLE, journal, uplink) for Hearloom'
  s.description    = 'Native capture engine: CoreBluetooth with state restoration, on-disk frame journal, WebSocket uplink with acks.'
  s.author         = 'Hearloom contributors'
  s.homepage       = 'https://github.com/hearloom/hearloom'
  s.license        = { :type => 'AGPL-3.0-only' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CoreBluetooth', 'UserNotifications', 'Network'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files   = '**/*.{h,m,swift}'
end
