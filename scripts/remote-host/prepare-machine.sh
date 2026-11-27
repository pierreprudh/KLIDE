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
    missing=''
    for tool in git curl gh; do
      if ! command -v "$tool" >/dev/null 2>&1; then missing="$missing $tool"; fi
    done
    if ! command -v dpkg-query >/dev/null 2>&1 ||
       test "$(dpkg-query -W -f='${db:Status-Status}' libwebkit2gtk-4.1-0 2>/dev/null)" != installed; then
      missing="$missing libwebkit2gtk-4.1-0"
    fi
    if test -n "$missing"; then
      if ! command -v apt-get >/dev/null 2>&1; then
        echo "Ask an administrator to install these packages with your package manager:$missing"
        exit 1
      fi
      if test "$(id -u)" = 0; then
        elevate=''
      elif command -v sudo >/dev/null 2>&1 && sudo -v; then
        elevate=sudo
      else
        echo "Ask an administrator to run: apt-get update && apt-get install -y$missing"
        echo 'Then continue setup with this worker account. It does not need permanent administrator access.'
        exit 1
      fi
      $elevate apt-get update
      # Each entry is a fixed package name selected above, never user input.
      $elevate apt-get install -y $missing
    fi
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
