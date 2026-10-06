/**
 * In-memory "what is happening right now" per user. The live pipeline (speech + sound
 * events) updates it; notification policy and, later, the agent's get_current_context read it.
 */
export interface LiveState {
  inConversation: boolean;
  conversationId: string | null;
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
  const s = liveState(userId);
  const wasInConversation = s.inConversation;
  Object.assign(s, patch);
  if (wasInConversation && !s.inConversation) {
    for (const fn of conversationEndListeners) fn(userId);
  }
}

export function onConversationEnd(fn: (userId: string) => void): () => void {
  conversationEndListeners.add(fn);
  return () => conversationEndListeners.delete(fn);
}
