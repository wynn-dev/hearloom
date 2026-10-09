"""Hermes gateway hook: tell Hearloom how Hermes's run on a voice command went.

Hearloom sends each "hey <agent>" command to the `hearloom-voice` webhook route, with the command's
id as the `webhook-id` header. Hermes uses that header as the delivery id and encodes it in the
run's chat id (`webhook:v2:<base64url of [profile, route, delivery_id]>`). For runs on that route:

- agent:start  POST /api/voice/commands/<id>/started: Hearloom then waits up to 10 minutes for the
               end of the run instead of 2.
- agent:end    POST /api/voice/commands/<id>/replied with {"outcome": "answered"} (the pendant
               buzzes twice) or {"outcome": "failed", "reason": ...} when the run failed, was
               interrupted or ended without an answer (three times).

Reports are retried for about 30 s on connection errors and 5xx (Hearloom restarting answers 503).
Failures are logged at WARNING.

Install: copy this directory to ~/.hermes/hooks/ and restart the gateway (`hermes gateway restart`):
hooks are loaded once, when the gateway starts.
Configuration (environment, e.g. ~/.hermes/.env):
  HEARLOOM_MCP_TOKEN    the Hearloom agent token Hermes already uses for MCP (required)
  HEARLOOM_URL          default http://127.0.0.1:3000
  HEARLOOM_VOICE_ROUTE  default hearloom-voice
"""

import asyncio
import base64
import contextvars
import http.client
import json
import logging
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from functools import lru_cache

logger = logging.getLogger("hooks.hearloom-voice-reply")

PREFIX = "webhook:v2:"
COMMAND_ID = re.compile(r"^[0-9a-fA-F-]{36}$")
# Pauses between attempts at a report (s): about 30 s in all, enough for Hearloom to restart.
RETRY_DELAYS = (1, 2, 4, 8, 8, 8)


def command_id(context: dict) -> str | None:
    """The voice command id of a run on the Hearloom voice route; None for anything else."""
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


def secret(name: str) -> str:
    """A credential of the profile this run belongs to (multi-profile gateways), else the env."""
    try:
        from agent.secret_scope import get_secret

        return get_secret(name, "") or ""
    except Exception:
        return os.environ.get(name, "")


def is_silence(response: str) -> bool:
    """Hermes's "stay quiet" marker: nothing is delivered, so there was no answer."""
    try:
        from gateway.response_filters import is_autonomous_silence_response

        return bool(is_autonomous_silence_response(response))
    except Exception:
        return False


# ---- did the run answer? ----------------------------------------------------------------------
#
# Hermes passes agent:end hooks no failure flag (the context is platform, user_id, chat_id,
# thread_id, chat_type, session_id, message, response[:500], model, provider); a failed run's
# `response` is its error text. So: the run's result as the gateway has it (see `run_result`),
# then the error texts Hermes replies with in place of an answer (at the start of the response).
# Only without the result: raw interrupted-run texts and provider-error envelopes (an answer may
# well start with "HTTP 503 means…").

# gateway.errors.* keys of replies that stand in for an answer (gateway/run.py, run_turn.py).
FAILURE_KEYS = (
    "generic_failed",
    "generic_failed_with_hint",
    "interrupted_before_start",
    "stopped_before_finishing",
    "no_response",
    "previous_turn_cleanup",
    "unexpected_silence",
    "context_overflow",
    "session_storage_unavailable",
    "session_storage_unavailable_disk",
    "history_unavailable",
    "no_credentials",
    "provider_kept_failing",
    "rate_limited",
    "usage_limit_resets",
    "auth_failed",
    "bad_request",
    "connection_interrupted",
    "unreachable",
    "connection_unknown",
)
# Used only where Hermes's catalog can't be loaded (the English texts, 2026-10).
FALLBACK_FAILURE_TEXTS = (
    "⚠️ Something went wrong and I couldn't finish this reply.",
    "⚠️ Your message was interrupted before processing started",
    "⚠️ I had to stop before finishing",
    "⚠️ Processing completed but no response was generated.",
    "⚠️ Your message wasn't processed (the previous turn was still being cleaned up).",
    "⚠️ The model returned only a silence marker for a message that needed a reply.",
    "⚠️ {model} didn't produce a reply this time, even after retries.",
)
# Raw texts of interrupted or abandoned runs (the webhook surface gets them unsanitized).
FAILURE_PREFIXES = ("Operation interrupted", "Turn abandoned")
# Hermes's provider-error shape (gateway/run.py `_GATEWAY_PROVIDER_ERROR_SHAPE_RE`), abridged.
PROVIDER_ERROR = re.compile(
    r"^\s*(\W*\s*)?(api\s+(call\s+)?failed|provider\s+authentication\s+failed|non-retryable\s+error"
    r"|rate\s+limited\s+after\s+\d+\s+retries|error\s+code\s*:|http\s*\d{3}\b"
    r"|incorrect\s+api\s+key|invalid\s+api\s+key)",
    re.IGNORECASE,
)


def run_result() -> dict | None:
    """The result of the run that just ended, from the gateway code that fired this hook (its
    `agent_result`, a few frames up: Hermes awaits its hooks in place). None if not found."""
    try:
        frame = sys._getframe(1)
        for _ in range(16):
            if frame is None:
                return None
            value = frame.f_locals.get("agent_result")
            if isinstance(value, dict):
                return value
            frame = frame.f_back
    except Exception:
        pass
    return None


