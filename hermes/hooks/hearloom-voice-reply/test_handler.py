"""python3 -m unittest discover -s hermes/hooks/hearloom-voice-reply (stdlib only).

With HERMES_AGENT_DIR set to a Hermes checkout (and its Python), the failure texts are also checked
against Hermes's own catalog in every language.
"""

import asyncio
import base64
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import handler

CMD = "01a1221c-d1b7-764f-badb-110f91f431a1"


def chat_id(profile, route, delivery_id):
    raw = json.dumps([profile, route, delivery_id], separators=(",", ":")).encode()
    return "webhook:v2:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def voice_ctx(**over):
    return {"platform": "webhook", "chat_id": chat_id("default", "hearloom-voice", CMD), **over}


class CommandId(unittest.TestCase):
    def test_voice_route(self):
        self.assertEqual(handler.command_id(voice_ctx()), CMD)

    def test_other_routes_platforms_and_ids(self):
        for ctx in [
            {"platform": "webhook", "chat_id": chat_id("default", "github", CMD)},
            {"platform": "telegram", "chat_id": chat_id("default", "hearloom-voice", CMD)},
            {"platform": "webhook", "chat_id": chat_id("default", "hearloom-voice", "not-an-id")},
            {"platform": "webhook", "chat_id": "webhook:v2:%%%"},
            {"platform": "webhook", "chat_id": "8861827098"},
        ]:
            self.assertIsNone(handler.command_id(ctx), ctx)


class Outcome(unittest.TestCase):
    def test_answers(self):
        self.assertEqual(
            handler.run_outcome({"response": "It'll be sunny tomorrow."}, None), ("answered", None)
        )
        # A run that did its job, as the gateway has it.
        ok = {"final_response": "Done.", "api_calls": 3, "completed": True}
        self.assertEqual(handler.run_outcome({"response": "Done."}, ok), ("answered", None))

    def test_failed_and_interrupted_runs(self):
        failed = {"failed": True, "failure_reason": "server_error"}
        self.assertEqual(
            handler.run_outcome({"response": "OpenRouter returned a server error"}, failed),
            ("failed", "server_error"),
        )
        stopped = {"interrupted": True, "api_calls": 2}
        self.assertEqual(handler.run_outcome({"response": "partial"}, stopped), ("failed", "interrupted"))

    def test_no_answer(self):
        self.assertEqual(handler.run_outcome({"response": "  "}, None), ("failed", "no response"))

    def test_error_texts_without_the_result(self):
        for text in [
            "⚠️ Something went wrong and I couldn't finish this reply. Use /retry to try again.",
            "⚠️ I had to stop before finishing: processing incomplete. Use /retry to try again.",
            "⚠️ The model didn't produce a reply this time, even after retries. Send `continue`.",
            "Operation interrupted: waiting for model response (12.0s elapsed).",
            "API call failed after 3 retries: HTTP 502",
        ]:
            self.assertEqual(handler.run_outcome({"response": text}, None)[0], "failed", text)
        # Quoting part of a word is not an error reply.
        self.assertEqual(
            handler.run_outcome({"response": "Something went well today."}, None)[0], "answered"
        )

    def test_the_result_is_read_from_the_calling_gateway_frame(self):
        def _hmwa_post_turn_hooks(agent_result):
            return handler.run_result()

        self.assertEqual(_hmwa_post_turn_hooks({"failed": True}), {"failed": True})
        self.assertIsNone(handler.run_result())


@unittest.skipUnless(os.environ.get("HERMES_AGENT_DIR"), "needs a Hermes checkout")
class HermesCatalog(unittest.TestCase):
    def test_failure_texts_in_every_language(self):
        sys.path.insert(0, os.environ["HERMES_AGENT_DIR"])
        handler.failure_texts.cache_clear()
        from agent.i18n import supported_languages, t

        langs = supported_languages()
        self.assertGreater(len(langs), 1)
        for lang in langs:
            for key in ("generic_failed", "no_response", "interrupted_before_start"):
                text = t(f"gateway.errors.{key}", lang=lang)
                self.assertEqual(handler.run_outcome({"response": text}, None)[0], "failed", (lang, key))


