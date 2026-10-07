import type { Activity } from "./episodes";
import type { StreamInfo } from "./processor";

export type HostMessage =
  | { t: "frames"; stream: StreamInfo; frames: { seq: number; at: number; data: Uint8Array }[] }
  | { t: "voiceprints_changed"; userId: string }
  | { t: "episodes_changed"; userId: string }
  | { t: "enroll"; requestId: string; userId: string; personId: string; utteranceId: string };

export type ChildMessage =
  | { t: "ready" }
  | { t: "log"; message: string }
  | { t: "invalidate"; userId: string; keys: Array<"timeline" | "status"> }
  | { t: "activity"; userId: string; activity: Activity | null }
  | { t: "block_closed"; userId: string; blockId: string }
  | { t: "enrolled"; requestId: string; ok: true; sampleSeconds: number }
  | { t: "enrolled"; requestId: string; ok: false; error: string };
