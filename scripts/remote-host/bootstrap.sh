#!/usr/bin/env bash
# Klide remote host bootstrap — Ubuntu Server 24.04 LTS (x86_64 or arm64).
#
# Turns a fresh Ubuntu Server into a box Klide can run agents on: updated,
# key-only SSH, firewalled, never sleeps, with git, gh, Node, Claude Code and
# Tailscale installed. Logins are left to you (see the end).
#
# Run on the box, as your normal user (it calls sudo where needed):
#   scp scripts/remote-host/bootstrap.sh klide-box:~
#   ssh -t klide-box 'bash ~/bootstrap.sh'           # rented server
#   ssh -t klide-box 'bash ~/bootstrap.sh --home'    # PC on your home network
# Once Tailscale is up and you're connected through it:
#   ssh -t klide-box 'bash ~/bootstrap.sh --tailscale-only'
#
# Safe to re-run: each step checks before it changes anything.
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-24}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

MODE="cloud"
case "${1:-}" in
  "") ;;
  --home) MODE="home" ;;
  --tailscale-only) MODE="lock" ;;
  *) echo "Usage: bootstrap.sh [--home | --tailscale-only]" >&2; exit 2 ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user, not root (it uses sudo itself)." >&2
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "Written for Ubuntu Server; this is ${PRETTY_NAME:-an unknown system}." >&2
  exit 1
fi

# Passwords get switched off below, so key login must already work —
# otherwise this would lock you out of your own box.
if [ ! -s "$HOME/.ssh/authorized_keys" ]; then
  echo "No ~/.ssh/authorized_keys yet. From the Mac run:" >&2
  echo "  ssh-copy-id -i ~/.ssh/klide_box.pub klide-box" >&2
  echo "then run this script again." >&2
  exit 1
fi

# --tailscale-only: close SSH to the public internet. Refuses unless this very
# session came in over Tailscale, so it can't cut the line you're standing on.
if [ "$MODE" = "lock" ]; then
  say "Close public SSH: only Tailscale gets in"
  if ! have tailscale || ! tailscale status >/dev/null 2>&1; then
    echo "Tailscale isn't up on this box yet. Run: sudo tailscale up" >&2
    exit 1
  fi
  client_ip="${SSH_CLIENT%% *}"
  over_tailscale=no
  case "$client_ip" in
    fd7a:115c:a1e0:*) over_tailscale=yes ;;   # Tailscale IPv6 range
    100.*)                                     # Tailscale IPv4 is 100.64.0.0/10
      second="$(echo "$client_ip" | cut -d. -f2)"
      if [ "$second" -ge 64 ] && [ "$second" -le 127 ]; then over_tailscale=yes; fi ;;
  esac
  if [ "$over_tailscale" != yes ]; then
    echo "This session comes from '${client_ip:-the console}', not over Tailscale." >&2
    echo "Point ~/.ssh/config's HostName at the box's Tailscale name, reconnect, re-run." >&2
    exit 1
  fi
  sudo ufw allow in on tailscale0 >/dev/null
  sudo ufw delete allow OpenSSH >/dev/null 2>&1 || true
  sudo ufw status
  echo "Public SSH is closed. Reach the box through Tailscale only."
  exit 0
fi

say "System packages"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
sudo DEBIAN_FRONTEND=noninteractive apt-get -y install \
  git curl ca-certificates build-essential unzip jq tmux ufw unattended-upgrades
if [ "$MODE" = "home" ]; then
  # Makes the box reachable as <hostname>.local on your home network.
  sudo DEBIAN_FRONTEND=noninteractive apt-get -y install avahi-daemon
fi

say "SSH: keys only, no root"
# 10- sorts before Ubuntu's own drop-ins (e.g. 50-cloud-init.conf); sshd keeps
# the first value it reads, so these win.
sudo tee /etc/ssh/sshd_config.d/10-klide.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t
sudo systemctl reload ssh 2>/dev/null || sudo systemctl restart ssh

say "Firewall: only SSH comes in"
sudo ufw allow OpenSSH >/dev/null
sudo ufw --force enable >/dev/null
sudo ufw status | head -n 5

say "Never sleep (a sleeping box stops your runs)"
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
sudo mkdir -p /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/10-klide.conf >/dev/null <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
# Lets your own background services (later: Klide's helper) keep running
# when no SSH session is open.
sudo loginctl enable-linger "$USER"

say "GitHub CLI"
if ! have gh; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update
  sudo apt-get -y install gh
fi
gh --version | head -n 1

say "Node.js ${NODE_MAJOR} (for projects that build with npm)"
if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get -y install nodejs
fi
node --version

say "Claude Code"
if ! have claude && [ ! -x "$HOME/.local/bin/claude" ]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
"$HOME/.local/bin/claude" --version 2>/dev/null || claude --version

say "Tailscale (reach the box away from home)"
if ! have tailscale; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

mkdir -p "$HOME/code"

cat <<'EOF'

Done. Now the logins — each one is yours to do, interactively, on the box:

  1. sudo tailscale up            # open the printed link on your Mac, approve
  2. gh auth login                # GitHub.com → HTTPS → log in as pierreprudh
     gh auth setup-git            # git clone/push now use that login
  3. git config --global user.name  "Your Name"
     git config --global user.email "you@example.com"
  4. claude                       # log in with your subscription, then /exit
  5. sudo reboot                  # applies the no-sleep settings

Then follow scripts/remote-host/README.md from "Close public SSH".
EOF
