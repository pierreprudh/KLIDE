//! Remote machines — where a Conversation can run besides this Mac.
//!
//! First slice (docs/REMOTE_MACHINES.md, "the picker on tmux"): a Remote
//! machine is an SSH host named in `~/.klide/machines.json`. A Claude Code
//! conversation placed on it runs the CLI on that machine inside a tmux
//! session named after the conversation, so it keeps working when this Mac
//! sleeps or Klide quits; reopening the conversation runs the same command
//! again and `tmux new -A` attaches to the session still there.
//!
//! What this module owns: the store, the Remote checkout a workspace maps to,
//! the exact command a spawn runs, and the readiness check. It never copies a
//! login or a key to the machine — Machine logins stay on the machine.
//!
//! Store shape (hand-written for now; Settings › Machines reads it):
//! ```json
//! { "machines": [ { "id": "klide-box", "sshHost": "klide-box",
//!     "checkouts": { "/Users/me/src/app": "~/code/app" } } ] }
//! ```
//! A workspace with no `checkouts` entry maps to `~/code/<folder name>`.

use crate::delegate::shell_quote;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// The only Delegate the first slice runs remotely.
pub const REMOTE_PROVIDER: &str = "claude-code";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    /// What the picker shows; the id when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// A host `ssh` resolves — usually an alias from `~/.ssh/config`.
    pub ssh_host: String,
    /// Local workspace root → Remote checkout path (`~/` allowed).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub checkouts: BTreeMap<String, String>,
}

impl Machine {
    pub fn label(&self) -> &str {
        self.label.as_deref().filter(|l| !l.trim().is_empty()).unwrap_or(&self.id)
    }

    /// The Remote checkout for a local workspace root: the mapped path, else
    /// `~/code/<folder name>` — the folder `bootstrap.sh` makes for clones.
    pub fn remote_checkout(&self, workspace_root: &str) -> String {
        let key = workspace_root.trim_end_matches('/');
        if let Some(path) = self.checkouts.get(key).or_else(|| self.checkouts.get(workspace_root)) {
            return path.clone();
        }
        let name = Path::new(key).file_name().and_then(|n| n.to_str()).unwrap_or("project");
        format!("~/code/{name}")
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    #[serde(default)]
    machines: Vec<Machine>,
}

fn store_path() -> Option<PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide").join("machines.json"))
}

pub fn list() -> Vec<Machine> {
    let Some(path) = store_path() else { return Vec::new() };
    let Ok(bytes) = std::fs::read(&path) else { return Vec::new() };
    serde_json::from_slice::<Store>(&bytes).map(|s| s.machines).unwrap_or_default()
}

pub fn get(id: &str) -> Option<Machine> {
    list().into_iter().find(|m| m.id == id)
}

/// A tmux session name for a PTY session id (`{convoId}:{provider}`). tmux
/// refuses `:` and `.` in names, so everything outside `[A-Za-z0-9_-]` becomes `-`.
pub fn tmux_session_name(session_id: &str) -> String {
    let convo = session_id.split(':').next().unwrap_or(session_id);
    let clean: String = convo
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("klide-{clean}")
}

/// A remote path as a shell word: `~/x` becomes `"$HOME"/'x'` so the remote
/// shell expands the home folder and nothing else.
fn remote_path_word(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", shell_quote(rest)),
        None if path == "~" => "\"$HOME\"".to_string(),
        None => shell_quote(path),
    }
}

/// The SSH options every call shares. BatchMode: never stop at a password
/// prompt inside a PTY nobody is watching yet.
const SSH_OPTS: &[&str] = &[
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
];

/// The command a Delegate PTY runs to put `inner` on `machine`: SSH in, then
/// attach to the conversation's tmux session in the Remote checkout, or start
/// it running `inner`. `env` rides inline on the remote side — the local PTY's
/// environment does not cross SSH.
pub fn remote_spawn_command(
    machine: &Machine,
    workspace_root: &str,
    session_id: &str,
    inner: &str,
    env: &[(String, String)],
) -> String {
    let checkout = machine.remote_checkout(workspace_root);
    let mut program = String::new();
    if !env.is_empty() {
        program.push_str("env");
        for (k, v) in env {
            program.push(' ');
            program.push_str(&shell_quote(&format!("{k}={v}")));
        }
        program.push(' ');
    }
    program.push_str(inner);
    let remote = format!(
        "tmux new-session -A -s {} -c {} {}",
        shell_quote(&tmux_session_name(session_id)),
        remote_path_word(&checkout),
        shell_quote(&program),
    );
    format!("ssh -t {} {} {}", SSH_OPTS.join(" "), shell_quote(&machine.ssh_host), shell_quote(&remote))
}

/* ------------------------------------------------------------- readiness */

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub label: String,
    pub value: String,
    /// "ok" | "warn" | "bad" | "quiet"
    pub tone: &'static str,
    /// A command that fixes this fact, to show and copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MachineStatus {
    pub id: String,
    pub label: String,
    pub ssh_host: String,
    /// Ready to start a Conversation in this workspace.
    pub ready: bool,
    /// One line for the picker: why it can't start, or what it offers.
    pub caption: String,
    pub facts: Vec<Fact>,
    /// The Remote checkout this workspace maps to.
    pub checkout: Option<String>,
}

