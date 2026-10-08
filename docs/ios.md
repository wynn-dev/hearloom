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
  - Pendant button actions (bookmark / mute) run locally, so mute works offline.
  - Notifications arrive over APNs. When the server can't push (APNs not configured or failing) they come
    over the socket and are shown with `LocalNotifier` (same categories and data as APNs pushes). The
    pendant buzz always comes over the socket.
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

## Cloud builds and releases (EAS)

The app is the EAS project `@unlaboredlabs/hearloom` (`apps/mobile/eas.json`). Build profiles:

| Profile       | What                             | Install via      | Update channel |
| ------------- | -------------------------------- | ---------------- | -------------- |
| `development` | dev client (pairs with `pnpm start`) | EAS link / QR | `development`  |
| `preview`     | release build, ad hoc            | EAS link / QR    | `preview`      |
| `production`  | App Store build                  | TestFlight       | `production`   |

Dev client on your iPhone without Xcode: `eas device:create` once to register the phone (internal
distribution is ad hoc), then `pnpm build:dev` and install from the link/QR. Run `pnpm start` and open it.

`HEARLOOM_APS_ENV` (push environment) comes from EAS environment variables, not `eas.json`, so builds,
fingerprints and OTA updates all see the same value (it is part of the native fingerprint).

**Continuous delivery.** On every push to `main` that touches the app (`apps/mobile`, `packages/api`,
`packages/shared` or the lockfile), GitHub Actions runs CI and, once it's green, starts
`apps/mobile/.eas/workflows/deploy-production.yml` on EAS. That workflow fingerprints the native code:

- a production build with the same fingerprint exists → the JS ships as an **OTA update** on the
  `production` channel (installed apps pick it up on the next launch);
- otherwise → a new **build** is made and **submitted to TestFlight**.

To force a new binary, run the CI workflow manually on `main` with `force_build` (Actions → CI → Run
workflow). The server and worker are not deployed by CI; you run them yourself.

**One-time setup** (needs your Apple login, so it can't run in CI):

```sh
cd apps/mobile
eas build -p ios --profile production   # creates the signing certificate + provisioning profile
eas submit -p ios --latest              # creates the App Store Connect app + API key for submissions
```

Then create a robot access token for the `unlaboredlabs` org on expo.dev and store it as the
`EXPO_TOKEN` repository secret (`gh secret set EXPO_TOKEN`).

Self-hosters with their own bundle id: create your own EAS project and set `HEARLOOM_EAS_OWNER` and
`HEARLOOM_EAS_PROJECT_ID`; without them the app builds with no EAS project and no OTA updates.

## Server address

Sign in with the server's `PUBLIC_URL`: with the setup in the README ("Remote access"), that's
`https://your-mac.your-tailnet.ts.net` (`pnpm start` behind one `tailscale serve --bg --https=443`), the
same address as the console.

Plain `http://your-mac.your-tailnet.ts.net:3000` works too (the app allows plain HTTP only for `*.ts.net`
and local networks; Tailscale already encrypts the traffic), but only while no `tailscale serve` handler
uses port 3000: one there takes the port over on the tailnet address, and plain HTTP gets `400`.

To change the address, sign out and sign in again with the new one; the phone keeps its record.

## Tests

CI (`.github/workflows/ci.yml`) runs lint, typecheck, all tests against Postgres, the web build and an
iOS JS bundle export on every PR. `.github/workflows/swift.yml` runs the Swift tests below and builds the
diarizer sidecar on macOS when that code changes.

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
