# Hearloom — system design

Self-hosted, always-on audio memory for the Omi pendant. No Omi cloud services. One user (or household)
per deployment, running on a Mac reached over Tailscale.

## Goals

- Keep **everything heard** — speech (who, what, which language) and non-speech sound — durably, in near
  real time (seconds), even across bad connectivity.
- Store it so LLMs can use it cheaply: compact, timestamped, searchable, with raw audio behind it.
- Expose it to an agent of your choice (Hermes + Claude) instead of baking an LLM in.
- Open source (AGPL-3.0), self-hostable, private by default (local models where they're good enough).

## Architecture

```
Omi pendant ──BLE (Opus 16 kHz, 20 ms frames)──▶ iPhone app
                                                 Swift engine: journal on disk → /ingest WebSocket
                                                         │  acks; resend from last ack; offline backlog
                                                         ▼
Server (Bun) ── fsync'd spool → Ogg chunks (disk/S3) ── Postgres 18
   │  auth, typed API (oRPC), realtime, notifications (socket → APNs), MCP
   ├── live pipeline (child process): decode → VAD → ASR → speakers → sounds → conversations
   └── job queue (pg-boss) ──▶ worker: refine finished conversations (diarizer sidecar, batch ASR)
Web console (Vite/TanStack) ── same-origin to server        Hermes agent ── MCP + signed webhooks
```

| Component | Tech | Responsibility |
|---|---|---|
| `apps/mobile` | Expo SDK 58, RN 0.88, Swift module `omi-capture` | BLE + state restoration, frame journal, uplink, pendant button/haptics, offline-storage download, push |
| `apps/server` | Bun 1.4, Hono, oRPC, Better Auth, postgres.js + Drizzle | ingest, storage, API, realtime, notifications, live pipeline host, MCP |
| live pipeline | child process of the server, sherpa-onnx | real-time transcript, speakers, sound events, conversations |
| worker | Bun + pg-boss | refine pass per conversation |
| `sidecars/diarizer` | Swift + FluidAudio (Core ML) | offline speaker diarization |
| `apps/web` | Vite, TanStack Router/Query, Tailwind | timeline, people, notifications, devices, settings, agent tokens |
| Postgres | 18 + pgvector image | everything except audio; jobs; LISTEN/NOTIFY |

## Data flow and durability

1. **Pendant → phone.** One Opus frame per BLE notification. The phone stamps capture times (20 ms steps,
   re-anchored after mic sleep) and appends every frame to an on-disk journal before sending.
2. **Phone → server.** `/ingest` WebSocket (protocol v1, `docs/protocol.md`): binary audio batches with
   per-stream sequence numbers. The server fsyncs to a spool, then acks; the phone deletes only acked
   frames and resends from the last ack after any reconnect. Native code does all of this, so it works
   when iOS relaunches the app in the background without JS.
3. **Chunks.** Spooled frames become Ogg Opus files (no re-encoding; lost packets become TOC-only frames
   so timing holds) at ≤ 60 s or at silence gaps. Crash recovery replays the spool.
4. **Live pipeline** turns frames into rows within seconds (see models below).
5. **Refine** runs when a conversation ends (2 min of silence) and replaces live rows (kept, superseded).
6. **Offline.** Away from the phone, the pendant records to its own flash; the app downloads it on
   reconnect (raw records persisted first — stock firmware deletes data as it sends).

## Data model (Postgres)

`phones`, `wearables`, `capture_streams` (ack position), `audio_chunks` (storage key, time range),
`utterances` (time, text, lang, speaker key, person, wearer flag, source live/refine, superseded,
EN/NL full-text `tsvector`), `sound_events` (label, point/state, confidence), `conversations`,
`people` + `voiceprints`, `bookmarks`, `device_events`, `notifications` + `notification_deliveries`,
`user_settings`, `api_tokens`. Every row has a `user_id`; times are absolute (`timestamptz`).

## Model choices

Chosen against independent benchmarks where they exist (Artificial Analysis, HF Open ASR incl. Dutch,
Pipecat, BDM diarization benchmark) and our own measurements on Omi-style Opus audio.

| Stage | Choice | Runs | Why | Considered |
|---|---|---|---|---|
| VAD | Silero v6 | local (sherpa-onnx) | best noise robustness in independent tests; ~2 ms/s audio | TEN VAD, FireRedVAD |
| Live ASR | Soniox `stt-rt-v5` (if key) | cloud, ~$0.12/h of speech | per-word EN↔NL language ID, streaming speakers, EU residency, no training; we only stream during speech | MAI-Transcribe-2-Streaming (best English WER, but no diarization/lang tags, preview), AssemblyAI U-3.6, Meta Muse |
| Local / backlog ASR | Parakeet TDT 0.6B v3 int8 | local | 25 EU languages incl. Dutch (FLEURS-nl 6.4 %), ~0.06× real time | Whisper large-v3 (better Dutch, much slower, hallucinates on noise) |
| Refine ASR | ElevenLabs Scribe v2 (if key) | cloud, $0.22/h | best Dutch FLEURS (2.5 %), word timestamps, audio-event tags | MAI-Transcribe-2 batch, Soniox async, Gemini 3.5 Transcribe |
| Diarization | FluidAudio offline (segmentation + embeddings + VBx) | local, Core ML | consistent speakers per conversation; offline beats streaming (~2.5× lower DER) | pyannoteAI (paid), sherpa pyannote-3.0 (outdated) |
| Speaker ID | 3D-Speaker CAM++ (zh/en) | local | raw cosine separates speakers on Opus audio (same 0.75–0.91, different ≤ 0.51); 28 MB | WeSpeaker ResNet293 (better VoxCeleb EER, but scores overlapped 0.72–0.94 on our audio) |
| Sound events | CED-base (AudioSet, 527 classes, 16 kHz) | local, ~15 ms per 2 s window | at SOTA (mAP 50.0), trained on 16 kHz | EfficientAT (32 kHz), BEATs, CLAP (open vocabulary, later) |
| Scene captions | Gemini Flash-Lite batch (planned) | cloud, ~$0.02/h | cheapest decent captions | Qwen3-Omni-Captioner on MLX |

Thresholds: speaker match/cluster cosine 0.6; sound events open ≥ 0.45, close after two windows < 0.25.
Live transcription uses the cloud only if a key is set; everything else runs on the Mac.

**Cost** at ~14 h/day (≈170 h of speech/month): Soniox ~$20, Scribe refine ~$37 (optional), local ~$0.

## Notifications

One gateway for system alerts and agent nudges: policy (source toggles, hourly cap, quiet hours in the
user's timezone, "hold until the conversation ends") → delivery over the live socket (fast; can buzz the
pendant) with APNs fallback → audit trail and feedback (useful / not useful / snooze / reply).

## Agent interface

Stateless MCP endpoint `/mcp` with scoped, hashed tokens (`read`, `notify`): current context, transcript
search, timeline, conversations, sound events, people, `changes_since`, audio URLs, `send_notification`.
Signed webhooks (`conversation.ended`, `conversation.refined`, `bookmark`). Output is compact text
(`09:30:12 Me: …`, `[door slam]`, `{music}`). Transcripts are untrusted input; run the agent isolated.
Details: `docs/agent.md`.

## Security and privacy

Invite-only accounts (Better Auth; bearer tokens for the phone). Audio and transcripts stay on your Mac;
cloud calls only for providers you enable with keys. Signed, short-lived media URLs. Tailscale for
transport. Not yet: encryption at rest, retention policies, bystander redaction.

## Key decisions

| Decision | Why |
|---|---|
| Postgres, not Convex | full SQL, EN/NL full-text search, LISTEN/NOTIFY, no WebSocket ingest limits |
| Bun for server + worker, no Python | one language; ONNX via sherpa-onnx, Swift sidecar for Core ML |
| Native Swift capture, JS only for UI | background BLE must not depend on JS running |
| Expo SDK 58 beta | Xcode 27 requires the UIScene lifecycle |
| Refine pass kept | batch beats streaming by 15–65 % WER; offline diarization far beats live |
| No built-in LLM layer | the agent (Hermes + Claude) does summarizing/reasoning over MCP |

## Not yet built

MAI-Transcribe-2 and Gemini caption adapters, AccessorySetupKit pairing (relaunch after force-quit),
speaker naming in the iOS app, retention/encryption, Linux diarizer.
