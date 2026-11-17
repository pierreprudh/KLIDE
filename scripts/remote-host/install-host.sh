#!/bin/sh
# Invoked over SSH by Settings. Arguments are staged binary and the exact
# version/protocol/source signature expected by the Mac. No credentials move.
set -eu
export PATH="$HOME/.local/bin:$PATH"
stage=$1
expected=$2
trap 'rm -f "$stage"' EXIT
chmod 700 "$stage"
actual=$("$stage" ptyd version)
[ "$actual" = "$expected" ] || { echo 'The host binary does not match this app revision' >&2; exit 1; }
mkdir -p "$HOME/.klide/run-host"
exec 9>"$HOME/.klide/run-host/upgrade.lock"
flock -x 9
"$stage" ptyd prepare-upgrade --data-dir "$HOME/.klide/run-host"
mv -f "$stage" "$HOME/.klide/bin/klide"
trap - EXIT
# The shell retains the upgrade lock until startup finishes, but the detached
# daemon must not inherit descriptor 9 and hold the lock for its whole life.
"$HOME/.klide/bin/klide" ptyd ensure --data-dir "$HOME/.klide/run-host" 9>&-
