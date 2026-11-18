# Runs in the remote user's interactive SSH terminal, never on the Mac.
set -eu
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
case "$(uname -s)" in
  Darwin)
    if ! git --version >/dev/null 2>&1; then
      echo 'Install Apple Command Line Tools on this Mac (xcode-select --install), then retry.'
      exit 1
    fi
    if ! command -v gh >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then brew install gh; fi
    ;;
  Linux)
    if ! command -v apt-get >/dev/null 2>&1; then
      echo 'Install git, curl, gh and the WebKitGTK 4.1 runtime with your package manager, then check again.'
      exit 1
    fi
    if test "$(id -u)" = 0; then elevate=''; else elevate=sudo; fi
    $elevate apt-get update
    $elevate apt-get install -y git curl gh libwebkit2gtk-4.1-0
    ;;
  *) echo 'Unsupported remote operating system'; exit 1 ;;
esac
if ! command -v claude >/dev/null 2>&1; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl --fail --silent --show-error --location https://claude.ai/install.sh -o "$installer"
  bash "$installer"
fi
printf '\nPrerequisites installed. Continue in Klide.\n'
