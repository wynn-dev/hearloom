import type { Activity } from "./episodes";
import type { StreamInfo } from "./processor";
import type { TeachHeard, TeachPrompt, VoiceCueEvent, VoiceDetection } from "./voice/types";

export type HostMessage =
  | {
      t: "frames";
      stream: StreamInfo;
      frames: { seq: number; at: number; data: Uint8Array }[];
      /** When the server received the frames (unix ms): live or backlog is judged from it. */
      receivedAt: number;
    }
  | { t: "voiceprints_changed"; userId: string }
  | { t: "episodes_changed"; userId: string }
  | { t: "enroll"; requestId: string; userId: string; personId: string; utteranceId: string }
  /** Voice settings or samples changed: reload the user's voice config. */
  | { t: "voice_changed"; userId: string }
  /** The user is teaching their voice (null: stopped). */
  | { t: "teach"; userId: string; prompt: TeachPrompt | null }
  /** A teaching sample recorded in the browser (16 kHz mono). */
  | { t: "teach_audio"; userId: string; prompt: TeachPrompt; pcm: Int16Array }
  /** Embed the user's voice from stored audio (a voice command they confirmed), if it's theirs. */
  | {
      t: "learn_voice";
      requestId: string;
      userId: string;
      streamId: string;
      /** The command's utterances (not the gaps between them). */
      ranges: { startAt: number; endAt: number }[];
    };

export type ChildMessage =
  | { t: "ready" }
  | { t: "log"; message: string }
  /** A stream's live transcription is down (with why), or works again. */
  | { t: "asr_health"; userId: string; streamId: string; ok: boolean; message: string | null }
  | { t: "invalidate"; userId: string; keys: Array<"timeline" | "status"> }
  | { t: "activity"; userId: string; activity: Activity | null }
  | { t: "block_closed"; userId: string; blockId: string }
  | { t: "enrolled"; requestId: string; ok: true; sampleSeconds: number; note: string | null }
  | { t: "enrolled"; requestId: string; ok: false; error: string }
  | { t: "voice_command"; detection: VoiceDetection }
  /** Buzz the pendant about a voice command (the wake phrase was heard, or nothing came of it). */
  | { t: "voice_cue"; cue: VoiceCueEvent }
  | { t: "teach_heard"; userId: string; result: TeachHeard }
  | { t: "learned"; requestId: string; ok: true; embedding: number[]; seconds: number }
  | { t: "learned"; requestId: string; ok: false; error: string };
