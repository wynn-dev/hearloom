import type { WakeConfig } from "@hearloom/shared";

export type VoiceMode = "off" | "shadow" | "on";

/** What the live pipeline needs to detect one user's voice commands. */
export interface VoiceConfig {
  mode: VoiceMode;
  wake: WakeConfig;
  /** Voiceprint similarity a command needs to count as the user's own voice. */
  minScore: number;
  /** Buzz the pendant when the wake phrase is heard, and with how the command went. */
  haptics: boolean;
}

/**
 * What the pendant tells the user about a voice command:
 * - heard: the wake phrase was heard (in their voice);
 * - sent: the agent took the command;
 * - no_command: nothing came after the wake phrase (or it turned out not to be one);
 * - failed: the command wasn't sent (rejected here, or the agent couldn't be reached).
 */
export type VoiceCue = "heard" | "sent" | "no_command" | "failed";

/** A cue from the live pipeline (`sent`, and failed deliveries, come from the server). */
export interface VoiceCueEvent {
  userId: string;
  cue: Exclude<VoiceCue, "sent">;
  /** heard: audio time the name ended (for latency logs). */
  nameEndAt: number | null;
  /** heard: from the recognizer's running transcript, or from a finished utterance. */
  via: "partial" | "final" | null;
  /** When the pipeline decided (wall clock). */
  at: number;
}

export type IgnoreReason =
  | "no_voiceprint"
  /** None of the command's audio was retained (its stream went away). */
  | "clip_missing"
  /** Too little audio to check the voice, even padded. */
  | "clip_too_short"
  /** The own-voice check failed (speaker model or database error). */
  | "check_error"
  | "not_own_voice"
  | "media_voice"
  | "rate_limited"
  | "no_command"
  | "near_miss"
  /** The audio or the recognizer broke off mid-command: what was heard may be missing its end. */
  | "cut_off";

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

/**
 * A teaching result as the live pipeline reports it: with the voice embedding to learn, if any.
 * The host stores the voiceprint together with the sample row (one transaction), so a voiceprint
 * never exists without the sample that can remove it.
 */
export interface TeachHeard extends Omit<TeachResult, "voiceprintId"> {
  embedding: number[] | null;
}
