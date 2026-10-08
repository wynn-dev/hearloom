# Hearloom

Self-hosted, always-on audio memory for the [Omi](https://www.omi.me/) pendant — without any of Omi's
cloud services. The pendant streams to your iPhone over Bluetooth; the phone forwards audio to your own
server, which keeps every second (speech **and** non-speech sound) as a structured, searchable timeline.

> Status: early development. Working end to end: iOS capture (Swift), durable upload, live
> transcription (EN/NL), speakers, sound events, episodes (conversations, talks, TV…), refine pass, notifications, web console,
> and an MCP endpoint for agents (Hermes).

## Layout

```
apps/server      Bun + Hono: auth, typed API (oRPC), /ingest WebSocket, notifications, media
apps/web         Web console (Vite + TanStack Router/Query)
apps/mobile      iOS app (Expo) with a native Swift capture module
packages/db      Postgres schema + migrations (Drizzle)
packages/api     API contract shared by server, web and app
packages/shared  Ingest protocol, Omi BLE constants, settings schema
packages/audio   libopus bindings (bun:ffi), Ogg Opus decoding
packages/inference  sherpa-onnx models: VAD, sound tagging, voiceprints
sidecars/diarizer   Swift: offline speaker diarization (FluidAudio, Core ML)
docs/            design.md (start here), protocol.md, models.md, ios.md, agent.md
```

## Requirements

- macOS or Linux, [Bun](https://bun.sh) ≥ 1.4.2, [pnpm](https://pnpm.io) ≥ 12, Node ≥ 22.13
- Docker (Postgres 18 + pgvector)
- `libopus` (`brew install opus` / `apt install libopus0`)
- For the iOS app: Xcode, CocoaPods, a paid Apple Developer account (background Bluetooth + push)

## Quick start

```sh
pnpm install
cp .env.example .env            # then set BETTER_AUTH_SECRET (openssl rand -base64 48) and SONIOX_API_KEY
pnpm db:up && pnpm db:migrate
pnpm --filter @hearloom/server create-user -- --email you@example.com --name You --admin
pnpm --filter @hearloom/server download-models            # local VAD/sound/speaker models
pnpm --filter @hearloom/server build:diarizer              # macOS: speaker diarization sidecar
pnpm dev                        # development: server :3000 + worker + console :5173 (Vite)
pnpm start                      # everyday use: builds the console, then server + worker on :3000
```

Simulate a phone streaming audio (no hardware needed):

```sh
HEARLOOM_EMAIL=you@example.com HEARLOOM_PASSWORD=... pnpm --filter @hearloom/server simulate-phone
```

## Remote access (phone, browser, agent)

`pnpm start` applies migrations, builds the console, then runs the server and worker. One port serves
everything: the built console, `/api`, `/rpc`, the `/ingest` and `/realtime` WebSockets, `/media` and
`/mcp`. So one address works for the iOS app, the console in a browser and an agent, and remote access
is one persistent [Tailscale](https://tailscale.com) serve:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

```sh
# .env
PUBLIC_URL=https://<machine>.<tailnet>.ts.net
HOST=127.0.0.1    # only reachable through the serve (see below)
```

`--https` needs HTTPS certificates enabled for your tailnet (admin console → DNS → HTTPS
Certificates). Then open `https://<machine>.<tailnet>.ts.net` on the phone, and sign the app in with the
same URL. `--bg` keeps the serve across restarts of Tailscale and the Mac; check it with
`tailscale serve status`. HTTPS matters for the browser: the mic (voice teaching) needs it, and with an
`https://` `PUBLIC_URL` the session cookies are Secure, so browsers drop them over plain HTTP from
anything but localhost.

`HOST=127.0.0.1` makes the server listen on the Mac's loopback only, so it answers through the serve
(and on the Mac itself) but not to your LAN, or as plain HTTP on the tailnet address. The trade-off:
no plain `http://<machine>.<tailnet>.ts.net:3000` or LAN-IP fallback; everything uses the `https://`
URL. Without it (the default, `0.0.0.0`), plain `http://<machine>.<tailnet>.ts.net:3000` reaches the
server too, but only while no `tailscale serve` handler uses port 3000: a serve on a port takes it over
on the tailnet address, and plain HTTP to it then gets `400`.

Auth trusts the address a request came in on (as `tailscale serve` and Vite forward it), so the console
and the app work from any of those URLs. That covers IP addresses, `localhost`, single-label names,
`PUBLIC_URL`'s host and other machines on its tailnet (`*.<tailnet>.ts.net`); other names (e.g.
`mac.local`, your own domain) must be listed in `TRUSTED_ORIGINS`, so a site that re-points its own name
at your Mac (DNS rebinding) isn't trusted. Caveat: anything else served on the same origin, e.g. an app
you mount next to Hearloom with `tailscale serve --set-path`, is the same origin to the browser and can
call Hearloom's auth as you, so don't mount apps you don't trust there. Hermes on the same Mac talks to
`http://127.0.0.1:3000/mcp` and needs no serve at all (the console's Agent page fills that in).

`pnpm start` has to keep running: in a terminal you leave open (tmux), or as a launchd agent that
starts it at login and restarts it if it exits. If the worker dies, the server keeps running (refine
jobs wait in the queue until the next restart). For launchd, run `scripts/start.sh` (what `pnpm start`
runs) directly: it ends by exec-ing turbo, so `launchctl bootout`'s SIGTERM reaches turbo, which stops
the server and worker. Through `pnpm`, the SIGTERM stops at pnpm and they keep running.

launchd doesn't read your shell profile, so the plist sets `PATH`. It must reach `bun`, `pnpm` and
`node`, with paths that last:

- Put the directory of the bun you mean to run first (it must be ≥ 1.4.2), and check it with
  `<that directory>/bun --version`: a Mac can have more than one, and the first on `PATH` wins.
- `which node` may print a path that only lives as long as your shell. With fnm it's
  `~/.local/state/fnm_multishells/<id>/bin`; use `~/.local/share/fnm/aliases/default/bin` instead, or
  Homebrew's node (`/opt/homebrew/bin`).

For example `~/Library/LaunchAgents/hearloom.plist`, with your own paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>hearloom</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>/Users/you/hearloom/scripts/start.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- Your bun's directory first, then pnpm's and node's. -->
    <key>PATH</key><string>/path/to/bun/bin:/opt/homebrew/bin:/Users/you/.local/share/fnm/aliases/default/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/hearloom.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/hearloom.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/hearloom.plist   # start (and at every login)
launchctl bootout gui/$(id -u)/hearloom                                    # stop
```

`pnpm dev` (Vite with hot reload on `http://localhost:5173`) is for development on the Mac itself. It
uses the same `PORT` as `pnpm start`, so stop one before starting the other.

### Moving from separate serves (console :5173, server :3000)

1. Stop the old serves: Ctrl-C the foreground ones; turn off background ones with
   `tailscale serve --https=<port> off`. Keep a background `--https=3000` handler that already proxies to
   `http://127.0.0.1:3000`: step 4 needs exactly that one. `tailscale serve status` should list nothing
   else.
2. In `.env`, set `PUBLIC_URL=https://<machine>.<tailnet>.ts.net` (and `HOST=127.0.0.1`); stop
   `pnpm dev`; run `pnpm start`.
3. `tailscale serve --bg --https=443 http://127.0.0.1:3000`
4. While the app is still signed in with `https://<machine>.<tailnet>.ts.net:3000`, keep that working
   with a temporary second handler (same config, no extra process):
   `tailscale serve --bg --https=3000 http://127.0.0.1:3000`
5. In the app, sign out and sign in with `https://<machine>.<tailnet>.ts.net`. It keeps its phone
   record, and audio recorded meanwhile waits in its journal until it's uploaded.
6. Remove the temporary handler: `tailscale serve --https=3000 off`.
7. Hermes on this Mac: set its `mcp_servers.hearloom.url` to `http://127.0.0.1:3000/mcp` (Agent page,
   step 4) and run `hermes gateway restart`.

## Tests

```sh
pnpm check && pnpm typecheck && pnpm test
```

Server tests create and delete rows and close open conversations, so they only run against a local
database: `DATABASE_URL` on localhost, or `TEST_DATABASE_URL` (in `.env` or the environment) pointing
at a throwaway database, which is needed when `.env` points at a hosted one.

## License

[AGPL-3.0](LICENSE). If you run a modified Hearloom as a network service, you must publish your changes.
