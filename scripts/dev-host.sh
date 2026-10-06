#!/bin/sh
# `pnpm dev:host`: `pnpm dev`, plus the console on your tailnet at https://<machine>.<tailnet>.ts.net:5173.
# It has to be HTTPS: with an https PUBLIC_URL the auth cookies are Secure, and browsers drop those over
# plain HTTP from anything but localhost, so sign-in would silently fail.
set -eu

if ! command -v tailscale >/dev/null 2>&1; then
  echo "dev:host needs the tailscale CLI (and HTTPS enabled for your tailnet)" >&2
  exit 1
fi

# Foreground serve: its config goes away when this script stops it.
tailscale serve --https=5173 http://127.0.0.1:5173 &
serve=$!
trap 'kill "$serve" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM

# Setting the host (Vite binds 127.0.0.1 either way) turns on the TRUSTED_ORIGINS hint at startup.
HEARLOOM_WEB_HOST=127.0.0.1 pnpm dev
