#!/usr/bin/env bash
# Cargo's runner: sign the freshly linked binary before macOS executes it.
set -euo pipefail
IDENTITY="${KLIDE_DEV_SIGNING_IDENTITY:?Missing Klide development signing identity}"
BIN="${1:?Missing executable}"
shift
/usr/bin/codesign --force --sign "$IDENTITY" --identifier com.pierre.klide --timestamp=none "$BIN"
/usr/bin/codesign --verify --strict "$BIN"
# Replace the runner so Cargo/Tauri retain their normal kill/restart behavior.
unset KLIDE_DEV_SIGNING_IDENTITY
exec "$BIN" "$@"
