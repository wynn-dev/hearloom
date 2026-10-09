#!/usr/bin/env bash
# Compile the Foundation-only Swift sources for macOS and run the harness, then cross-check the
# batch encoding against the TypeScript decoder used by the server.
set -euo pipefail
cd "$(dirname "$0")"
BIN="$(mktemp -d)/omi-capture-tests"
swiftc -O -o "$BIN" ../ios/Log.swift ../ios/FrameJournal.swift ../ios/BatchCodec.swift ../ios/OfflineRecords.swift \
  ../ios/HapticSequencer.swift ../ios/UplinkPolicy.swift ../ios/ButtonFilter.swift main.swift
"$BIN" /tmp/hl-swift-batch.bin
bun verify-batch.ts /tmp/hl-swift-batch.bin
