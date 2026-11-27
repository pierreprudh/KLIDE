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
//! subscription login. An explicitly selected OpenRouter API key can be
//! authorized over SSH; model requests then use the destination key file.
//!
//! Store shape (managed by Settings › Machines):
//! ```json
//! { "machines": [ { "id": "klide-box", "sshHost": "klide-box",
//!     "checkouts": { "/Users/me/src/app": "~/code/app" } } ] }
//! ```
//! A workspace with no `checkouts` entry maps to `~/code/<folder name>`.

use crate::delegate::shell_quote;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
#[cfg(test)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inference: Option<crate::machine_inference::RemoteInference>,
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

// Serialize read/modify/write operations so simultaneous Settings saves retain
// unrelated machines. A malformed store must never be replaced with an empty one.
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn read_store(path: &Path) -> Result<Store, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Could not read machines: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(format!("Could not read machines: {e}")),
    }
}

fn absolute_checkout(path: &str) -> bool {
    path.starts_with('/') || (path.as_bytes().get(1)==Some(&b':') && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && path.as_bytes().get(2).is_some_and(|b|matches!(b,b'/'|b'\\')))
}

/// The one SSH-host rule every ssh invocation shares: an alias or
/// user@hostname, never an option. Save-time validation alone is not enough
/// — the store file is plain JSON, and a host like `-oProxyCommand=…` would
/// otherwise become local command execution when probed or spawned.
pub(crate) fn validate_ssh_host(host: &str) -> Result<(), String> {
    if host.is_empty() || host.starts_with('-') || !host.chars().all(|c| c.is_ascii_alphanumeric() || "._-@:[]".contains(c)) {
        return Err("Enter an SSH alias or user@hostname (configure ports and keys in ~/.ssh/config)".into());
    }
    Ok(())

}

pub(crate) fn validate_machine(machine: &Machine) -> Result<(), String> {
    if machine.id.is_empty() || !machine.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Machine ID must contain only letters, numbers, hyphens or underscores".into());
    }
    validate_ssh_host(&machine.ssh_host)?;
    if let Some(inference) = &machine.inference { inference.validate()?; }
    for (root, path) in &machine.checkouts {
        if !absolute_checkout(root) || !(absolute_checkout(path) || path.starts_with("~/")) || path.contains(['\n', '\r', '\0']) {
            return Err("Checkout mappings need an absolute workspace path and an absolute or ~/ remote path".into());
        }
    }
    Ok(())
}

fn update_store(path: &Path, change: impl FnOnce(&mut Store) -> Result<(), String>) -> Result<Vec<Machine>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "Machine store lock unavailable")?;
    let mut store = read_store(path)?;
    change(&mut store)?;
    std::fs::create_dir_all(path.parent().ok_or("Missing machine store directory")?).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
    crate::durable::write_atomic(path, &bytes)?;
    Ok(store.machines)
}

#[tauri::command]
pub async fn machine_save(machine: Machine, creating: bool) -> Result<Vec<Machine>, String> {
    crate::blocking::run(move || {
        validate_machine(&machine)?;
        let path = store_path().ok_or("Home directory unavailable")?;
        update_store(&path, |store| {
            let existing = store.machines.iter().position(|m| m.id == machine.id);
            match (existing, creating) {
                (Some(_), true) => return Err("A machine with this ID already exists".into()),
                (Some(index), false) => store.machines[index] = machine,
                (None, true) => store.machines.push(machine),
                (None, false) => return Err("Machine was removed; reload Settings before saving".into()),
            }
            Ok(())
        })
    }).await
}

#[tauri::command]
pub async fn machine_remove(id: String) -> Result<Vec<Machine>, String> {
    crate::blocking::run(move || {
        let path = store_path().ok_or("Home directory unavailable")?;
        update_store(&path, |store| {
            store.machines.retain(|m| m.id != id);
            Ok(())
        })
    }).await
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
pub(crate) fn remote_path_word(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", shell_quote(rest)),
        None if path == "~" => "\"$HOME\"".to_string(),
        None => shell_quote(path),
    }
}

