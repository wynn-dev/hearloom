/**
 * In-memory "what is happening right now" per user. The live pipeline (speech + sound
 * events) updates it; notification policy and the agent's get_current_context read it.
 */
export interface LiveState {
  inConversation: boolean;
  conversationId: string | null;
  muted: boolean;
  wearableConnected: boolean;
  lastAudioAt: number | null;
}

const states = new Map<string, LiveState>();

export function liveState(userId: string): LiveState {
  let s = states.get(userId);
  if (!s) {
    s = {
      inConversation: false,
      conversationId: null,
      muted: false,
      wearableConnected: false,
      lastAudioAt: null,
    };
    states.set(userId, s);
  }
  return s;
}

export function updateLiveState(userId: string, patch: Partial<LiveState>): void {
  Object.assign(liveState(userId), patch);
}

/** The live pipeline stopped: nobody is in a conversation it is tracking anymore. */
export function resetConversationState(): void {
  for (const [userId, s] of states) {
    if (s.inConversation) updateLiveState(userId, { inConversation: false, conversationId: null });
  }
}
