import type { EpisodeKind } from "@hearloom/shared";
import type { Activity } from "./episodes";

/**
 * In-memory "what is happening right now" per user. The live pipeline (speech, episodes) updates
 * it; notification policy and the agent's get_current_context read it.
 */
export interface LiveState {
  /**
   * The user is busy: in an episode of a kind where notifications should be quiet (see
   * `isBusyKind`).
   */
  inConversation: boolean;
  /** The episode the user is in right now (null: no speech going on). */
  activity: Activity | null;
  muted: boolean;
  wearableConnected: boolean;
  lastAudioAt: number | null;
}

const states = new Map<string, LiveState>();
const conversationEndListeners = new Set<(userId: string) => void>();

export function liveState(userId: string): LiveState {
  let s = states.get(userId);
  if (!s) {
    s = {
      inConversation: false,
      activity: null,
      muted: false,
      wearableConnected: false,
      lastAudioAt: null,
    };
    states.set(userId, s);
  }
  return s;
}

export function updateLiveState(userId: string, patch: Partial<LiveState>): void {
  const s = liveState(userId);
  const wasInConversation = s.inConversation;
  Object.assign(s, patch);
  if (wasInConversation && !s.inConversation) {
    for (const fn of conversationEndListeners) fn(userId);
  }
}

/** Talking with someone, listening to a talk, or speech not classified yet: keep it quiet. */
export function isBusyKind(kind: EpisodeKind): boolean {
  return kind === "conversation" || kind === "talk" || kind === "unknown";
}

/** The user's current episode changed (started, re-classified, ended). */
export function setActivity(userId: string, activity: Activity | null): void {
  updateLiveState(userId, {
    activity,
    inConversation: activity !== null && isBusyKind(activity.kind),
  });
}

/** The live pipeline stopped: nobody is in an episode it is tracking anymore. */
export function resetConversationState(): void {
  for (const [userId, s] of states) {
    if (s.activity || s.inConversation) setActivity(userId, null);
  }
}

export function onConversationEnd(fn: (userId: string) => void): () => void {
  conversationEndListeners.add(fn);
  return () => conversationEndListeners.delete(fn);
}
