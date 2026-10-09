"""Hermes gateway hook: tell Hearloom that a voice command was answered.

Hearloom sends each "hey <agent>" command to the `hearloom-voice` webhook route, with the command's
id as the `webhook-id` header. Hermes uses that header as the delivery id and encodes it in the
run's chat id (`webhook:v2:<base64url of [profile, route, delivery_id]>`). When that run ends with
a response, this hook POSTs `/api/voice/commands/<id>/replied` to Hearloom, which buzzes the pendant
twice. No reply within 2 minutes and Hearloom buzzes three times instead.

Install: copy this directory to ~/.hermes/hooks/ and restart the gateway (`hermes gateway restart`).
Configuration (environment, e.g. ~/.hermes/.env):
  HEARLOOM_MCP_TOKEN    the Hearloom agent token Hermes already uses for MCP (required)
  HEARLOOM_URL          default http://127.0.0.1:3000
  HEARLOOM_VOICE_ROUTE  default hearloom-voice
"""

import asyncio
import base64
import json
import logging
import os
import re
import urllib.error
import urllib.request

logger = logging.getLogger("hooks.hearloom-voice-reply")

PREFIX = "webhook:v2:"
COMMAND_ID = re.compile(r"^[0-9a-fA-F-]{36}$")


def command_id(context: dict) -> str | None:
    """The voice command id of a finished run on the Hearloom voice route; None for anything else."""
    if context.get("platform") != "webhook":
        return None
    chat_id = str(context.get("chat_id") or "")
    if not chat_id.startswith(PREFIX):
        return None
    token = chat_id[len(PREFIX):]
    try:
        parts = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(parts, list) or len(parts) != 3:
        return None
    _profile, route, delivery_id = parts
    if route != os.environ.get("HEARLOOM_VOICE_ROUTE", "hearloom-voice"):
        return None
    if not isinstance(delivery_id, str) or not COMMAND_ID.match(delivery_id):
        return None
    return delivery_id


def post_replied(cmd_id: str) -> str:
    base = os.environ.get("HEARLOOM_URL", "http://127.0.0.1:3000").rstrip("/")
    token = os.environ.get("HEARLOOM_MCP_TOKEN", "")
    if not token:
        return "no HEARLOOM_MCP_TOKEN"
    req = urllib.request.Request(
        f"{base}/api/voice/commands/{cmd_id}/replied",
        data=b"{}",
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return json.loads(res.read() or b"{}").get("status", str(res.status))
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return f"error: {e}"


async def handle(event_type: str, context: dict):
    cmd_id = command_id(context)
    # No response (the run failed or stayed silent): no reply, Hearloom's timeout says so.
    if not cmd_id or not str(context.get("response") or "").strip():
        return
    status = await asyncio.to_thread(post_replied, cmd_id)
    logger.info("[hearloom-voice-reply] command %s replied: %s", cmd_id, status)
