# Models and processing

Hearloom runs small models locally (sherpa-onnx, ONNX Runtime on CPU) and uses cloud APIs only where
they clearly win. `pnpm --filter @hearloom/server download-models [--all]` fetches the local models into
`data/models`.

## Live pipeline

A child process of the server (`apps/server/src/live`) receives every stored batch of Opus frames and:

1. **Decodes** with libopus (`bun:ffi`), concealing lost packets so audio stays aligned with wall-clock
   time. Gaps longer than 2 s are mic sleep (silence) and start a new "run".
2. **Speech detection** — Silero VAD v6 (`silero_vad_v6.onnx`) via sherpa-onnx.
3. **Transcription**
   - With `SONIOX_API_KEY`: Soniox `stt-rt-v5` streaming for fresh audio. A session opens when speech
     starts (with 0.5 s pre-roll), streams only while there's speech activity and closes after 45 s
     without speech, so you pay for speech rather than silence. Per-word language ID (EN↔NL code-switching)
     and speaker labels come from Soniox.
   - Otherwise, and for backlog audio uploaded late: NVIDIA Parakeet TDT 0.6B v3 (int8) locally on each
     VAD segment. 25 European languages including Dutch; ~0.06× real time on an M5 Pro. Language is
     guessed from common EN/NL function words.
4. **Speakers** — 3D-Speaker CAM++ embeddings per utterance (≥ 1 s), matched against enrolled voiceprints
   (cosine ≥ `SPEAKER_MATCH_THRESHOLD`, default 0.6) and clustered within a conversation (S1, S2, …).
5. **Sound events** — CED-base (AudioSet, 527 classes, 16 kHz) on 2 s windows every 1 s, smoothed with
   hysteresis (open ≥ 0.45, close after two windows < 0.25). Speech classes are dropped.
6. **Conversations** — consecutive utterances less than 2 minutes apart.

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
