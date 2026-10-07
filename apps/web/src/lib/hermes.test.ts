import { expect, test } from "bun:test";
import {
  HEARLOOM_SKILL_URL,
  HERMES_RESTRICTED_TOOLSETS,
  HERMES_VOICE_PROMPT,
  HERMES_VOICE_TOOLSETS,
  hermesCommandsSnippet,
  hermesConfigSnippet,
  hermesEnvSnippet,
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
  expect(hermesRouteOf("http://localhost:9000/webhooks/hearloom")).toEqual({
    route: "hearloom",
    port: 9000,
  });
  // Behind a proxy: Hermes keeps its own route name and default port.
  expect(hermesRouteOf("https://proxy.example/hermes")).toEqual({
    route: "hearloom-voice",
    port: 8644,
  });
  expect(hermesRouteOf("not a url")).toEqual({ route: "hearloom-voice", port: 8644 });
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
  mcp_servers: { hearloom: { url: string; headers: { Authorization: string } } };
  platforms: {
    webhook: {
      enabled: boolean;
      extra: { port: number; routes: Record<string, Record<string, unknown>> };
    };
  };
}

test("config.yaml: valid YAML with the real values filled in", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw+/0=";
  const yaml = hermesConfigSnippet({
    mcpUrl: "https://mac.tail1234.ts.net/mcp",
    webhookUrl: LOCAL,
    secret,
  });
  const config = Bun.YAML.parse(yaml) as HermesConfig;
  expect(config.mcp_servers.hearloom).toEqual({
    url: "https://mac.tail1234.ts.net/mcp",
    // Hermes expands ${VAR} from ~/.hermes/.env itself.
    headers: { Authorization: `Bearer $\{HEARLOOM_MCP_TOKEN}` },
  });
  expect(config.platforms.webhook.enabled).toBe(true);
  expect(config.platforms.webhook.extra.port).toBe(8644);
  const route = config.platforms.webhook.extra.routes["hearloom-voice"]!;
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
  expect(yaml).toContain('Restricted: ["hearloom", "web"]');
  expect(HERMES_RESTRICTED_TOOLSETS).toEqual(["hearloom", "web"]);
});

test("config.yaml: placeholder without a secret on screen; odd values stay valid YAML", () => {
  const placeholder = Bun.YAML.parse(
    hermesConfigSnippet({ mcpUrl: "http://localhost:3000/mcp", webhookUrl: LOCAL, secret: null }),
  ) as HermesConfig;
  expect(placeholder.platforms.webhook.extra.routes["hearloom-voice"]!.secret).toBe(
    SECRET_PLACEHOLDER,
  );

  const odd = 'my "raw" secret: #1 \\ {x}';
  const custom = Bun.YAML.parse(
    hermesConfigSnippet({
      mcpUrl: "http://localhost:3000/mcp",
      webhookUrl: "http://localhost:9000/webhooks/voice",
      secret: odd,
    }),
  ) as HermesConfig;
  expect(custom.platforms.webhook.extra.port).toBe(9000);
  expect(custom.platforms.webhook.extra.routes.voice!.secret).toBe(odd);
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
