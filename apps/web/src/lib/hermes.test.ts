import { expect, test } from "bun:test";
import {
  HEARLOOM_SKILL_URL,
  HERMES_RESTRICTED_TOOLSETS,
  HERMES_VOICE_PROMPT,
  HERMES_VOICE_TOOLSETS,
  hermesCommandsSnippet,
  hermesConfigSnippets,
  hermesEnvSnippet,
  hermesMcpUrl,
  hermesRouteOf,
  hermesWebhookUrl,
  normalizeHost,
  parseHermesWebhookUrl,
  SECRET_PLACEHOLDER,
  TOKEN_PLACEHOLDER,
} from "./hermes";

const LOCAL = "http://127.0.0.1:8644/webhooks/hearloom-voice";

test("webhook URL from where Hermes runs", () => {
  expect(hermesWebhookUrl({ kind: "local" })).toBe(LOCAL);
  expect(hermesWebhookUrl({ kind: "host", host: "mac-mini.tail1234.ts.net" })).toBe(
    "http://mac-mini.tail1234.ts.net:8644/webhooks/hearloom-voice",
  );
  expect(hermesWebhookUrl({ kind: "host", host: " http://10.0.0.5:9000/ " })).toBe(
    "http://10.0.0.5:9000/webhooks/hearloom-voice",
  );
  expect(hermesWebhookUrl({ kind: "custom", url: " https://h.example/x " })).toBe(
    "https://h.example/x",
  );
});

test("normalizeHost accepts host names, IPs and ports; refuses the rest", () => {
  expect(normalizeHost("mac-mini")).toBe("mac-mini");
  expect(normalizeHost("HTTPS://Mac.ts.net/anything")).toBe("Mac.ts.net");
  expect(normalizeHost("10.0.0.5:08644")).toBe("10.0.0.5:8644");
  for (const bad of ["", " ", "a b", "-x", "x-", "host:0", "host:70000", "user@host", "a..b"]) {
    expect(normalizeHost(bad)).toBeNull();
  }
});

test("a stored URL reads back as the choice that made it", () => {
  expect(parseHermesWebhookUrl("")).toEqual({ kind: "local" });
  expect(parseHermesWebhookUrl(LOCAL)).toEqual({ kind: "local" });
  expect(
    parseHermesWebhookUrl("http://mac-mini.tail1234.ts.net:8644/webhooks/hearloom-voice"),
  ).toEqual({ kind: "host", host: "mac-mini.tail1234.ts.net" });
  expect(parseHermesWebhookUrl("http://10.0.0.5:9000/webhooks/hearloom-voice")).toEqual({
    kind: "host",
    host: "10.0.0.5:9000",
  });
  for (const url of [
    "http://localhost:8644/webhooks/hearloom-voice",
    "http://mac-mini/webhooks/hearloom-voice",
    "https://mac-mini:8644/webhooks/hearloom-voice",
    "http://localhost:8644/webhooks/hearloom",
  ]) {
    expect(parseHermesWebhookUrl(url)).toEqual({ kind: "custom", url });
  }
});

test("the route name and port follow the webhook URL", () => {
  expect(hermesRouteOf(LOCAL)).toEqual({ route: "hearloom-voice", port: 8644 });
  // Loopback, or a host the card built: Hearloom talks to Hermes directly, so that port is Hermes's.
  expect(hermesRouteOf("http://localhost:9000/webhooks/hearloom")).toEqual({
    route: "hearloom",
    port: 9000,
  });
  expect(hermesRouteOf("http://mac-mini.tail1234.ts.net:9000/webhooks/hearloom-voice")).toEqual({
    route: "hearloom-voice",
    port: 9000,
  });
  // A custom URL elsewhere may be a proxy: its port isn't Hermes's, which stays 8644.
  expect(hermesRouteOf("https://proxy.example:8443/webhooks/hearloom-voice")).toEqual({
    route: "hearloom-voice",
    port: 8644,
  });
  expect(hermesRouteOf("https://proxy.example/hermes")).toEqual({
    route: "hearloom-voice",
    port: 8644,
  });
  expect(hermesRouteOf("not a url")).toEqual({ route: "hearloom-voice", port: 8644 });
});

test("MCP URL: loopback for Hermes on this machine, PUBLIC_URL's otherwise", () => {
  const config = {
    mcpUrl: "https://mac.tail1234.ts.net/mcp",
    localMcpUrl: "http://127.0.0.1:3000/mcp",
  };
  expect(hermesMcpUrl(config, LOCAL)).toBe("http://127.0.0.1:3000/mcp");
  expect(hermesMcpUrl(config, "http://localhost:9000/webhooks/hearloom")).toBe(
    "http://127.0.0.1:3000/mcp",
  );
  expect(hermesMcpUrl(config, "http://[::1]:8644/webhooks/hearloom-voice")).toBe(
    "http://127.0.0.1:3000/mcp",
  );
  expect(hermesMcpUrl(config, "http://mac-mini.tail1234.ts.net:8644/webhooks/hearloom-voice")).toBe(
    "https://mac.tail1234.ts.net/mcp",
  );
  expect(hermesMcpUrl(config, "https://proxy.example/hermes")).toBe(
    "https://mac.tail1234.ts.net/mcp",
  );
  expect(hermesMcpUrl(config, "not a url")).toBe("https://mac.tail1234.ts.net/mcp");
});

