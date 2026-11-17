# Runs in the remote user's interactive SSH terminal, never on the Mac.
test "$(uname -sm)" = 'Linux x86_64' || { echo 'Klide currently requires x86_64 Linux.'; exit 1; }
if ! command -v apt-get >/dev/null 2>&1; then
  echo 'Automatic prerequisites currently support Ubuntu/Debian. Install git, curl, gh, libwebkit2gtk-4.1-0 and libgtk-3-0 with your package manager, then check again.'
  exit 1
fi
if test "$(id -u)" = 0; then elevate=''; else elevate=sudo; fi
$elevate apt-get update
$elevate apt-get install -y git curl gh libwebkit2gtk-4.1-0
if ! command -v claude >/dev/null 2>&1; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl --fail --silent --show-error --location https://claude.ai/install.sh -o "$installer"
  bash "$installer"
fi
printf '\nPrerequisites installed. Continue in Klide.\n'
