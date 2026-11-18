#!/bin/sh
# The staged native helper validates this app revision and holds a portable
# kernel lease through idle admission, replacement and startup.
set -eu
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
stage=$1
expected=$2
trap 'rm -f "$stage"' EXIT
chmod 700 "$stage"
"$stage" ptyd install --expected "$expected" --destination "$HOME/.klide/bin/klide" --data-dir "$HOME/.klide/run-host"