/// The SSH options every call shares. BatchMode: never stop at a password
/// prompt inside a PTY nobody is watching yet.
pub(crate) const SSH_OPTS: &[&str] = &[
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
    // `--` so even an unvalidated host can't be read as an ssh option.
    format!("ssh -t {} -- {} {}", SSH_OPTS.join(" "), shell_quote(&machine.ssh_host), shell_quote(&remote))
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
    pub setup: SetupFacts,
    pub target: Option<crate::remote_platform::HostTarget>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetupFacts {
    pub connection: String,
    pub host: String,
    pub claude: String,
    pub credential_mode: String,
    pub credentials: String,
    pub github: String,
    pub github_scope: String,
    pub project: String,
}

fn fact(label: &str, value: impl Into<String>, tone: &'static str, fix: Option<String>) -> Fact {
    Fact { label: label.into(), value: value.into(), tone, fix }
}

/// The probe one SSH round trip runs. Each line is `key=value`; nothing in it
/// prints a secret (`claude auth status` reports a method, not a token).
fn probe_script(checkout: Option<&str>) -> String {
    let mut s = String::from(r#"export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";
         echo host=$("$HOME/.klide/bin/klide" ptyd version 2>/dev/null);
         echo hostApi=$("$HOME/.klide/bin/klide" ptyd capabilities 2>/dev/null);
         echo openrouter=$("$HOME/.klide/bin/klide" ptyd openrouter-status 2>/dev/null);
         echo claude=$(claude --version 2>/dev/null | head -n1);
         echo login=$(claude auth status 2>/dev/null | tr -d ' \n' | grep -o '"loggedIn":[a-z]*' | cut -d: -f2);
         echo ghVersion=$(gh --version 2>/dev/null | head -n1);
         if gh_status=$(gh auth status 2>&1); then
           gh_account=$(printf '%s' "$gh_status" | grep -o 'account [^ ]*' | head -n1 | cut -d' ' -f2);
           echo gh=${gh_account:-authenticated};
         fi; "#);
    if let Some(path) = checkout {
        let word = remote_path_word(path);
        s.push_str(&format!(
            "if [ -e {word}/.git ] && git -C {word} rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo checkout=yes; \
             echo branch=$(git -C {word} branch --show-current); \
             echo dirty=$(git -C {word} status --porcelain | wc -l | tr -d ' '); \
             else echo checkout=no; fi; "
        ));
    }
    s
}

fn windows_probe(checkout: Option<&str>) -> String {
    use crate::remote_platform::{WINDOWS_PATH, ps_path};
    let mut script = format!("{WINDOWS_PATH} $ErrorActionPreference='Continue'; if (Test-Path -LiteralPath (Join-Path $HOME '.klide/bin/klide.exe')) {{ Write-Output ('host='+(& (Join-Path $HOME '.klide/bin/klide.exe') ptyd version)) }}; if (Get-Command claude -ErrorAction SilentlyContinue) {{ Write-Output ('claude='+(& claude --version | Select-Object -First 1)); try {{ $auth=(& claude auth status 2>$null | Out-String | ConvertFrom-Json); Write-Output ('login='+$auth.loggedIn.ToString().ToLowerInvariant()) }} catch {{}} }}; if (Get-Command gh -ErrorAction SilentlyContinue) {{ Write-Output ('ghVersion='+(& gh --version | Select-Object -First 1)); & gh auth status *> $null; if ($LASTEXITCODE -eq 0) {{ Write-Output 'gh=authenticated' }} }};");
    script.push_str("if (Test-Path -LiteralPath (Join-Path $HOME '.klide/bin/klide.exe')) { Write-Output ('hostApi='+(& (Join-Path $HOME '.klide/bin/klide.exe') ptyd capabilities 2>$null)); Write-Output ('openrouter='+(& (Join-Path $HOME '.klide/bin/klide.exe') ptyd openrouter-status 2>$null)) }; ");
    if let Some(checkout)=checkout {
        script.push_str(&format!("$p={}; if (Test-Path -LiteralPath (Join-Path $p '.git')) {{ & git -C $p rev-parse --is-inside-work-tree *> $null; if ($LASTEXITCODE -eq 0) {{ Write-Output 'checkout=yes'; Write-Output ('branch='+(& git -C $p branch --show-current)); Write-Output ('dirty='+(@(& git -C $p status --porcelain).Count)) }} else {{ Write-Output 'checkout=no' }} }} else {{ Write-Output 'checkout=no' }}",ps_path(checkout)));
    }
    script.push_str("; exit 0"); script
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

    let mut status = MachineStatus {
        id: machine.id.clone(),
        label: machine.label().to_string(),
        ssh_host: machine.ssh_host.clone(),
        ready: false,
        caption: String::new(),
        facts: Vec::new(),
        target: None,
        checkout: checkout.clone(),
        setup: SetupFacts { connection: "offline".into(), host: "unknown".into(), claude: "unknown".into(), credential_mode: if machine.inference.is_some() { "openrouter" } else { "subscription" }.into(), credentials: "unknown".into(), github: "unknown".into(), github_scope: "repository".into(), project: if checkout.is_some() { "unknown" } else { "notSelected" }.into() },
    };
    // Re-validate at the point of use: the store is plain JSON, and a host
    // starting with `-` would be read as an ssh option (e.g. ProxyCommand).
    if let Err(e) = validate_ssh_host(&machine.ssh_host) {
        status.caption = "Invalid SSH host".into();
        status.facts.push(fact("Reached", e, "bad", None));
        return status;
    }
    let target = crate::machine_install::detect_target(&machine.ssh_host);
    status.target = target.as_ref().ok().copied();
    let output = target.as_ref().map_err(Clone::clone).and_then(|target| {
        let mut body = if target.os == crate::remote_platform::HostOs::Windows {
            windows_probe(checkout.as_deref()).trim_end_matches("; exit 0").to_string()
        } else { probe_script(checkout.as_deref()) };
        if let Some(root) = workspace_root { body.push_str(&crate::machine_repository::access_probe(root, target.os)); }
        let script = if target.os == crate::remote_platform::HostOs::Windows { crate::remote_platform::powershell(&format!("{body}; exit 0")) } else { body };
        crate::machine_install::ssh(&machine.ssh_host, &script)
    });
    let elapsed = started.elapsed();
    let out = match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
        Err(err) => {
            let why = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no answer").trim().to_string();
            if err.starts_with("Unsupported remote") || err.starts_with("This remote architecture") {
                status.setup.connection="unsupported".into(); status.caption=err.clone();
                status.facts.push(fact("System",err,"bad",None)); return status;
            }
            status.setup.connection = if err.contains("Host key verification failed") || err.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") { "needsTrust" } else if err.contains("Permission denied") { "needsAuthentication" } else { "offline" }.into();
            status.caption = match status.setup.connection.as_str() { "needsTrust" => "Confirm SSH connection", "needsAuthentication" => "SSH sign-in needed", _ => "Offline" }.into();
            status.facts.push(fact("Reached", why, "bad", Some(format!("ssh {}", machine.ssh_host))));
            return status;
        }
    };
    let p = parse_probe(&out);
    status.setup.connection = "connected".into();
    let got = |k: &str| p.get(k).map(String::as_str).filter(|v| !v.is_empty());
    status.facts.push(fact("Reached", format!("in {} ms", elapsed_ms(elapsed)), "ok", None));

    let mut problems: Vec<&str> = Vec::new();
    status.setup.host = match got("host") { Some(version) if crate::pty_wire::remote_host_identity_compatible(version) && (machine.inference.is_none() || got("hostApi").is_some_and(|value| value.split_whitespace().any(|v| v == crate::machine_inference::CAPABILITY))) => "ready", Some(_) => "outdated", None => "missing" }.into();
    status.setup.claude = match (got("claude"), got("login")) { (Some(_), Some("true")) => "ready", (Some(_), _) => "needsLogin", _ => "missing" }.into();
    status.setup.credentials = if crate::machine_inference::credential_ready(machine.inference.as_ref(), got("claude").is_some(), got("login") == Some("true"), got("openrouter") == Some("ready")) {
        "ready"
    } else if machine.inference.is_some() { "needsAuthorization" } else { "needsLogin" }.into();
    status.setup.github = match (got("ghVersion"), got("gh")) { (_, Some(_)) => "ready", (Some(_), _) => "needsLogin", _ => "missing" }.into();
    if status.setup.github_scope == "repository" {
        status.setup.github = if got("repositoryAccess") == Some("ready") { "ready" } else { "needsLogin" }.into();
    }
    if checkout.is_some() { status.setup.project = if got("checkout") == Some("yes") { "ready" } else { "missing" }.into(); }
    match got("host") {
        Some(_version) if status.setup.host == "ready" => status.facts.push(fact("Run host", "Installed · compatible with this app", "ok", None)),
        Some(version) => {
            problems.push("Run host needs updating in Settings → Machines");
            status.facts.push(fact("Run host", format!("{version} · update required"), "warn", None));
        }
        None => {
            problems.push("Install Run host in Settings → Machines");
            status.facts.push(fact("Run host", "Not installed or prerequisites missing", "warn", None));
        }
    }
    if let Some(inference) = &machine.inference {
        if let Some(version) = got("claude") { status.facts.push(fact("Agent runtime", format!("{version} · installed"), "ok", None)); }
        else { problems.push("Claude Code runtime missing"); }
        if status.setup.credentials == "ready" {
            status.facts.push(fact("Model credentials", format!("OpenRouter · {} · key configured", inference.model), "ok", None));
        } else {
            problems.push("OpenRouter API key not authorized");
            status.facts.push(fact("Model credentials", "Authorize an OpenRouter key in Credentials", "warn", None));
        }
    } else {
    match (got("claude"), got("login")) {
        (None, _) => {
            problems.push("Claude Code missing");
            status.facts.push(fact("Claude Code", "not installed", "bad", None));
        }
        (Some(v), Some("true")) => status.facts.push(fact("Claude Code", format!("{v} · logged in"), "ok", None)),
        (Some(v), _) => {
            problems.push("Claude Code not logged in");
            status.facts.push(fact("Claude Code", format!("{v} · not logged in"), "warn", Some(format!("ssh -t {} claude", machine.ssh_host))));
        }
    }
    }
    if status.setup.github_scope == "repository" {
        status.facts.push(fact("GitHub", if got("repositoryAccess") == Some("ready") { "Repository-only key · access previously verified" } else { "Connect access for this repository only" }, "quiet", None));
        if got("gh").is_some() { status.facts.push(fact("Personal GitHub login", "An account is still signed in on this shared remote OS account. Disconnect it in repository access.", "warn", None)); }
    } else { match got("gh") {
        Some(account) => status.facts.push(fact("GitHub", format!("gh · {account}"), "ok", None)),
        None => status.facts.push(fact("GitHub", got("ghVersion").map(|version| format!("{version} · not signed in")).unwrap_or_else(|| "GitHub CLI not installed".into()), "quiet", Some(format!("ssh -t {} 'gh auth login && gh auth setup-git'", machine.ssh_host)))),
    } }
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
pub(crate) fn origin_repo(workspace_root: &str) -> Option<String> {
    let out = crate::git::cmd::git_in(workspace_root)
        .ok()?
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/* -------------------------------------------------------------- commands */

#[tauri::command]
pub async fn machines_list() -> Result<Vec<Machine>, String> {
    crate::blocking::run(|| {
        let path = store_path().ok_or("Home directory unavailable")?;
        Ok(read_store(&path)?.machines)
    }).await
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
    #[cfg(unix)]
    #[test]
    fn github_probe_distinguishes_installation_from_rejected_login() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("klide-gh-probe-{}", crate::agent::transcripts::run_id()));
        let bin = root.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let claude = bin.join("claude");
        std::fs::write(&claude, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o700)).unwrap();
        let gh = bin.join("gh");
        for (login, expected) in [("echo 'Failed to log into account expired-user'; exit 1", None), ("echo 'Logged in to github.com account valid-user'; exit 0", Some("valid-user"))] {
            std::fs::write(&gh, format!("#!/bin/sh\nif [ \"$1\" = '--version' ]; then echo 'gh version fixture'; exit 0; fi\n{login}\n")).unwrap();
            std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
            let result = std::process::Command::new("sh").args(["-c", &super::probe_script(None)]).env("HOME", &root).env("PATH", "/usr/bin:/bin").output().unwrap();
            assert!(result.status.success());
            let fields = super::parse_probe(&String::from_utf8_lossy(&result.stdout));
            assert_eq!(fields.get("ghVersion").map(String::as_str), Some("gh version fixture"));
            assert_eq!(fields.get("gh").map(String::as_str), expected);
        }
        assert!(super::windows_probe(None).contains("ghVersion="));
        std::fs::remove_dir_all(root).unwrap();
    }
    use super::*;

    fn box_machine() -> Machine {
        Machine {
            id: "klide-box".into(),
            label: None,
            ssh_host: "klide-box".into(),
            checkouts: BTreeMap::from([("/Users/me/src/app".into(), "/srv/app".into())]),
            inference: None,
        }
    }

    #[test]
    fn native_windows_checkout_paths_are_accepted_without_allowing_drive_relative_paths() {
        let mut machine=box_machine();
        for path in ["C:/Users/dev/project", "D:\\Projects\\user's app", "~/code/app"] {
            machine.checkouts.insert("/Users/local/app".into(),path.into());
            assert!(validate_machine(&machine).is_ok(),"{path}");
        }
        for path in ["C:relative", "relative/app", "C:/project\nexit"] {
            machine.checkouts.insert("/Users/local/app".into(),path.into());
            assert!(validate_machine(&machine).is_err(),"{path}");
        }
        let script=windows_probe(Some("C:/user's/$env:SECRET; app"));
        assert!(script.contains("'C:/user''s/$env:SECRET; app'"));
    }

    #[test]
    fn machine_settings_reject_ssh_options_and_invalid_checkout_paths() {
        let mut machine = box_machine();
        assert!(validate_machine(&machine).is_ok());
        for host in ["-oProxyCommand=evil", "my host", "host;exit", ""] {
            machine.ssh_host = host.into();
            assert!(validate_machine(&machine).is_err(), "{host}");
        }
        machine.ssh_host = "user@192.0.2.1".into();
        assert!(validate_machine(&machine).is_ok());
        machine.checkouts.insert("/Users/me/src/app".into(), "relative/path".into());
        assert!(validate_machine(&machine).is_err());
    }

    #[test]
    fn ssh_host_rule_is_shared_and_rejects_options() {
        assert!(validate_ssh_host("klide-box").is_ok());
        assert!(validate_ssh_host("user@192.0.2.1").is_ok());
        assert!(validate_ssh_host("[2001:db8::1]").is_ok());
        for host in ["-oProxyCommand=evil", "-o", ""] {
            assert!(validate_ssh_host(host).is_err(), "{host}");
        }
    }

    #[test]
    fn remote_spawn_command_separates_host_from_options() {
        let machine = box_machine();
        let cmd = remote_spawn_command(&machine, "/Users/me/src/app", "ses_1", "claude", &[]);
        assert!(cmd.contains(" -- 'klide-box' "), "{cmd}");
    }

    #[test]
    fn check_refuses_an_option_host_without_spawning_ssh() {
        let mut machine = box_machine();
        machine.ssh_host = "-oProxyCommand=evil".into();
        let status = check(&machine, None);
        assert!(!status.ready);
        assert!(status.facts.iter().any(|f| f.tone == "bad" && f.value.contains("SSH alias")));
    }

    #[test]
    fn settings_updates_preserve_other_machines_and_refuse_corrupt_stores() {
        let directory = std::env::temp_dir().join(format!("klide-machine-settings-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let path = directory.join("machines.json");
        let first = box_machine();
        update_store(&path, |store| { store.machines.push(first.clone()); Ok(()) }).unwrap();
        let mut second = first.clone();
        second.id = "second".into();
        update_store(&path, |store| { store.machines.push(second); Ok(()) }).unwrap();
        let stored = read_store(&path).unwrap();
        assert_eq!(stored.machines.len(), 2);
        assert_eq!(stored.machines[0], first);
        update_store(&path, |store| { store.machines.retain(|m| m.id != "second"); Ok(()) }).unwrap();
        assert_eq!(read_store(&path).unwrap().machines, vec![first]);
        std::fs::write(&path, b"invalid json").unwrap();
        assert!(update_store(&path, |_| Ok(())).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid json");
        std::fs::remove_dir_all(directory).unwrap();
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
            .arg(format!("set -- {}; shift 11; printf '%s' \"$1\"", cmd.trim_start_matches("ssh ")))
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
