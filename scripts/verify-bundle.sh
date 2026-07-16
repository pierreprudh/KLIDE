#!/usr/bin/env bash
# verify-bundle.sh — post-pack, pre-notarize smoke check for the macOS bundle.
#
# Local Studio shipped a *signed but broken* DMG because their packer logged
# "file source doesn't exist", exited 0, and signing happily proceeded
# (docs/competitors-local-studio.md). This script is Klide's guard against
# that class of failure: run it after `npm run tauri build` and before
# notarizing/distributing. It fails loudly unless the bundle actually boots.
#
# What it verifies:
#   1. structure  — Info.plist present, executable exists and is runnable
#   2. signature  — if the app is signed, the signature verifies strictly
#   3. ptyd argv  — the embedded delegate-session daemon entry point answers
#   4. boot       — KLIDE_SMOKE=1 launches the real binary (window stays
#                   hidden) and must print KLIDE_SMOKE_OK within the timeout,
#                   which the app emits only after the webview finishes
#                   loading the embedded frontend
#
# Usage: scripts/verify-bundle.sh [path/to/Klide.app]

set -euo pipefail

BOOT_TIMEOUT_S=30

fail() {
  echo "✗ $1" >&2
  exit 1
}
ok() {
  echo "✓ $1"
}

# --- locate the .app ---------------------------------------------------------
APP="${1:-}"
if [ -z "$APP" ]; then
  # tauri puts the bundle under target/release or target/<triple>/release
  for candidate in \
    src-tauri/target/release/bundle/macos/Klide.app \
    src-tauri/target/*/release/bundle/macos/Klide.app; do
    if [ -d "$candidate" ]; then
      APP="$candidate"
      break
    fi
  done
fi
[ -n "$APP" ] && [ -d "$APP" ] || fail "no Klide.app found — run 'npm run tauri build' first (or pass the .app path)"
echo "Bundle: $APP"

# --- 1. structure ------------------------------------------------------------
PLIST="$APP/Contents/Info.plist"
[ -f "$PLIST" ] || fail "missing Info.plist"
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST" 2>/dev/null) \
  || fail "Info.plist has no CFBundleExecutable"
BIN="$APP/Contents/MacOS/$EXECUTABLE"
[ -x "$BIN" ] || fail "executable missing or not runnable: $BIN"
ok "structure (executable: $EXECUTABLE)"

# --- 2. signature (only when really signed) -----------------------------------
# Every arm64 binary carries a linker-generated ad-hoc signature with no sealed
# resources; that is NOT a distribution signature and strict bundle verification
# would always fail on it. Only verify when a real identity signed the bundle.
# (Captured into a variable: `codesign | grep -q` trips pipefail via SIGPIPE.)
SIG_INFO=$(codesign -dv "$APP" 2>&1 || true)
if echo "$SIG_INFO" | grep -q "not signed"; then
  echo "· unsigned bundle — skipping signature checks"
elif echo "$SIG_INFO" | grep -q "^Signature=adhoc"; then
  echo "· ad-hoc (linker) signature only — skipping signature checks"
else
  codesign --verify --deep --strict "$APP" \
    || fail "codesign verification failed — the bundle is signed but broken"
  ok "signature verifies (--deep --strict)"
  if spctl --assess --type execute "$APP" >/dev/null 2>&1; then
    ok "Gatekeeper accepts the bundle (notarized)"
  else
    echo "· Gatekeeper does not accept it yet (expected before notarization)"
  fi
fi

# --- 3. ptyd entry point ------------------------------------------------------
# `klide ptyd` without --data-dir must print usage and exit 2. Proves the
# daemon argv path survived bundling (delegate sessions depend on it).
set +e
"$BIN" ptyd >/dev/null 2>&1
PTYD_EXIT=$?
set -e
[ "$PTYD_EXIT" -eq 2 ] || fail "'$EXECUTABLE ptyd' exited $PTYD_EXIT (expected usage exit 2)"
ok "ptyd entry point answers"

# --- 4. boot ------------------------------------------------------------------
BOOT_LOG=$(mktemp -t klide-smoke)
trap 'rm -f "$BOOT_LOG"' EXIT
KLIDE_SMOKE=1 "$BIN" >"$BOOT_LOG" 2>&1 &
BOOT_PID=$!

elapsed=0
while kill -0 "$BOOT_PID" 2>/dev/null; do
  if [ "$elapsed" -ge "$BOOT_TIMEOUT_S" ]; then
    kill "$BOOT_PID" 2>/dev/null || true
    echo "--- boot output (tail) ---" >&2
    tail -20 "$BOOT_LOG" >&2
    fail "boot timed out after ${BOOT_TIMEOUT_S}s without KLIDE_SMOKE_OK"
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

set +e
wait "$BOOT_PID"
BOOT_EXIT=$?
set -e
if [ "$BOOT_EXIT" -ne 0 ] || ! grep -q "KLIDE_SMOKE_OK" "$BOOT_LOG"; then
  echo "--- boot output (tail) ---" >&2
  tail -20 "$BOOT_LOG" >&2
  fail "boot check failed (exit $BOOT_EXIT) — the bundle does not start cleanly"
fi
ok "boots and loads the frontend (${elapsed}s)"

echo "PASS — bundle is safe to notarize/distribute"
