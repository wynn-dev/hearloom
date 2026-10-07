import type { WakeConfig } from "@hearloom/shared";

export type VoiceMode = "off" | "shadow" | "on";

/** What the live pipeline needs to detect one user's voice commands. */
export interface VoiceConfig {
  mode: VoiceMode;
  wake: WakeConfig;
  /** Voiceprint similarity a command needs to count as the user's own voice. */
  minScore: number;
}

export type IgnoreReason =
  | "no_voiceprint"
  | "not_own_voice"
  | "media_voice"
  | "rate_limited"
  | "no_command"
  | "near_miss";

/** A wake phrase the pipeline heard, sent to the server to store and (maybe) deliver. */
export interface VoiceDetection {
  /** Also the webhook event id (the receiver's idempotency key). */
  id: string;
  userId: string;
  streamId: string;
  chainId: string;
  spokenAt: number;
  endedAt: number;
  /** Each utterance's own span (learning from a command skips what was between them). */
  parts: { startAt: number; endAt: number }[];
  detectedAt: number;
  wakeName: string;
  heardAs: string;
  nameScore: number;
  transcript: string;
  command: string;
  lang: string | null;
  speakerScore: number | null;
  /** pending = deliver now; shadow = would have; ignored = see reason. */
  status: "pending" | "shadow" | "ignored";
  reason: IgnoreReason | null;
}

/** What the user is being asked to say on the Voice page. */
export interface TeachPrompt {
  sessionId: string;
  /** sample = learn from it; test = only report whether it would trigger. */
  kind: "sample" | "test";
  index: number;
  phrase: string;
  /** The user's own person (voiceprints are learned for it). */
  personId: string;
}

export interface TeachResult {
  sessionId: string;
  kind: "sample" | "test";
  index: number;
  phrase: string;
  source: "pendant" | "browser";
  /** What the recognizer heard. */
  text: string;
  /** The utterance is the prompted phrase. */
  ok: boolean;
  heardAs: string | null;
  nameScore: number;
  /** The wake matcher fires on it (with the current names and aliases). */
  wouldMatch: boolean;
  /** Best similarity to the user's voiceprints before this sample (null: none, or too short). */
  speakerScore: number | null;
  /** Seconds of audio the sample's embedding used. */
  seconds: number;
  /** A voiceprint was learned from it. */
  voiceprintId: string | null;
  /** It would have triggered a command: name recognized and own voice verified. */
  wouldTrigger: boolean;
  /** The sample couldn't be processed (e.g. transcription failed). */
  error?: string;
}
