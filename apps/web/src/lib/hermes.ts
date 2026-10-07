/*
 * The "Connect Hermes" card's values and copy blocks, kept pure so they can be tested (hermes.test.ts).
 * See docs/agent.md ("Hermes configuration") and docs/voice-commands.md ("Hermes setup").
 */

/** Hermes's webhook platform listens here by default. */
export const HERMES_WEBHOOK_PORT = 8644;
export const HERMES_ROUTE = "hearloom-voice";
/** Installed with `hermes skills install`; the route loads it by its frontmatter name. */
export const HEARLOOM_SKILL_NAME = "hearloom";
export const HEARLOOM_SKILL_URL =
  "https://raw.githubusercontent.com/wynn-dev/hearloom/main/hermes/skills/hearloom/SKILL.md";
export const AGENT_SECURITY_DOCS =
  "https://github.com/wynn-dev/hearloom/blob/main/docs/agent.md#security";
/**
 * What a voice command may use: full access, the owner's choice. These are the toolsets of Hermes's
 * default Telegram chat (`hermes-telegram`), listed one by one to leave out the two that wait for an
 * answer a webhook run can't get: `clarify`, and `computer_use` (Hermes asks to approve every action,
 * and `/approve` in Telegram doesn't reach the webhook run, so each one waits out the timeout and is
 * denied). No MCP server is named, so, like the chat, the run gets every enabled MCP server,
 * Hearloom included.
 */
export const HERMES_VOICE_TOOLSETS = [
  "web",
  "browser",
  "terminal",
  "file",
  "code_execution",
  "vision",
  "image_gen",
  "tts",
  "skills",
  "todo",
  "memory",
  "session_search",
  "connections",
  "delegation",
  "cronjob",
];
/**
 * The restricted alternative: only the Hearloom MCP server (by its bare name; `mcp-hearloom` would
 * add every enabled MCP server) and web search.
 */
export const HERMES_RESTRICTED_TOOLSETS = ["hearloom", "web"];
/**
 * The route's prompt. Only this (after the skill) reaches the model, not the payload, so it carries
 * what the skill uses to judge confidence. Hermes fills `{a.b}` from the JSON body.
 */
export const HERMES_VOICE_PROMPT =
  'Hearloom voice command, spoken at {spokenAt} (lang {lang}, name heard as "{heardAs}", speaker score {speaker.score}): <<<{command}>>>';

/** Where Hermes runs, as asked on the card. */
export type HermesWhere =
  | { kind: "local" }
  | { kind: "host"; host: string }
  | { kind: "custom"; url: string };

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * A host as typed ("mac-mini", "mac-mini.tail1234.ts.net:9000", "http://10.0.0.5/"), normalized to
 * `host[:port]`, or null if it isn't one.
 */
export function normalizeHost(input: string): string | null {
  const s = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  const m = s.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!m || !HOST.test(m[1]!)) return null;
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return null;
  return m[2] !== undefined ? `${m[1]}:${Number(m[2])}` : m[1]!;
}

/** The webhook URL Hearloom POSTs to: Hermes's route on that host. */
export function hermesWebhookUrl(where: HermesWhere): string {
  if (where.kind === "custom") return where.url.trim();
  const host = where.kind === "local" ? "127.0.0.1" : (normalizeHost(where.host) ?? where.host);
  const withPort = /:\d+$/.test(host) ? host : `${host}:${HERMES_WEBHOOK_PORT}`;
  return `http://${withPort}/webhooks/${HERMES_ROUTE}`;
}

/** Read a stored URL back into the card's choice (anything unusual is a custom URL). */
export function parseHermesWebhookUrl(url: string): HermesWhere {
  if (url === "" || url === hermesWebhookUrl({ kind: "local" })) return { kind: "local" };
  const m = url.match(/^http:\/\/([^/]+)\/webhooks\/hearloom-voice$/);
  if (m) {
    const host = m[1]!.replace(new RegExp(`:${HERMES_WEBHOOK_PORT}$`), "");
    if (host !== "localhost" && normalizeHost(host) === host) {
      return hermesWebhookUrl({ kind: "host", host }) === url
        ? { kind: "host", host }
        : { kind: "custom", url };
    }
  }
  return { kind: "custom", url };
}

/** Route name and listening port to put in Hermes's config, taken from the webhook URL. */
export function hermesRouteOf(webhookUrl: string): { route: string; port: number } {
  let route = HERMES_ROUTE;
  let port = HERMES_WEBHOOK_PORT;
  try {
    const u = new URL(webhookUrl);
    const m = u.pathname.match(/^\/webhooks\/([A-Za-z0-9_-]+)\/?$/);
    if (m) {
      route = m[1]!;
      // A different port in the URL is Hermes's own only if Hearloom talks to it directly.
      if (u.port) port = Number(u.port);
    }
  } catch {
    // Not a URL yet: the defaults.
  }
  return { route, port };
}

/** A YAML double-quoted scalar (JSON strings are valid YAML). */
const yamlString = (s: string) => JSON.stringify(s);

/** A YAML flow sequence of strings, wrapped every 6 items onto lines starting with `indent`. */
function flowList(items: string[], indent = ""): string {
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 6)
    lines.push(
      items
        .slice(i, i + 6)
        .map(yamlString)
        .join(", "),
    );
  return `[${lines.join(`,\n${indent} `)}]`;
}

export const TOKEN_PLACEHOLDER = "<paste the token from step 1>";
export const SECRET_PLACEHOLDER = "<your webhook secret>";

/** Lines for `~/.hermes/.env`. The token only while it's on screen; otherwise a placeholder. */
export function hermesEnvSnippet(opts: { token: string | null }): string {
  return [
    "# ~/.hermes/.env",
    "WEBHOOK_ENABLED=true",
    `HEARLOOM_MCP_TOKEN=${opts.token ?? TOKEN_PLACEHOLDER}`,
    "# Replies go to your Telegram home channel: set TELEGRAM_HOME_CHANNEL=<chat id>,",
    "# or send /sethome to the bot in that chat.",
  ].join("\n");
}

/** The `mcp_servers` and webhook route blocks for `~/.hermes/config.yaml`. */
export function hermesConfigSnippet(opts: {
  mcpUrl: string;
  webhookUrl: string;
  secret: string | null;
}): string {
  const { route, port } = hermesRouteOf(opts.webhookUrl);
  return `# ~/.hermes/config.yaml
mcp_servers:
  hearloom:
    url: ${yamlString(opts.mcpUrl)}
    headers:
      Authorization: "Bearer \${HEARLOOM_MCP_TOKEN}"

platforms:
  webhook:
    enabled: true
    extra:
      port: ${port}
      routes:
        ${route}:
          events: ["voice.command"]
          secret: ${yamlString(opts.secret ?? SECRET_PLACEHOLDER)}
          skills: [${yamlString(HEARLOOM_SKILL_NAME)}]
          prompt: ${yamlString(HERMES_VOICE_PROMPT)}
          deliver: telegram          # no chat_id: your home channel
          mirror_to_session: true    # so you can answer "yes, do it" in Telegram
          # Full access: the Telegram chat's tools minus clarify and computer_use. Restricted: ${flowList(HERMES_RESTRICTED_TOOLSETS)}
          toolsets: ${flowList(HERMES_VOICE_TOOLSETS, "                    ")}
`;
}

/** Install the skill, then restart the gateway to load the config. */
export function hermesCommandsSnippet(): string {
  return `hermes skills install ${HEARLOOM_SKILL_URL}
hermes gateway restart`;
}
