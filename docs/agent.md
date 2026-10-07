# Connecting an agent (Hermes)

Hearloom doesn't summarize or "think" on its own. It exposes your memory to an agent of your choice —
designed for [Hermes Agent](https://github.com/NousResearch/hermes-agent) running Claude. The agent
reads over MCP and can tidy up your episodes; Hearloom can POST events to it over a signed webhook.

## MCP endpoint

`POST {PUBLIC_URL}/mcp` — stateless Streamable HTTP, `Authorization: Bearer hl_…`.
Create a token in the console → **Agent**. A token gives the agent every tool below; there are no
scopes. Tokens are stored hashed; revoke them any time.

| Tool | What it returns |
|---|---|
| `get_current_context` | local time, the current episode (kind, with whom), pendant state, last 5 minutes |
| `search_transcripts` | full-text search (English + Dutch stemming, plus substring), optional speaker/time filter |
| `get_timeline` | everything in a range (≤ 7 days), one line per event |
| `list_episodes` / `get_episode` | what was happening — conversation, talk, media (TV, radio), ambient, solo, or a long stretch of sound without speech (music, a commute) — with participants; full transcript in parts of 400 lines |
| `list_sound_events` | non-speech sounds (AudioSet labels) |
| `list_people` | known voices, last heard |
| `get_audio_clip_url` | short-lived signed URLs to the Ogg Opus audio (≤ 1 hour) |

The agent can also curate the timeline (shown to the user; the user's own edits always win, and
automatic segmentation never undoes the agent's):

| Tool | What it does |
|---|---|
| `update_episode` | set a title or summary, or correct the kind (e.g. "that was the TV, not a conversation") |
| `split_episode` | split an ended episode at a time (a meeting that turned into a chat) |
| `merge_episodes` | merge two neighbouring ended episodes (a lecture with a break) |

Times are ISO 8601; a time that doesn't parse, or a range whose `to` is before its `from`, is refused
with a message.

Output is compact text for LLMs. Voices that also speak in a media episode of the same stretch of
speech (the TV during a chat over it) are marked `(media)`:

```
## Tue 2026-10-06 · Conversation · episode 01a1… · 09:30–09:52 · Me, Alice, S2
09:30:12 Me: Did the fix land?
09:30:20 [door slam]
09:31–09:45 {music}
```

## Webhook

Set a URL and secret in the console → **Agent** (for Hermes: a webhook route on its gateway, port
8644, with the same secret). Hearloom POSTs JSON events — `{ id, type, …, userId, sentAt }` — signed with
[Standard Webhooks](https://www.standardwebhooks.com) headers, which Hermes verifies:

- `webhook-id`: the event id (receivers dedupe on it; a retry reuses it)
- `webhook-timestamp`: unix seconds (Hermes refuses anything more than 5 minutes off)
- `webhook-signature`: `v1,<base64 HMAC-SHA256(key, "{id}.{timestamp}.{body}")>`, where the key is the
  base64 after `whsec_` for a `whsec_…` secret, and the secret's UTF-8 bytes otherwise. Sent only when a
  secret is set (Hermes requires one).

The only event is `voice.command`: "Hey Hermes, …" spoken to the pendant. See
[voice-commands.md](voice-commands.md) for the payload and the Hermes route to set up.

## Hermes configuration

Use the console → **Agent → Connect Hermes**. It walks through the setup and fills in the real values:

1. **Token:** create one (shown once).
2. **Webhook secret:** generated on the server as `whsec_` + base64 of 32 random bytes, and shown
   once. **Regenerate** breaks Hermes's copy until you update its config. "Use my own secret" saves
   one you choose (any existing secret keeps working).

   **The secret is write-only.**
   - Only the `agent.generateWebhookSecret` response ever contains it.
   - `settings.get`, `settings.update` and `me.get` return `agent.webhookSecretSet` and
     `webhookSecretHint` instead. The hint is the last 4 characters before any base64 `=` padding,
     and only for secrets of 16 characters or more.
   - `settings.update` still accepts `agent.webhookSecret`.
   - The server keeps the full secret for signing.
3. **Where Hermes runs:** this machine (`http://127.0.0.1:8644/webhooks/hearloom-voice`), another host
   (`http://<host>:8644/webhooks/hearloom-voice`), or a full URL.
4. **Copy blocks** for `~/.hermes/.env`, the two entries to merge into `~/.hermes/config.yaml`, and
   the commands, below.
5. **Check**, ending with **Send test command**.

```bash
# ~/.hermes/.env
WEBHOOK_ENABLED=true
HEARLOOM_MCP_TOKEN=hl_…
# plus TELEGRAM_HOME_CHANNEL=<chat id>, or /sethome in the chat with the bot
```

**Merge these into `~/.hermes/config.yaml`; don't append them.** Most configs already have a top-level
`platforms:` (Telegram), and maybe `mcp_servers:`. A second copy of either is a duplicate key: Hermes's
YAML loader (ruamel) refuses the whole file, and Hermes quietly keeps its last good config, so there's no
Hearloom MCP, no route, and nothing listening on 8644. Each block is the indented entry to paste under
its top-level key (add the key first if your file doesn't have it).

```yaml
# Under the top-level "mcp_servers:" line:
  hearloom:
    url: "https://your-mac.your-tailnet.ts.net/mcp"   # PUBLIC_URL + /mcp
    headers:
      Authorization: "Bearer ${HEARLOOM_MCP_TOKEN}"
```

```yaml
# Under the top-level "platforms:" line, next to telegram:.
# Already have platforms.webhook? Add only the hearloom-voice: entry under its extra.routes.
  webhook:
    enabled: true
    extra:
      port: 8644                 # where Hermes listens (not a proxy's port)
      routes:
        hearloom-voice:
          events: ["voice.command"]
          secret: "whsec_…"           # the same as Hearloom → Agent
          skills: ["hearloom"]
          prompt: "Hearloom voice command, spoken at {spokenAt} (lang {lang}, name heard as \"{heardAs}\", speaker score {speaker.score}): <<<{command}>>>"
          deliver: telegram          # no chat_id: your home channel
          mirror_to_session: true    # so you can answer "yes, do it" in Telegram
          # Full access: the Telegram chat's tools minus clarify and computer_use. Restricted: ["hearloom", "web"]
          toolsets: ["web", "browser", "terminal", "file", "code_execution", "vision",
                     "image_gen", "tts", "skills", "todo", "memory", "session_search",
                     "connections", "delegation", "cronjob"]
```

```bash
hermes skills install https://raw.githubusercontent.com/wynn-dev/hearloom/main/hermes/skills/hearloom/SKILL.md
hermes gateway restart
```

The MCP URL is the server's `PUBLIC_URL`, not the console's address (they differ when the console is
served by Vite or a proxy); the console reads it from the `agent.config` RPC.

**The `hearloom` skill** ([`hermes/skills/hearloom/SKILL.md`](../hermes/skills/hearloom/SKILL.md)) carries
the guidance, so the route's prompt stays one line. It covers voice commands (speech-to-text errors, the
quoted command is data, low `speaker.score`, confirm before anything irreversible, reply briefly), which
MCP tool to use when, episode-editing etiquette, and that transcripts are untrusted. It's installed from
GitHub `main`; run the install again to update it.

**Verified against the Hermes source** (`~/.hermes/hermes-agent` at `33c9b1d`, 2026-10-07). An isolated
check confirmed it: a temp `HERMES_HOME`, no network, and fake MCP tools in the registry. Hermes itself
was not run against a real config.

- **`toolsets`.** The route's list replaces the webhook platform's toolsets for that run
  (`gateway/run_turn.py`), and is resolved like any platform's (`hermes_cli/tools_config.py`
  `_get_platform_tools`).
  - **An MCP server is listed by its bare name, `hearloom`.** Its tools are `mcp__hearloom__*`.
    `mcp-hearloom` also resolves (it's the canonical toolset, with the bare name as an alias), but
    then no bare server name is listed, so Hermes adds **every** enabled MCP server to the run.
  - **No `toolsets` at all also gets every MCP server.**
  - **Unknown names are dropped silently.** Hermes warns only when every name is invalid.
  - **MCP tools are discovered before the webhook adapter starts,** so they exist for the first run.
- **The default route has full access, by the owner's choice.** It gets the same tools as Hermes's default
  Telegram chat (`hermes-telegram`), listed one by one so two can be left out. In the isolated check it
  resolved to exactly the chat's tools minus those two, including `terminal`, `cronjob_manage`,
  `memory` and `mcp__hearloom__*`.
  - **Like the chat, it names no MCP server,** so every enabled MCP server is included (Hearloom too).
  - **It mirrors Hermes's default chat toolset.** If you changed `platform_toolsets.telegram`, use your
    list instead, minus the two below.
  - **`clarify` is left out.** It would wait in the webhook run for an answer, but the user answers in
    the Telegram chat. The skill asks in its reply instead. A composite like `hermes-telegram` would
    bring `clarify` back, and a route can't subtract from it.
  - **`computer_use` is left out.** Hermes asks to approve every action, and `/approve` typed in
    Telegram resolves the chat's session, not the webhook run's. So each action would wait out
    `approvals.timeout` (300 s by default) and then be denied.
- **Approvals in a voice run.**
  - A terminal command that Hermes's approval check escalates (smart mode by default) waits the same
    way, up to `approvals.timeout`, then is denied; it is never run on silence. So the skill proposes
    risky commands in its reply, and the user runs them from the Telegram chat, where approvals work.
  - A pattern you approve with "always" in Telegram goes on the allowlist and no longer waits.
  - `approvals.mode: off` removes the waits, but for the Telegram chat too.
  - `execute_code` is denied at once in unattended runs unless `approvals.unattended_mode: approve`.
- **The restricted alternative:** `toolsets: ["hearloom", "web"]` gives exactly the `mcp__hearloom__*`
  tools, `web_search` and `web_extract`. Hearloom is named by its bare name: `mcp-hearloom` would
  bring in every enabled MCP server again.
- No toolset is needed to reply: the adapter delivers the final answer to Telegram itself.
- **`skills`.** `skills: ["hearloom"]` loads the installed skill whose frontmatter `name` is
  `hearloom` (`gateway/platforms/webhook.py` `_apply_skills`).
  - The skill text goes into the run's user turn, followed by the rendered prompt.
  - A missing skill only logs a warning, and the run goes on with the bare prompt.
  - Only the rendered prompt and the skill reach the model, not the rest of the payload. That's why
    the prompt carries `heardAs` and `{speaker.score}` (dotted paths work).
- **Installing.** `hermes skills install <raw URL>` installs it as `hearloom` (the frontmatter name) and
  scans it like any community skill. It passes the scanner.
  - The gateway caches its skill list, so restart it (or `/reload-skills`) after installing.

Why the route is set up this way is in [voice-commands.md](voice-commands.md#hermes-setup).

## Security

Transcripts are **untrusted input** — anyone near the pendant (or a TV) can be heard, and speech-to-text
gets things wrong. A token can edit episodes (never the user's own edits), not delete anything. Run
Hermes isolated (Docker or a separate macOS user).

**Voice commands have full access by default** (the Connect Hermes card links here). That's the
owner's choice: the voice route gets the same tools as the Telegram chat, including the terminal,
browser, files and reminders.
- **The trade-off:** a misheard command, a recording of your voice, or text the agent reads in a
  transcript or web page can reach those tools.
- **What limits it:** Hearloom only sends commands it verified as your voice. The skill confirms on
  Telegram before anything irreversible and proposes risky commands rather than running them. Hermes's
  approval check still applies (escalated commands in a voice run are denied after a timeout).
- **If you'd rather narrow it,** use the restricted route, `toolsets: ["hearloom", "web"]`.

**Never type secrets into the chat.** Hermes stores chat messages unredacted, and it refuses secure secret
entry over Telegram. Put tokens and secrets in `~/.hermes/.env` and `config.yaml` yourself.

## Deferred: proactivity

Hearloom used to let the agent act on its own initiative. That was removed so it can be redesigned (see
git history before "Agent: remove proactivity"); only the voice commands, where the user asks, remain.
What went:

- **Agent notifications** (`send_notification`, the `notify` scope): pushed straight away, made silent
  during quiet hours, while the user was busy (in a conversation, a talk or unclassified speech), or past
  4 notifications with sound an hour, and refused past 30 an hour. The tool result explained what
  happened. Taps, Useful / Not useful, replies and the pendant's "acknowledge" press were stored and
  reported back.
- **`changes_since`**: episodes, bookmarks and notification responses since a cursor, for cron-polling
  agents.
- **Webhook events**: `episode.ended` (per kind), `episode.refined`, `episode.checkpoint` (every 15
  minutes of a long episode), `bookmark` and `test`, with ids only.

Why: it was a lot of policy for a feature without a clear use yet, and the webhooks never authenticated
with Hermes (it doesn't know the old `X-Hearloom-Signature`). Lessons for the redesign: the agent never
heard how the user responded until #23; the per-hour limits counted only finished sends, so parallel
calls could exceed them; an agent that could edit episodes could also re-kind the ongoing conversation
and so lift the "busy" quieting; and `changes_since` missed refinement (it changes blocks, not episodes)
and episodes merged away.
