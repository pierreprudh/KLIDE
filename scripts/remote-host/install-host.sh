#!/bin/sh
# The staged native helper validates this app revision and holds a portable
# kernel lease through idle admission, replacement and startup.
set -eu
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
stage=$1
expected=$2
destination=${3:-"$HOME/.klide/bin/klide"}
data=${4:-"$HOME/.klide/run-host"}
mkdir -p "$(dirname "$destination")"
trap 'rm -f "$stage"' EXIT
chmod 700 "$stage"
"$stage" ptyd install --expected "$expected" --destination "$destination" --data-dir "$data"
