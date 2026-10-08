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

`pnpm start` serves everything from one port: the built console, `/api`, `/rpc`, the `/ingest` and
`/realtime` WebSockets, `/media` and `/mcp`. So one address works for the iOS app, the console in a
browser and an agent, and remote access is one persistent [Tailscale](https://tailscale.com) serve:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

```sh
# .env
PUBLIC_URL=https://<machine>.<tailnet>.ts.net
```

Then open `https://<machine>.<tailnet>.ts.net` on the phone, and sign the app in with the same URL.
`--bg` keeps the serve across restarts of Tailscale and the Mac; check it with `tailscale serve status`.
HTTPS matters for the browser: the mic (voice teaching) needs it, and with an `https://` `PUBLIC_URL`
the session cookies are Secure, so browsers drop them over plain HTTP from anything but localhost.

Auth trusts the address a request came in on (as `tailscale serve` and Vite forward it), so the console
and the app work from any URL that reaches this server. `TRUSTED_ORIGINS` is only for a console on
another origin. Hermes on the same Mac talks to `http://127.0.0.1:3000/mcp` and needs no serve at all
(the console's Agent page fills that in).

Plain `http://<machine>.<tailnet>.ts.net:3000` also reaches the server over the tailnet, but only while
no `tailscale serve` handler uses port 3000: a serve on a port takes it over on the tailnet address, and
plain HTTP to it then gets `400`.

`pnpm dev` (Vite with hot reload on `http://localhost:5173`) is for development on the Mac itself. It
uses the same `PORT` as `pnpm start`, so stop one before starting the other.

### Moving from separate serves (console :5173, server :3000)

1. Stop the old serves: Ctrl-C the foreground ones; turn off background ones with
   `tailscale serve --https=<port> off`. `tailscale serve status` should list nothing.
2. Set `PUBLIC_URL=https://<machine>.<tailnet>.ts.net` in `.env`, stop `pnpm dev`, run `pnpm start`.
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