def _start_pattern(template: str):
    """How a reply made from a catalog text starts: its first 40 fixed characters, a placeholder
    ({reason}, {model}…) matching anything. None if too little of it is fixed to tell."""
    pieces, fixed = [], 0
    for tok in re.split(r"(\{[^{}]*\})", template.strip()):
        if fixed >= 40:
            break
        if tok.startswith("{") and tok.endswith("}"):
            pieces.append(".*?")
        elif tok:
            take = tok[: 40 - fixed]
            pieces.append(re.escape(take))
            fixed += len(take)
    return re.compile("".join(pieces), re.S) if fixed >= 12 else None


@lru_cache(maxsize=1)
def failure_patterns() -> tuple:
    """How each Hermes failure reply starts, in every language Hermes has. Loading the catalogs
    takes seconds: never called on the gateway's event loop (warmed in a thread at load)."""
    texts = set()
    try:
        from agent.i18n import supported_languages, t
        from agent.turn_explainers import EMPTY_RESPONSE_EXPLANATION

        for lang in supported_languages():
            for key in FAILURE_KEYS:
                text = t(f"gateway.errors.{key}", lang=lang)
                if text and not text.startswith("gateway."):
                    texts.add(text)
            warn = t("gateway.shared.warn_passthrough", lang=lang)
            if "{error}" in warn:
                texts.add(warn.replace("{error}", EMPTY_RESPONSE_EXPLANATION))
    except Exception:
        pass
    if not texts:
        texts.update(FALLBACK_FAILURE_TEXTS)
    patterns = {_start_pattern(t) for t in texts}
    return tuple(p for p in patterns if p is not None)


def _warm() -> None:
    try:
        failure_patterns()
    except Exception:
        pass


# In this profile's context (its HERMES_HOME), off the event loop.
threading.Thread(target=contextvars.copy_context().run, args=(_warm,), daemon=True).start()


def looks_like_provider_error(text: str) -> bool:
    try:
        from gateway.run import _looks_like_gateway_provider_error

        return bool(_looks_like_gateway_provider_error(text))
    except Exception:
        return len(text) <= 400 and text.count("\n") <= 4 and bool(PROVIDER_ERROR.search(text))


def run_outcome(context: dict, result: dict | None) -> tuple:
    """("answered", None), or ("failed", why). Blocks while the catalogs load: not on the loop."""
    if isinstance(result, dict):
        if result.get("failed"):
            return "failed", str(result.get("failure_reason") or "failed")[:100]
        if result.get("interrupted"):
            return "failed", "interrupted"
    if context.get("failed") is True:  # in case Hermes ever says so itself
        return "failed", "failed"
    response = str(context.get("response") or "").strip()
    if not response:
        return "failed", "no response"
    if is_silence(response):
        return "failed", "stayed silent"
    if any(p.match(response) for p in failure_patterns()):
        return "failed", "error reply"
    # Without the run's result only: an answer may start like a provider error ("HTTP 503 means…").
    if result is None and (
        response.startswith(FAILURE_PREFIXES) or looks_like_provider_error(response)
    ):
        return "failed", "error reply"
    return "answered", None


# ---- reporting --------------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: it would carry the token to wherever it points."""

    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def post(cmd_id: str, what: str, body: dict) -> tuple:
    """POST /api/voice/commands/<id>/<what>: (done, detail, worth retrying)."""
    base = (os.environ.get("HEARLOOM_URL") or "http://127.0.0.1:3000").rstrip("/")
    token = secret("HEARLOOM_MCP_TOKEN")
    if not token:
        return False, "no HEARLOOM_MCP_TOKEN", False
    req = urllib.request.Request(
        f"{base}/api/voice/commands/{cmd_id}/{what}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with _opener.open(req, timeout=5) as res:
            raw = res.read()
            status = str(res.status)
    except urllib.error.HTTPError as e:
        e.close()
        return False, f"HTTP {e.code}", e.code >= 500 or e.code == 429
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as e:
        return False, f"error: {e!r}", True
    try:
        status = json.loads(raw or b"{}").get("status", status)
    except (ValueError, AttributeError):
        pass
    return True, status, False


async def report(cmd_id: str, what: str, body: dict) -> None:
    """Report to Hearloom, retrying while it can't take it (restarting, unreachable)."""
    detail = ""
    for delay in (*RETRY_DELAYS, None):
        done, detail, retry = await asyncio.to_thread(post, cmd_id, what, body)
        if done:
            logger.info("[hearloom-voice-reply] command %s %s %s: %s", cmd_id, what, body, detail)
            return
        if not retry or delay is None:
            break
        await asyncio.sleep(delay)
    logger.warning(
        "[hearloom-voice-reply] couldn't tell Hearloom that command %s %s (%s): %s",
        cmd_id,
        what,
        body.get("outcome", "-"),
        detail,
    )


# Reports in flight (a reference keeps each task alive until it's done).
_tasks: set = set()


def _spawn(coro) -> None:
    # In the background: Hermes waits for its hooks before it runs the agent or delivers the reply.
    task = asyncio.get_running_loop().create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def handle(event_type: str, context: dict):
    cmd_id = command_id(context)
    if not cmd_id:
        return
    if event_type == "agent:start":
        _spawn(report(cmd_id, "started", {}))
    elif event_type == "agent:end":
        # Before anything is awaited: the gateway's frames are still the ones that ran the hook.
        _spawn(_report_end(cmd_id, dict(context), run_result()))


async def _report_end(cmd_id: str, context: dict, result: dict | None) -> None:
    outcome, reason = await asyncio.to_thread(run_outcome, context, result)
    body = {"outcome": outcome, **({"reason": reason} if reason else {})}
    await report(cmd_id, "replied", body)
