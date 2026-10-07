# Models and processing

Hearloom runs small models locally (sherpa-onnx, ONNX Runtime on CPU) and uses one cloud provider,
Soniox, for transcription. `pnpm --filter @hearloom/server download-models` fetches the local models into
`data/models`.

## Live pipeline

A child process of the server (`apps/server/src/live`) receives every stored batch of Opus frames and:

1. **Decodes** with libopus (`bun:ffi`), concealing lost packets so audio stays aligned with wall-clock
   time. Gaps longer than 2 s are mic sleep (silence) and start a new "run".
2. **Speech detection** — Silero VAD v6 (`silero_vad_v6.onnx`) via sherpa-onnx.
3. **Transcription** — Soniox only (`SONIOX_API_KEY` is required unless `LIVE_ASR=off`). Per-word
   language ID (EN↔NL code-switching) and speaker labels come from Soniox.
   - Fresh audio: `stt-rt-v5` streaming. A session opens when speech starts (with 0.5 s pre-roll),
     streams only while there's speech activity and closes after 45 s without speech, so you pay for
     speech rather than silence. If a session fails (connection, auth, quota), the speech it didn't
     transcribe is lost and Soniox is retried after 30 s; there is no local fallback.
   - Backlog audio uploaded late (> 30 s old, e.g. recordings downloaded from the pendant): its VAD
     segments are stitched together (up to 0.3 s of silence between them) into batches of up to 5
     minutes of speech and transcribed with `stt-async-v5`. A batch is sent once it's full or its
     upload has been quiet for 10 s; one batch is in flight at a time per stream. API calls retry
     rate limits and outages for a few minutes, then the batch is retried twice more before it's
     given up (logged). Utterances split at segment boundaries and are capped at 30 s. Backlog
     blocks and conversations aren't reported as finished (and refined) until all their batches are
     placed.
     Batches still in memory when the pipeline restarts are lost.
4. **Speakers** — 3D-Speaker CAM++ embeddings per utterance (≥ 1 s), matched against enrolled voiceprints
   (cosine ≥ `SPEAKER_MATCH_THRESHOLD`, default 0.6) and clustered within a conversation (S1, S2, …;
   Soniox's per-session labels map into the same series). Re-attributing an utterance replaces the
   voiceprint learned from it.
5. **Sound events** — CED-base (AudioSet, 527 classes, 16 kHz) on 2 s windows every 1 s, smoothed with
   hysteresis (open ≥ 0.45, close after two windows < 0.25). Speech classes are dropped.
6. **Conversations and blocks** — consecutive utterances less than 2 minutes apart form a
   conversation. A conversation is cut into **blocks**, the unit the refine pass works on: a block
   closes when the conversation ends, at the first pause of ≥ 1.5 s once it is 10 minutes long, and
   before any utterance that would make it longer than 20 minutes. So a lecture or an evening of TV is
   refined as it goes instead of hours later. Backlog audio joins the closed block it falls in or
   next to (while that stays under 20 minutes), else a new block of that conversation, else a new
   closed conversation; blocks and conversations left open by a crashed pipeline are closed when it
   restarts.

### Why CAM++ instead of WeSpeaker ResNet293

ResNet293 has the better VoxCeleb EER, but its raw cosine scores were not usable on our audio
(16 kHz Opus, non-VoxCeleb voices). Measured after an Omi-style Opus round trip:

| Model | Same speaker | Different speakers |
|---|---|---|
| WeSpeaker ResNet293-LM, raw cosine | 0.73–0.94 | 0.72–0.89 (overlaps) |
| ResNet293, cohort-mean centered | 0.28–0.69 | 0.21–0.52 (overlaps) |
| **3D-Speaker CAM++ zh/en advanced, raw cosine** | **0.75–0.91** | **−0.01–0.51** |

(Real recordings of two speakers from the sherpa-onnx test set, plus Apple TTS voices in English and
Dutch.) CAM++ is also 4× smaller and much faster. Tune the thresholds on your own recordings.

## Enrollment

"This is me" / "This is Alice" on any utterance (`people.enroll`) decodes that utterance's stored audio,
computes a voiceprint and attributes the utterance. Each person can have several voiceprints; the best
match wins. Enroll yourself from a few different situations (quiet room, outside, phone call).

## Refine pass (worker)

When a block closes the server queues a job (pg-boss, in Postgres).
`pnpm --filter @hearloom/server worker` then:

1. Loads the block's audio from the stored Ogg chunks, plus what the previous (refined) block of the
   conversation said in the 90 s before it, if that's on the same capture stream.
2. **Diarizes it offline** with FluidAudio (pyannote-style segmentation + embeddings + VBx clustering,
   Core ML on the Neural Engine) — `sidecars/diarizer`, built with
   `pnpm --filter @hearloom/server build:diarizer`. Offline diarization gives consistent speakers
   within a block, which streaming labels can't.
3. Gives each speaker cluster the conversation's key for that voice (S1, S2, …), so keys stay the same
   across blocks: the previous block's speaker it shares speech with in those 90 s; else a voice the
   conversation's refined blocks already know (cosine ≥ `SPEAKER_CLUSTER_THRESHOLD`); else the live
   key most of its utterances had (if no earlier block uses it); else a new key. Matches are
   one-to-one: two clusters of one block never share a key.
4. Names each cluster against enrolled voiceprints (or keeps the name its key already had); a
   confident match on an utterance's own voiceprint wins over the cluster (diarizers can merge similar
   voices).
5. Replaces the live rows it re-derived (kept with `superseded_at` for history; rows without stored audio
   stay live) and marks the block `refined`, storing each cluster's voice for later blocks. If a row
   was edited meanwhile (e.g. a speaker was identified), the job retries.
6. Once the conversation has ended and all its blocks are refined, merges keys that are the same voice
   but were split across blocks (never two keys heard in one block, or named after different people)
   and marks the conversation `refined`.

20 s of audio diarizes in ~0.3–1.3 s on an M5 Pro.