test(".env lines: the token while it's on screen, a placeholder otherwise", () => {
  const env = hermesEnvSnippet({ token: "hl_abc123" });
  expect(env).toContain("WEBHOOK_ENABLED=true\n");
  expect(env).toContain("HEARLOOM_MCP_TOKEN=hl_abc123\n");
  expect(env).toContain("TELEGRAM_HOME_CHANNEL");
  expect(env).toContain("/sethome");
  expect(hermesEnvSnippet({ token: null })).toContain(`HEARLOOM_MCP_TOKEN=${TOKEN_PLACEHOLDER}`);
  // Every non-comment line is KEY=value.
  for (const line of env.split("\n").filter((l) => !l.startsWith("#"))) {
    expect(line).toMatch(/^[A-Z_]+=\S+$/);
  }
});

interface HermesConfig {
  model?: unknown;
  mcp_servers: Record<string, { url?: string; command?: string; headers?: Record<string, string> }>;
  platforms: {
    telegram?: { enabled: boolean };
    webhook: {
      enabled: boolean;
      extra: { port: number; routes: Record<string, Record<string, unknown>> };
    };
  };
}

/**
 * Duplicate keys within any one mapping of a block-style YAML document. Bun.YAML (like many parsers)
 * keeps the last one silently; Hermes's ruamel refuses the whole file, so tests must catch them.
 */
function duplicateKeys(yaml: string): string[] {
  const dups: string[] = [];
  const stack: { indent: number; keys: Set<string> }[] = [{ indent: 0, keys: new Set() }];
  for (const line of yaml.split("\n")) {
    const m = line.match(/^( *)([A-Za-z0-9_.-]+):(?:\s|$)/);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length > 1 && stack.at(-1)!.indent > indent) stack.pop();
    if (stack.at(-1)!.indent < indent) stack.push({ indent, keys: new Set() });
    const keys = stack.at(-1)!.keys;
    if (keys.has(m[2]!)) dups.push(m[2]!);
    keys.add(m[2]!);
  }
  return dups;
}

/** Paste each block on the line after its top-level key, adding the key if the file lacks it. */
function merge(config: string, blocks: { mcpServer: string; webhookPlatform: string }): string {
  let out = config;
  for (const [key, block] of [
    ["mcp_servers", blocks.mcpServer],
    ["platforms", blocks.webhookPlatform],
  ] as const) {
    const lines = out.split("\n");
    let at = lines.indexOf(`${key}:`);
    if (at === -1) {
      lines.push(`${key}:`);
      at = lines.length - 1;
    }
    lines.splice(at + 1, 0, ...block.trimEnd().split("\n"));
    out = lines.join("\n");
  }
  return out;
}

/** Like the owner's: Telegram set up, another MCP server, both top-level keys present. */
const EXISTING = `model:
  default: anthropic/claude-opus-5-5
mcp_servers:
  github:
    command: npx
platforms:
  telegram:
    enabled: true
approvals:
  mode: smart
`;

test("duplicateKeys finds a repeated key at any level", () => {
  expect(duplicateKeys(EXISTING)).toEqual([]);
  expect(duplicateKeys(`${EXISTING}platforms:\n  webhook:\n    enabled: true\n`)).toEqual([
    "platforms",
  ]);
  expect(duplicateKeys("a:\n  b: 1\n  b: 2\nc: 3\n")).toEqual(["b"]);
  expect(duplicateKeys("a:\n  b: 1\nc:\n  b: 2\n")).toEqual([]);
});

