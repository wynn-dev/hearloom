# Protocols

## 1. Omi pendant → phone (BLE)

Consumer pendant ("CV1"), firmware ≥ 3.0.20. Constants live in `packages/shared/src/omi.ts`.

| What | UUID | Notes |
|---|---|---|
| Audio data | `19B10001-E8F2-537E-4F6C-D104768A1214` | notify; `[pkt_idx u16 LE][sub_idx u8][opus…]` |
| Codec | `19B10002-…` | read u8; CV1 = **21** (Opus 16 kHz, 20 ms frames, CELT-only) |
| Time sync | `19B10031-…` | write u32 LE epoch seconds on every connect |
| Battery | `0x180F / 0x2A19` | notify, every ~5 s |
| Button | `23BA7925-0000-1000-7450-346EAC492E92` | notify int32 LE: 1 tap, 2 double tap, 5 hold released |
| Haptic | `CAB1AB96-2EA5-4F4D-BB56-874B72CFC984` | write u8: 1/2/3 = 100/300/500 ms |
| Features | `19B10021-…` | read u32 LE bitmask |

Gotchas:

- With MTU ≥ 166 each notification is exactly one Opus frame (`sub_idx = 0`). iPhones negotiate ≥ 185.
- `pkt_idx` gaps mean **lost** notifications. Silence is different: after ~10 s of quiet the mic sleeps and
  notifications stop entirely. Timestamp frames on arrival; treat arrival gaps as silence.
- Only one central may connect. Remove/disable the official Omi app.
- Offline storage reads are **destructive** on stock firmware (data is deleted as it is sent).

## 2. Phone → server: ingest WebSocket (v1)

`GET /ingest` upgraded to a WebSocket, authenticated with `Authorization: Bearer <session token>`
(Better Auth bearer token from sign-in). Types and codec: `packages/shared/src/ingest.ts`.

### Durability model

The phone numbers every Opus frame of a capture stream from 0 (`seq`) and journals it to disk before
sending. The server appends frames to a spool file and `fsync`s before acknowledging. An `ack` with
`seq = N` means every frame `≤ N` of that stream is durably stored, so the phone may delete them. After
any reconnect the phone sends `hello` again; `welcome.ackedSeq` says where to resume. Resent frames
(`seq ≤ ackedSeq`) are ignored, so retries are idempotent.

### Messages

Binary audio batch (little-endian):

```
u8  0x01           message type
u8  slot           stream slot bound by a prior hello (one socket can carry several streams)
u64 firstSeq
u64 baseTimeMs     unix ms capture time of the first frame
u16 count          ≤ 1000
count × { u32 offsetMs, u16 len, u8[len] opusFrame }
```

Frames in a batch have consecutive `seq`s. Capture times are the phone's: contiguous frames advance by
exactly 20 ms; lost BLE packets advance by the missing count × 20 ms; mic-sleep gaps re-anchor to the wall
clock. The server fills gaps ≤ 2 s with TOC-only Opus packets (decoders run packet-loss concealment) and
starts a new audio chunk after longer gaps.

JSON control messages, client → server:

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `v, slot, phoneId, stream{id, codec, sampleRate, frameMs, startedAt}, wearable?` | bind a stream to a slot |
| `bye` | `slot, endedAt` | user stopped capture on purpose (no "disconnected" alerts) |
| `wearable` | `wearable, connected, at` | pendant connected/disconnected, device info |
| `event` | `kind, value?, peripheralId?, at` | `battery`, `charging`, `button`, `bookmark`, `muted`, `unmuted`, `ack_nudge` |
| `notify_ack` | `id` | the phone displayed a notification received over the socket |
| `ping` | `at` | keepalive / clock check |

Server → client:

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `slot, streamId, ackedSeq, serverTime, config` | resume point + phone config |
| `ack` | `slot, seq` | durable through `seq` |
| `config` | `config` | settings changed (button mapping, pendant haptics) |
| `notify` | `id, title, body, category, deepLink?, threadId?, interruptionLevel, haptic?` | show now; reply with `notify_ack` |
| `haptic` | `pattern` | buzz the pendant |
| `error` | `code, message, fatal?` | fatal errors close the socket |
| `pong` | `at, serverTime` | |

Button actions run **on the phone** using `config.button` (mute must work offline); the phone reports the
resulting semantic events (`bookmark`, `muted`, …).

## 3. Notifications

Every notification (system alerts, rules, later the agent) goes through one gateway
(`apps/server/src/notify`):

1. **Policy** — source toggles, hourly cap (non-system), quiet hours in the user's timezone (unless
   `time-sensitive`), and "hold until the current conversation ends".
2. **Delivery** — over the live ingest socket when the phone is connected (fast, and the only way to buzz
   the pendant); if the phone doesn't `notify_ack` within 4 s, fall back to APNs.
3. **Audit** — every attempt is stored in `notification_deliveries`; feedback (useful / not useful /
   snooze / reply) is stored on the notification.

APNs categories: `HL_NUDGE` (actions: Useful, Not useful, Snooze, Reply) and `HL_SYSTEM`. Deep links are
in-app paths only.
