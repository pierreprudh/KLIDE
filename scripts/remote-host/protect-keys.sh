# Runs in the remote user's interactive SSH terminal, never on the Mac.
# Lets Klide's Run host raise the secret wall (src-tauri/src/secret_wall.rs):
# each command it starts gets its own mount namespace in which ~/.klide is an
# empty folder. Ubuntu's AppArmor refuses that to unprivileged programs unless
# a profile names them, so this installs one profile for this one binary.
set -eu
b="$HOME/.klide/bin/klide"
if ! test -x "$b"; then echo 'Install the Klide helper first.'; exit 1; fi
if "$b" ptyd wall-check >/dev/null 2>&1; then printf '\nKeys are protected. Continue in Klide.\n'; exit 0; fi
if ! test -d /etc/apparmor.d || ! command -v apparmor_parser >/dev/null 2>&1; then
  echo 'This machine blocks user namespaces without AppArmor; ask an administrator to allow them for:'
  echo "  $b"
  exit 1
fi
if test "$(id -u)" = 0; then elevate=''
elif command -v sudo >/dev/null 2>&1 && sudo -v; then elevate=sudo
else echo 'Ask an administrator to run this step once.'; exit 1
fi
name="klide-host-$(id -un)"
profile=$(mktemp)
trap 'rm -f "$profile"' EXIT HUP INT TERM
# Unconfined apart from being allowed to create a user namespace — the same
# shape Ubuntu ships for browsers that sandbox themselves.
cat > "$profile" <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile $name "$b" flags=(unconfined) {
  userns,
  include if exists <local/$name>
}
PROFILE
$elevate install -m 0644 "$profile" "/etc/apparmor.d/$name"
$elevate apparmor_parser -r "/etc/apparmor.d/$name"
if "$b" ptyd wall-check; then printf '\nKeys are protected. Continue in Klide.\n'; else echo 'The wall still cannot be raised on this machine.'; exit 1; fi