class Report(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.statuses = []
        calls, statuses = self.calls, self.statuses

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                calls.append((self.path, self.headers.get("Authorization"), body))
                code = statuses.pop(0) if statuses else 200
                payload = b'{"status":"buzzed"}' if code == 200 else b"{}"
                self.send_response(code)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        os.environ["HEARLOOM_URL"] = f"http://127.0.0.1:{self.server.server_port}"
        os.environ["HEARLOOM_MCP_TOKEN"] = "hl_test"
        self.delays = handler.RETRY_DELAYS
        handler.RETRY_DELAYS = (0.01, 0.01, 0.01)

    def tearDown(self):
        handler.RETRY_DELAYS = self.delays
        self.server.shutdown()
        self.server.server_close()

    def run_hook(self, event, ctx):
        async def run():
            await handler.handle(event, ctx)
            # It returns at once; the post runs in the background.
            await asyncio.gather(*handler._tasks)

        asyncio.run(run())

    def test_an_answer_is_reported_with_the_token(self):
        self.run_hook("agent:end", voice_ctx(response="It'll be sunny tomorrow."))
        self.assertEqual(
            self.calls,
            [(f"/api/voice/commands/{CMD}/replied", "Bearer hl_test", {"outcome": "answered"})],
        )

    def test_a_failed_run_is_reported_as_failed(self):
        def _hmwa_post_turn_hooks(hook_ctx, agent_result, response):
            self.run_hook("agent:end", {**hook_ctx, "response": response})

        _hmwa_post_turn_hooks(voice_ctx(), {"failed": True, "failure_reason": "timeout"}, "raw error")
        self.assertEqual(self.calls[0][2], {"outcome": "failed", "reason": "timeout"})
        self.calls.clear()
        self.run_hook("agent:end", voice_ctx(response=""))
        self.assertEqual(self.calls[0][2], {"outcome": "failed", "reason": "no response"})

    def test_the_start_of_the_run_is_reported(self):
        self.run_hook("agent:start", voice_ctx(message="what's the weather"))
        self.assertEqual(self.calls, [(f"/api/voice/commands/{CMD}/started", "Bearer hl_test", {})])

    def test_other_runs_report_nothing(self):
        self.run_hook("agent:end", {"platform": "telegram", "chat_id": "1", "response": "hi"})
        self.run_hook("agent:start", {"platform": "telegram", "chat_id": "1"})
        self.assertEqual(self.calls, [])

    def test_retries_while_hearloom_restarts(self):
        self.statuses.extend([503, 502])
        self.run_hook("agent:end", voice_ctx(response="Sure."))
        self.assertEqual(len(self.calls), 3)

    def test_gives_up_with_a_warning(self):
        self.statuses.extend([503] * 10)
        with self.assertLogs("hooks.hearloom-voice-reply", "WARNING") as logs:
            self.run_hook("agent:end", voice_ctx(response="Sure."))
        self.assertEqual(len(self.calls), 4)
        self.assertIn("HTTP 503", logs.output[0])

    def test_a_rejected_token_is_not_retried_and_warns(self):
        self.statuses.append(401)
        with self.assertLogs("hooks.hearloom-voice-reply", "WARNING") as logs:
            self.run_hook("agent:end", voice_ctx(response="Sure."))
        self.assertEqual(len(self.calls), 1)
        self.assertIn("HTTP 401", logs.output[0])

    def test_unreachable_is_retried(self):
        os.environ["HEARLOOM_URL"] = "http://127.0.0.1:9"
        with self.assertLogs("hooks.hearloom-voice-reply", "WARNING") as logs:
            self.run_hook("agent:start", voice_ctx())
        self.assertIn("error:", logs.output[0])

    def test_redirects_are_not_followed(self):
        class Redirect(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:9/elsewhere")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        server = HTTPServer(("127.0.0.1", 0), Redirect)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            os.environ["HEARLOOM_URL"] = f"http://127.0.0.1:{server.server_port}"
            self.assertEqual(handler.post(CMD, "replied", {}), (False, "HTTP 302", False))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
