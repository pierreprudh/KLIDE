# Remote host setup

How to get a Linux server Klide can run agents on. This prepares the machine
only; Klide itself does not talk to it yet — that is the VPS execution slice
in `TODO.md`.

The server runs the agent, keeps its own logins, and stays on. Your Mac only
connects to it over SSH, through Tailscale (a private network between your
devices), so the server never exposes SSH to the internet.

Three files:

| File | What it does | Where it runs |
|---|---|---|
| `cloud-init.yaml` | Creates your user with your key at first boot | Pasted into the provider when you create the server |
| `bootstrap.sh` | Updates, locks down, installs git, `gh`, Node, Claude Code, Tailscale | Once on the server, over SSH |
| `bootstrap.sh --tailscale-only` | Closes public SSH once Tailscale works | Once, at the end |

The same steps rebuild the server from scratch at any time.

## 1. On the Mac, once

1. Make a key used only for this server:

   ```bash
   ssh-keygen -t ed25519 -C "mac → klide-box" -f ~/.ssh/klide_box
   ```

2. Install Tailscale on the Mac (<https://tailscale.com/download>) and sign in.
3. Fill your key into the first-boot file:

   ```bash
   cd ~/Documents/Private/KIDE
   sed "s|__SSH_PUBLIC_KEY__|$(cat ~/.ssh/klide_box.pub)|" \
     scripts/remote-host/cloud-init.yaml > ~/Desktop/klide-box-user-data.yaml
   ```

## 2. Create the server

Any provider that takes "cloud config" or "user data" works. Hetzner Cloud is
cheap and has EU data centers; DigitalOcean, OVH and Scaleway work the same way.

| Setting | Choose |
|---|---|
| Image | Ubuntu 24.04 |
| Size | 2 vCPU and 4 GB RAM or more (8 GB if it will build Rust projects) |
| Location | The one nearest you |
| SSH key | Add `~/.ssh/klide_box.pub` if the provider asks |
| Cloud config / user data | Paste the contents of `~/Desktop/klide-box-user-data.yaml` |
| Name | `klide-box` |

Note the server's public IP address.

## 3. Connect and bootstrap

Add this to `~/.ssh/config` on the Mac (create the file if needed):

```
Host klide-box
  HostName <the server's public IP>
  User pierre
  IdentityFile ~/.ssh/klide_box
  IdentitiesOnly yes
  ServerAliveInterval 30
```

Then:

```bash
cd ~/Documents/Private/KIDE
scp scripts/remote-host/bootstrap.sh klide-box:~
ssh -t klide-box 'bash ~/bootstrap.sh'
```

It ends by listing the logins left to do: Tailscale, `gh`, git identity,
Claude Code. Do them in an `ssh klide-box` session, then `sudo reboot`.

## 4. Close public SSH

1. In `~/.ssh/config`, change `HostName <public IP>` to `HostName klide-box`
   (its Tailscale name).
2. Check that `ssh klide-box` still gets in, now through Tailscale.
3. Close the public door:

   ```bash
   ssh -t klide-box 'bash ~/bootstrap.sh --tailscale-only'
   ```

   It refuses unless you are connected through Tailscale, so it can't lock you
   out. If you ever lose Tailscale, the provider's web console still reaches
   the server.

## 5. Check it works

```bash
ssh klide-box 'cd ~/code && gh repo clone pierreprudh/<some-repo> && ls'
ssh -t klide-box 'cd ~/code/<some-repo> && claude'
```

Then the survival test, which is the thing Klide will automate:

```bash
ssh -t klide-box 'tmux new -s test'      # inside: start claude, give it a task
# close the terminal window mid-task, wait a minute, then:
ssh -t klide-box 'tmux attach -t test'   # the work kept going
```

## A PC at home instead

Install Ubuntu Server 24.04 from a USB stick (server name `klide-box`, user
`pierre`, tick **Install OpenSSH server**), then from the Mac:

```bash
ssh-copy-id -i ~/.ssh/klide_box.pub pierre@<its IP>
scp scripts/remote-host/bootstrap.sh pierre@<its IP>:~
ssh -t pierre@<its IP> 'bash ~/bootstrap.sh --home'
```

`--home` adds `klide-box.local` naming on your network. Steps 4 and 5 are the same.
