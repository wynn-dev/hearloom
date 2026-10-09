"""python3 -m unittest discover -s hermes/hooks/hearloom-voice-reply (stdlib only)."""

import asyncio
import base64
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import handler

CMD = "01a1221c-d1b7-764f-badb-110f91f431a1"


def chat_id(profile, route, delivery_id):
    raw = json.dumps([profile, route, delivery_id], separators=(",", ":")).encode()
    return "webhook:v2:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


class CommandId(unittest.TestCase):
    def test_voice_route(self):
        ctx = {"platform": "webhook", "chat_id": chat_id("default", "hearloom-voice", CMD)}
        self.assertEqual(handler.command_id(ctx), CMD)

    def test_other_routes_platforms_and_ids(self):
        for ctx in [
            {"platform": "webhook", "chat_id": chat_id("default", "github", CMD)},
            {"platform": "telegram", "chat_id": chat_id("default", "hearloom-voice", CMD)},
            {"platform": "webhook", "chat_id": chat_id("default", "hearloom-voice", "not-an-id")},
            {"platform": "webhook", "chat_id": "webhook:v2:%%%"},
            {"platform": "webhook", "chat_id": "8861827098"},
        ]:
            self.assertIsNone(handler.command_id(ctx), ctx)


class Handle(unittest.TestCase):
    def setUp(self):
        self.calls = []
        calls = self.calls

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append((self.path, self.headers.get("Authorization")))
                body = b'{"status":"buzzed"}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        os.environ["HEARLOOM_URL"] = f"http://127.0.0.1:{self.server.server_port}"
        os.environ["HEARLOOM_MCP_TOKEN"] = "hl_test"

    def tearDown(self):
        self.server.shutdown()

    def run_hook(self, response):
        ctx = {"platform": "webhook", "chat_id": chat_id("default", "hearloom-voice", CMD), "response": response}
        asyncio.run(handler.handle("agent:end", ctx))

    def test_reply_posts_with_the_token(self):
        self.run_hook("It'll be sunny tomorrow.")
        self.assertEqual(self.calls, [(f"/api/voice/commands/{CMD}/replied", "Bearer hl_test")])

    def test_no_response_posts_nothing(self):
        self.run_hook("")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
