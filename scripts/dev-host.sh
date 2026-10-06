#!/bin/sh
# `pnpm dev:host`: `pnpm dev`, plus on your tailnet over HTTPS the console at
# https://<machine>.<tailnet>.ts.net:5173 and the server at https://<machine>.<tailnet>.ts.net (PUBLIC_URL).
# It has to be HTTPS: with an https PUBLIC_URL the auth cookies are Secure, and browsers drop those over
# plain HTTP from anything but localhost, so sign-in would silently fail.
set -eu

if ! command -v tailscale >/dev/null 2>&1; then
  echo "dev:host needs the tailscale CLI (and HTTPS enabled for your tailnet)" >&2
  exit 1
fi

# Foreground serves: their config goes away when this script stops them. The server keeps answering plain
# HTTP on :3000 as well, which the phone can use instead.
tailscale serve --https=5173 http://127.0.0.1:5173 &
console=$!
tailscale serve --https=443 http://127.0.0.1:3000 &
server=$!
trap 'kill "$console" "$server" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM

# Setting the host (Vite binds 127.0.0.1 either way) turns on the TRUSTED_ORIGINS hint at startup.
HEARLOOM_WEB_HOST=127.0.0.1 pnpm dev