test("config.yaml: two blocks, each valid YAML, with the real values filled in", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw+/0=";
  const blocks = hermesConfigSnippets({
    mcpUrl: "https://mac.tail1234.ts.net/mcp",
    webhookUrl: LOCAL,
    secret,
  });
  // Neither block starts a top-level key: they're the indented entries to paste under one.
  for (const block of [blocks.mcpServer, blocks.webhookPlatform]) {
    for (const line of block.split("\n").filter((l) => l && !l.startsWith("#"))) {
      expect(line).toMatch(/^ {2}/);
    }
    expect(duplicateKeys(block)).toEqual([]);
  }
  expect(blocks.mcpServer).toContain('under the top-level "mcp_servers:" line');
  expect(blocks.webhookPlatform).toContain('under the top-level "platforms:" line');
  expect(blocks.webhookPlatform).toContain("Already have platforms.webhook?");

  expect(Bun.YAML.parse(blocks.mcpServer)).toEqual({
    hearloom: {
      url: "https://mac.tail1234.ts.net/mcp",
      // Hermes expands ${VAR} from ~/.hermes/.env itself.
      headers: { Authorization: `Bearer $\{HEARLOOM_MCP_TOKEN}` },
    },
  });
  const { webhook } = Bun.YAML.parse(blocks.webhookPlatform) as HermesConfig["platforms"];
  expect(webhook.enabled).toBe(true);
  expect(webhook.extra.port).toBe(8644);
  const route = webhook.extra.routes["hearloom-voice"]!;
  expect(route).toEqual({
    events: ["voice.command"],
    secret,
    skills: ["hearloom"],
    prompt: HERMES_VOICE_PROMPT,
    deliver: "telegram",
    mirror_to_session: true,
    toolsets: HERMES_VOICE_TOOLSETS,
  });
  // The skill carries the guidance: the prompt stays one short line, with the fields it judges by.
  expect(HERMES_VOICE_PROMPT).not.toContain("\n");
  expect(HERMES_VOICE_PROMPT.length).toBeLessThan(160);
  for (const field of ["{spokenAt}", "{heardAs}", "{speaker.score}", "<<<{command}>>>"]) {
    expect(HERMES_VOICE_PROMPT).toContain(field);
  }
  // Full access by default (the owner's choice): the Telegram chat's toolsets, including the
  // terminal and reminders, but never clarify or computer_use (they wait in the webhook run for an
  // answer that can't arrive) and no composite bundle (which would bring clarify back).
  for (const full of ["terminal", "browser", "file", "cronjob", "memory", "web"]) {
    expect(route.toolsets).toContain(full);
  }
  for (const never of [
    "clarify",
    "computer_use",
    "hermes-telegram",
    "hermes-webhook",
    "mcp-hearloom",
  ]) {
    expect(route.toolsets).not.toContain(never);
  }
  // No MCP server named, so the run gets every enabled one, Hearloom included, like the chat.
  expect(route.toolsets).not.toContain("hearloom");
  // The restricted alternative is mentioned next to it, and names Hearloom by its bare name.
  expect(blocks.webhookPlatform).toContain('Restricted: ["hearloom", "web"]');
  expect(HERMES_RESTRICTED_TOOLSETS).toEqual(["hearloom", "web"]);
});

test("config.yaml: pasted into an existing config, no duplicate keys and nothing lost", () => {
  const blocks = hermesConfigSnippets({
    mcpUrl: "https://mac.tail1234.ts.net/mcp",
    webhookUrl: LOCAL,
    secret: "whsec_c2VjcmV0c2VjcmV0",
  });
  const merged = merge(EXISTING, blocks);
  expect(duplicateKeys(merged)).toEqual([]);
  const config = Bun.YAML.parse(merged) as HermesConfig;
  expect(Object.keys(config.mcp_servers).sort()).toEqual(["github", "hearloom"]);
  expect(config.mcp_servers.github).toEqual({ command: "npx" });
  expect(config.platforms.telegram).toEqual({ enabled: true });
  expect(config.platforms.webhook.extra.routes["hearloom-voice"]!.toolsets).toEqual(
    HERMES_VOICE_TOOLSETS,
  );
  expect(config).toHaveProperty("approvals.mode", "smart");

  // A config without either key: add the key lines, then paste. Also fine.
  const fresh = merge("model:\n  default: x\n", blocks);
  expect(duplicateKeys(fresh)).toEqual([]);
  const freshConfig = Bun.YAML.parse(fresh) as HermesConfig;
  expect(Object.keys(freshConfig.mcp_servers)).toEqual(["hearloom"]);
  expect(Object.keys(freshConfig.platforms)).toEqual(["webhook"]);

  // What appending whole top-level blocks used to do: duplicate keys, which Hermes refuses.
  const appended = `${EXISTING}mcp_servers:\n${blocks.mcpServer}platforms:\n${blocks.webhookPlatform}`;
  expect(duplicateKeys(appended).sort()).toEqual(["mcp_servers", "platforms"]);
});

test("config.yaml: placeholder without a secret on screen; odd values stay valid YAML", () => {
  const platform = (secret: string | null, webhookUrl = LOCAL) =>
    (
      Bun.YAML.parse(
        hermesConfigSnippets({ mcpUrl: "http://localhost:3000/mcp", webhookUrl, secret })
          .webhookPlatform,
      ) as HermesConfig["platforms"]
    ).webhook;
  expect(platform(null).extra.routes["hearloom-voice"]!.secret).toBe(SECRET_PLACEHOLDER);

  const odd = 'my "raw" secret: #1 \\ {x}';
  const custom = platform(odd, "http://localhost:9000/webhooks/voice");
  expect(custom.extra.port).toBe(9000);
  expect(custom.extra.routes.voice!.secret).toBe(odd);
});

test("commands: install the skill from GitHub raw main, then restart the gateway", () => {
  expect(HEARLOOM_SKILL_URL).toBe(
    "https://raw.githubusercontent.com/wynn-dev/hearloom/main/hermes/skills/hearloom/SKILL.md",
  );
  expect(hermesCommandsSnippet().split("\n")).toEqual([
    `hermes skills install ${HEARLOOM_SKILL_URL}`,
    "hermes gateway restart",
  ]);
});
