import { resolve } from "node:path";
import { z } from "zod";

const repoRoot = resolve(import.meta.dir, "../../..");

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 chars"),
  /** The URL phones and browsers use to reach this server (e.g. your Tailscale MagicDNS name). */
  PUBLIC_URL: z.url().default("http://localhost:3000"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(3000),
  DATA_DIR: z.string().default(resolve(repoRoot, "data")),
  /** Built web console to serve at "/". */
  WEB_DIST: z.string().default(resolve(repoRoot, "apps/web/dist")),
  /** Extra origins allowed to call the auth API (comma separated), e.g. the Vite dev server. */
  TRUSTED_ORIGINS: z.string().default(""),
  APP_SCHEME: z.string().default("hearloom"),
  APNS_KEY_PATH: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().default("me.weish.hearloom"),
  MEDIA_URL_TTL_SEC: z.coerce
    .number()
    .int()
    .default(6 * 3600),
  /** Close an audio chunk after this much audio. */
  CHUNK_MAX_SEC: z.coerce.number().int().default(60),
  /** Start a new chunk when frames are this far apart (mic sleeps on silence). */
  CHUNK_GAP_MS: z.coerce.number().int().default(2000),
  /** Finalize the open chunk after no frames for this long, so recent audio is playable. */
  CHUNK_IDLE_MS: z.coerce.number().int().default(8000),

  // --- Live pipeline (transcription, sound events, speakers) ---
  LIVE_PIPELINE: z.enum(["on", "off"]).default("on"),
  /** auto = Soniox for fresh audio when SONIOX_API_KEY is set, else local Parakeet. */
  LIVE_ASR: z.enum(["auto", "soniox", "local", "off"]).default("auto"),
  SONIOX_API_KEY: z.string().optional(),
  SONIOX_MODEL: z.string().default("stt-rt-v5"),
  LANGUAGE_HINTS: z.string().default("en,nl"),
  /** Local model files (pnpm --filter @hearloom/server download-models). Defaults to DATA_DIR/models. */
  MODELS_DIR: z.string().optional(),
  /** Cosine similarity needed to attribute speech to an enrolled voice. */
  SPEAKER_MATCH_THRESHOLD: z.coerce.number().default(0.6),
  /** Cosine similarity for grouping unknown voices within a conversation. */
  SPEAKER_CLUSTER_THRESHOLD: z.coerce.number().default(0.6),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

export const env = loadEnv();
export const modelsDir = env.MODELS_DIR ?? `${env.DATA_DIR}/models`;
