import { z } from "zod";

/**
 * What a stretch of heard speech was. `unknown` until there is enough speech to tell (and for
 * episodes from before episodes existed).
 */
export const episodeKindSchema = z.enum([
  "conversation",
  "talk",
  "media",
  "ambient",
  "solo",
  "unknown",
]);
export type EpisodeKind = z.infer<typeof episodeKindSchema>;
export const EPISODE_KINDS = episodeKindSchema.options;

/** Kinds a user (or agent) can pick: every kind but `unknown`. */
export type KnownEpisodeKind = Exclude<EpisodeKind, "unknown">;
export const KNOWN_EPISODE_KINDS = EPISODE_KINDS.filter(
  (k): k is KnownEpisodeKind => k !== "unknown",
);

export const EPISODE_KIND_LABEL: Record<EpisodeKind, string> = {
  conversation: "Conversation",
  talk: "Talk",
  media: "Media",
  ambient: "Ambient",
  solo: "Solo",
  unknown: "Speech",
};

export const EPISODE_KIND_DESCRIPTION: Record<EpisodeKind, string> = {
  conversation: "You talking with people (meetings, calls on speaker)",
  talk: "Someone presenting while you listen (lecture, sermon, tour)",
  media: "TV, radio, podcasts, videos",
  ambient: "Speech nearby that you're not part of",
  solo: "Only you (dictation, thinking aloud, a call on the earpiece)",
  unknown: "Not classified yet",
};

/** Who last decided an episode's kind or boundaries: users win over agents, agents over rules. */
export const editSourceSchema = z.enum(["rule", "agent", "user"]);
export type EditSource = z.infer<typeof editSourceSchema>;
const RANK: Record<EditSource, number> = { rule: 0, agent: 1, user: 2 };

/** May `editor` change something last set by `current`? */
export function mayEdit(editor: EditSource, current: EditSource): boolean {
  return RANK[editor] >= RANK[current];
}
