# Connecting an agent (Hermes)

Hearloom doesn't summarize or "think" on its own. It exposes your memory to an agent of your choice —
designed for [Hermes Agent](https://github.com/NousResearch/hermes-agent) running Claude.

## MCP endpoint

`POST {PUBLIC_URL}/mcp` — stateless Streamable HTTP, `Authorization: Bearer hl_…`.
Create a token in the console → **Agent**. Scopes: `read` (all tools below) and `notify`
(`send_notification`). Tokens are stored hashed; revoke them any time.

| Tool | What it returns |
|---|---|
| `get_current_context` | local time, the current episode (kind, with whom), busy or not, quiet hours, pendant state, last 5 minutes |
| `search_transcripts` | full-text search (English + Dutch stemming, plus substring), optional speaker/time filter |
| `get_timeline` | everything in a range (≤ 7 days), one line per event |
| `list_episodes` / `get_episode` | what was happening — conversation, talk, media (TV, radio), ambient, solo — with participants; full transcript in parts of 400 lines |
| `list_sound_events` | non-speech sounds (AudioSet labels) |
| `list_people` | known voices, last heard |
| `changes_since` | episodes started, ended or changed, and bookmarks since a cursor — cheap wake-up check |
| `get_audio_clip_url` | short-lived signed URLs to the Ogg Opus audio |
| `send_notification` | push to the phone (and pendant buzz); policy still applies: quiet hours, hourly cap, "after the conversation" |

Output is compact text for LLMs:

```
## Tue 2026-10-06 · Conversation · episode 01a1… · 09:30–09:52 · Me, Alice, S2
09:30:12 Me: Did the fix land?
09:30:20 [door slam]
09:31–09:45 {music}
```

## Webhooks

Set a URL and secret in the console → **Agent**. Hearloom POSTs JSON events:
`episode.ended` (with its kind; per kind on/off — by default conversations, talks and unclassified
speech, not media, ambient or solo), `episode.refined` (off by default), `bookmark` (and `test`).
Bodies contain ids, kinds and times only; the agent reads content over MCP.

Headers: `X-Hearloom-Event`, `X-Hearloom-Timestamp`, and
`X-Hearloom-Signature: sha256=<hex HMAC-SHA256(secret, "{timestamp}.{body}")>`.

## Hermes configuration

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  hearloom:
    url: http://your-mac.your-tailnet.ts.net:3000/mcp
    headers:
      Authorization: "Bearer ${HEARLOOM_MCP_TOKEN}"
```

Point a Hermes webhook route at itself (gateway port 8644) and set that URL in Hearloom; or use a Hermes
cron job whose pre-check calls `changes_since`.

## Security

Transcripts are **untrusted input** — anyone near the pendant (or a TV) can say "ignore previous
instructions…". Run Hermes isolated (Docker or a separate macOS user), give it only the MCP URL, use a
read-only token unless you want nudges, and keep its shell/browser toolsets off.
