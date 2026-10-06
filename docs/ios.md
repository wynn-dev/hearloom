# iOS app

Expo SDK 58 (React Native 0.88) with a native Swift capture module at
`apps/mobile/modules/omi-capture`. SDK 58 is required for Xcode 27: the iOS 27 SDK refuses to launch apps
that don't use the UIScene lifecycle.

## What runs where

- **Swift (`CaptureEngine`)** owns capture end to end, so it keeps working when JavaScript isn't running
  (iOS relaunches the app in the background through CoreBluetooth state restoration):
  - `OmiBLE` — scan, pair, connect with no timeout (iOS reconnects whenever the pendant is in range),
    read codec / device info, sync the pendant clock, subscribe to audio, battery, button, charging.
  - `FrameJournal` — every Opus frame is written to disk (`Application Support/hearloom/journal`) before
    upload and deleted only after the server acknowledges it.
  - `IngestClient` — the `/ingest` WebSocket (see `docs/protocol.md`), with backoff, network-change
    retries and keepalive pings.
  - Pendant button actions (bookmark / mute / acknowledge nudge) run locally, so mute works offline.
  - Notifications that arrive over the socket are shown with `LocalNotifier` (same categories and data as
    APNs pushes), and can buzz the pendant.
- **React Native** is the UI: sign-in, pairing, status, timeline, inbox, settings. It talks to the server
  with the typed oRPC client and controls the native engine through `omi-capture`.

## Build and run

Requirements: Xcode 27, CocoaPods, a paid Apple Developer account (background Bluetooth + push).

```sh
cd apps/mobile
APPLE_TEAM_ID=XXXXXXXXXX pnpm prebuild      # generates ios/ (not committed)
pnpm ios:device                             # build + install on a connected iPhone, starts Metro
```

Self-hosters: set `HEARLOOM_BUNDLE_ID` to your own bundle id (push and signing are per Apple account).
Release builds for daily use: `HEARLOOM_APS_ENV=production` and build the Release configuration in Xcode.

The simulator can run everything except Bluetooth (CoreBluetooth is unavailable there).

## Server address

Sign in with the URL your phone can reach, e.g. your Mac over Tailscale:
`http://your-mac.your-tailnet.ts.net:3000` (plain HTTP is allowed only for `*.ts.net` and local networks;
Tailscale already encrypts the traffic), or `https://…` via `tailscale serve`.

## Tests

`apps/mobile/modules/omi-capture/tests/run-tests.sh` compiles the platform-independent Swift (journal,
batch codec) for macOS, runs the checks, and verifies the Swift-encoded audio batches decode identically
with the server's TypeScript decoder.

## Known limitations

- A force-quit app is not relaunched by iOS for Bluetooth events. AccessorySetupKit pairing (iOS 26+)
  would allow that; it's planned.
- Offline recordings: when the phone is out of range the pendant records to its own storage (only after
  its clock has been set once — the app does that on every connect). On reconnect the app downloads
  them (`OfflineRecords.swift`) as a separate stream: STOP (any transfer left from a previous app
  process), INFO, READ, then ADVANCE past what was received so the pendant frees it (otherwise its last
  packet is re-sent forever). Stock firmware deletes data as it is sent, so each raw record is written
  to disk before parsing and kept for 14 days after upload (`offline-raw/`). Records from times the
  user had capture muted are dropped. Failed syncs back off from 1 to 30 minutes.
