import type { Activity } from "./episodes";

/**
 * In-memory "what is happening right now" per user. The live pipeline (speech, episodes) and the
 * phone update it; the agent's get_current_context reads it.
 */
export interface LiveState {
  /** The episode the user is in right now (null: no speech going on). */
  activity: Activity | null;
  muted: boolean;
  wearableConnected: boolean;
  lastAudioAt: number | null;
  /** Streams whose live transcription is down (their speech is transcribed later, if at all). */
  transcriptionDown: Map<string, { since: number; error: string | null }>;
}

const states = new Map<string, LiveState>();

export function liveState(userId: string): LiveState {
  let s = states.get(userId);
  if (!s) {
    s = {
      activity: null,
      muted: false,
      wearableConnected: false,
      lastAudioAt: null,
      transcriptionDown: new Map(),
    };
    states.set(userId, s);
  }
  return s;
}

export function updateLiveState(userId: string, patch: Partial<LiveState>): void {
  Object.assign(liveState(userId), patch);
}

/** The user's current episode changed (started, re-classified, ended). */
export function setActivity(userId: string, activity: Activity | null): void {
  updateLiveState(userId, { activity });
}

/** A stream's live transcription is down (with why), or works again (ok). */
export function setTranscription(
  userId: string,
  streamId: string,
  ok: boolean,
  error: string | null,
): void {
  const down = liveState(userId).transcriptionDown;
  if (ok) down.delete(streamId);
  else if (!down.has(streamId)) down.set(streamId, { since: Date.now(), error });
}

/**
 * The live pipeline stopped: nobody is in an episode it is tracking anymore, and no stream's
 * transcription is known to be down.
 */
export function resetActivity(): void {
  for (const [userId, s] of states) {
    if (s.activity) setActivity(userId, null);
    s.transcriptionDown.clear();
  }
}
