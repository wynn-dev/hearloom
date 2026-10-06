# Hearloom

Self-hosted, always-on audio memory for the [Omi](https://www.omi.me/) pendant — without any of Omi's
cloud services. The pendant streams to your iPhone over Bluetooth; the phone forwards audio to your own
server, which keeps every second (speech **and** non-speech sound) as a structured, searchable timeline.

> Status: early development. Working end to end: iOS capture (Swift), durable upload, live
> transcription (EN/NL), speakers, sound events, conversations, refine pass, notifications, web console,
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
pnpm dev                        # server :3000 + worker + console :5173
pnpm dev:host                   # same, console also on your tailnet over HTTPS (see TRUSTED_ORIGINS)
```

Simulate a phone streaming audio (no hardware needed):

```sh
HEARLOOM_EMAIL=you@example.com HEARLOOM_PASSWORD=... pnpm --filter @hearloom/server simulate-phone
```

Reach the server from your phone over [Tailscale](https://tailscale.com): set `PUBLIC_URL` to your
machine's MagicDNS name (e.g. `https://mac.your-tailnet.ts.net` via `tailscale serve`).

## License

[AGPL-3.0](LICENSE). If you run a modified Hearloom as a network service, you must publish your changes.
