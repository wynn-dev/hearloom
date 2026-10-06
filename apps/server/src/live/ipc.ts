import type { StreamInfo } from "./processor";

export type HostMessage =
  | { t: "frames"; stream: StreamInfo; frames: { seq: number; at: number; data: Uint8Array }[] }
  | { t: "voiceprints_changed"; userId: string }
  | { t: "enroll"; requestId: string; userId: string; personId: string; utteranceId: string };

export type ChildMessage =
  | { t: "ready" }
  | { t: "log"; message: string }
  | { t: "invalidate"; userId: string; keys: Array<"timeline" | "status"> }
  | {
      t: "state";
      userId: string;
      patch: { inConversation?: boolean; conversationId?: string | null };
    }
  | { t: "conversation_ended"; userId: string; conversationId: string }
  | { t: "enrolled"; requestId: string; ok: true; sampleSeconds: number }
  | { t: "enrolled"; requestId: string; ok: false; error: string };
