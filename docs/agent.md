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

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  hearloom:
    url: https://your-mac.your-tailnet.ts.net/mcp   # PUBLIC_URL + /mcp
    headers:
      Authorization: "Bearer ${HEARLOOM_MCP_TOKEN}"
```

## Security

Transcripts are **untrusted input** — anyone near the pendant (or a TV) can say "ignore previous
instructions…". Run Hermes isolated (Docker or a separate macOS user), give it only the MCP URL, and keep
its shell/browser toolsets off. A token can edit episodes (never the user's own edits), not delete
anything.

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