fn fact(label: &str, value: impl Into<String>, tone: &'static str, fix: Option<String>) -> Fact {
    Fact { label: label.into(), value: value.into(), tone, fix }
}

/// The probe one SSH round trip runs. Each line is `key=value`; nothing in it
/// prints a secret (`claude auth status` reports a method, not a token).
fn probe_script(checkout: Option<&str>) -> String {
    let mut s = String::from(
        "export PATH=\"$HOME/.local/bin:$PATH\"; \
         echo tmux=$(tmux -V 2>/dev/null); \
         echo claude=$(claude --version 2>/dev/null | head -n1); \
         echo login=$(claude auth status 2>/dev/null | tr -d ' \\n' | grep -o '\"loggedIn\":[a-z]*' | cut -d: -f2); \
         echo gh=$(gh auth status 2>&1 | grep -o 'account [^ ]*' | head -n1 | cut -d' ' -f2); ",
    );
    if let Some(path) = checkout {
        let word = remote_path_word(path);
        s.push_str(&format!(
            "if [ -d {word}/.git ]; then echo checkout=yes; \
             echo branch=$(git -C {word} branch --show-current); \
             echo dirty=$(git -C {word} status --porcelain | wc -l | tr -d ' '); \
             else echo checkout=no; fi; "
        ));
    }
    s
}

fn parse_probe(out: &str) -> BTreeMap<String, String> {
    out.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

/// Read the machine's facts as they stand. `workspace_root` picks the Remote
/// checkout to look at; without one, only the machine itself is checked.
pub fn check(machine: &Machine, workspace_root: Option<&str>) -> MachineStatus {
    let checkout = workspace_root.map(|root| machine.remote_checkout(root));
    let started = Instant::now();
    let output = Command::new("ssh")
        .args(SSH_OPTS)
        .arg("-o")
        .arg("ConnectTimeout=6")
        .arg(&machine.ssh_host)
        .arg(probe_script(checkout.as_deref()))
        .stdin(std::process::Stdio::null())
        .output();
    let elapsed = started.elapsed();
    let mut status = MachineStatus {
        id: machine.id.clone(),
        label: machine.label().to_string(),
        ssh_host: machine.ssh_host.clone(),
        ready: false,
        caption: String::new(),
        facts: Vec::new(),
        checkout: checkout.clone(),
    };
    let out = match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            let why = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no answer").trim().to_string();
            status.caption = "Not reached — is Tailscale on?".into();
            status.facts.push(fact("Reached", why, "bad", Some(format!("ssh {}", machine.ssh_host))));
            return status;
        }
        Err(e) => {
            status.caption = "ssh could not start".into();
            status.facts.push(fact("Reached", e.to_string(), "bad", None));
            return status;
        }
    };
    let p = parse_probe(&out);
    let got = |k: &str| p.get(k).map(String::as_str).filter(|v| !v.is_empty());
    status.facts.push(fact("Reached", format!("in {} ms", elapsed_ms(elapsed)), "ok", None));

    let mut problems: Vec<&str> = Vec::new();
    match got("tmux") {
        Some(v) => status.facts.push(fact("tmux", v, "ok", None)),
        None => {
            problems.push("tmux missing");
            status.facts.push(fact("tmux", "not installed", "bad", Some(format!("ssh -t {} 'sudo apt-get install -y tmux'", machine.ssh_host))));
        }
    }
    match (got("claude"), got("login")) {
        (None, _) => {
            problems.push("Claude Code missing");
            status.facts.push(fact("Claude Code", "not installed", "bad", Some(format!("ssh -t {} 'curl -fsSL https://claude.ai/install.sh | bash'", machine.ssh_host))));
        }
        (Some(v), Some("true")) => status.facts.push(fact("Claude Code", format!("{v} · logged in"), "ok", None)),
        (Some(v), _) => {
            problems.push("Claude Code not logged in");
            status.facts.push(fact("Claude Code", format!("{v} · not logged in"), "warn", Some(format!("ssh -t {} claude", machine.ssh_host))));
        }
    }
    match got("gh") {
        Some(account) => status.facts.push(fact("GitHub", format!("gh · {account}"), "ok", None)),
        None => status.facts.push(fact("GitHub", "gh not logged in", "quiet", Some(format!("ssh -t {} 'gh auth login && gh auth setup-git'", machine.ssh_host)))),
    }
    if let Some(path) = checkout.as_deref() {
        if got("checkout") == Some("yes") {
            let branch = got("branch").unwrap_or("detached");
            let dirty: usize = got("dirty").and_then(|d| d.parse().ok()).unwrap_or(0);
            let state = if dirty == 0 { "clean".to_string() } else { format!("{dirty} changed") };
            status.facts.push(fact("Checkout", format!("{path} · {branch} · {state}"), "ok", None));
        } else {
            problems.push("no checkout of this project");
            let repo = workspace_root.and_then(origin_repo);
            let fix = repo.map(|r| format!("ssh {} 'git clone {r} {path}'", machine.ssh_host));
            status.facts.push(fact("Checkout", format!("{path} not found"), "warn", fix));
        }
    }
    status.ready = problems.is_empty();
    status.caption = if status.ready {
        "Keeps going when this Mac sleeps".into()
    } else {
        capitalize(&problems.join(" · "))
    };
    status
}

fn elapsed_ms(d: Duration) -> u128 {
    d.as_millis()
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// The workspace's `origin` URL, so a missing Remote checkout can say how to
/// clone it.
fn origin_repo(workspace_root: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", workspace_root, "remote", "get-url", "origin"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/* -------------------------------------------------------------- commands */

#[tauri::command]
pub async fn machines_list() -> Vec<Machine> {
    crate::blocking::run_infallible(list).await
}

/// Readiness of one machine for one workspace — an SSH round trip, so the
/// picker asks when it opens, never on every render.
#[tauri::command]
pub async fn machine_check(id: String, workspace_root: Option<String>) -> Result<MachineStatus, String> {
    crate::blocking::run(move || {
        let machine = get(&id).ok_or_else(|| format!("No machine named {id} in ~/.klide/machines.json"))?;
        Ok(check(&machine, workspace_root.as_deref()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_machine() -> Machine {
        Machine {
            id: "klide-box".into(),
            label: None,
            ssh_host: "klide-box".into(),
            checkouts: BTreeMap::from([("/Users/me/src/app".into(), "/srv/app".into())]),
        }
    }

    #[test]
    fn a_workspace_maps_to_its_checkout_or_to_code_by_folder_name() {
        let m = box_machine();
        assert_eq!(m.remote_checkout("/Users/me/src/app"), "/srv/app");
        assert_eq!(m.remote_checkout("/Users/me/src/app/"), "/srv/app");
        assert_eq!(m.remote_checkout("/Users/me/src/pixel-art-editor"), "~/code/pixel-art-editor");
    }

    #[test]
    fn tmux_names_drop_the_provider_and_anything_tmux_refuses() {
        assert_eq!(tmux_session_name("convo-1a2b:claude-code"), "klide-convo-1a2b");
        assert_eq!(tmux_session_name("a.b c"), "klide-a-b-c");
    }

    /// The quoting survives two shells: run the command's remote half through
    /// `sh` the way sshd would, with `tmux` stubbed to print its argv.
    #[cfg(unix)]
    #[test]
    fn a_task_with_quotes_reaches_the_cli_as_one_argument() {
        let inner = format!("claude {}", shell_quote("it's \"done\"; rm -rf nope"));
        let cmd = remote_spawn_command(&box_machine(), "/Users/me/src/app", "c1:claude-code", &inner, &[("A".into(), "b c".into())]);
        // Strip `ssh … 'host' ` locally exactly as the local shell would: ask sh.
        let words = Command::new("sh")
            .arg("-c")
            .arg(format!("set -- {}; shift 10; printf '%s' \"$1\"", cmd.trim_start_matches("ssh ")))
            .output()
            .unwrap();
        let remote = String::from_utf8(words.stdout).unwrap();
        let argv = Command::new("sh")
            .arg("-c")
            .arg(format!("tmux() {{ for a; do printf '[%s]' \"$a\"; done; }}; {remote}"))
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(argv.stdout).unwrap(),
            "[new-session][-A][-s][klide-c1][-c][/srv/app][env 'A=b c' claude 'it'\\''s \"done\"; rm -rf nope']"
        );
    }

    /// Live: `KLIDE_LIVE_MACHINE=klide-box cargo test --lib live_machine -- --ignored --nocapture`.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn live_machine_check_and_tmux_round_trip() {
        let Ok(id) = std::env::var("KLIDE_LIVE_MACHINE") else { return };
        let root = std::env::var("KLIDE_LIVE_WORKSPACE").unwrap_or_else(|_| "/tmp/pixel-art-editor".into());
        let machine = get(&id).expect("machine in ~/.klide/machines.json");
        let status = check(&machine, Some(&root));
        println!("{status:#?}");
        // The spawn command, through a real PTY (`script`), with a short-lived program.
        let cmd = remote_spawn_command(&machine, &root, "livetest:claude-code", "echo REMOTE_OK $(pwd); sleep 1", &[]);
        let out = Command::new("script").args(["-q", "/dev/null", "sh", "-c", &cmd]).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        println!("{text}");
        assert!(text.contains("REMOTE_OK"), "{text}");
    }

    #[test]
    fn probe_lines_parse_to_keys() {
        let p = parse_probe("tmux=tmux 3.6\nclaude=2.1.319 (Claude Code)\nlogin=true\ngh=\n");
        assert_eq!(p.get("login").map(String::as_str), Some("true"));
        assert_eq!(p.get("gh").map(String::as_str), Some(""));
    }
}
