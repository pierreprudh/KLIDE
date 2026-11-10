//! Containment for a command a Run starts without anyone reading it first.
//!
//! The permission engine decides *whether* a command runs. Nothing so far
//! decided what a running command could reach: an auto-approved `sh -c` had
//! the whole home directory and the network, held back only by the model's
//! manners. This module is the other half — a macOS Seatbelt profile handed to
//! `/usr/bin/sandbox-exec`, the same kernel mechanism the App Sandbox uses.
//!
//! The profile is deliberately small and says three things:
//!
//! - **Reads are open.** A build reads compilers, SDKs and caches from all
//!   over the disk; listing them would be a moving target. Secrets are kept
//!   out of the environment by `command_env`, not by this profile.
//! - **Writes are closed, then opened by path.** Only the folders in
//!   [`Sandbox::writable`] (and the handful of `/dev` nodes every shell
//!   writes to) accept a write. Paths are canonicalised first: the kernel
//!   matches the real path, and `/tmp` is really `/private/tmp`.
//! - **The network is on or off.** Seatbelt cannot filter by hostname, so the
//!   per-host allowlist keeps governing `web_fetch` and connectors, and a
//!   shell command gets everything or loopback only. Loopback and local
//!   sockets stay open either way — a test suite that starts a server on
//!   `127.0.0.1` is not reaching the network. Name lookups are closed with
//!   it: a hostname is enough to carry a secret out.
//!
//! In a profile the last matching rule wins, which is why the denials come
//! before the exceptions.
//!
//! **Who gets one.** A command a person read and approved runs as it always
//! did — they saw it. A command that ran because the full-auto rung covered
//! it, or because a wildcard project rule matched, was read by nobody, and
//! that is the command [`covers`] contains. An exact approval, for this run
//! or the project, is still someone having seen that very command.
//!
//! **What it may write** ([`Sandbox::for_workspace`]): the project, the
//! repository's git directory when that sits outside it (a worktree's does),
//! temp folders, and the caches build tools keep in the home directory. Git
//! hooks and git config are closed again — a command that could plant a hook
//! would run unsandboxed the next time a person commits.
//!
//! **The network** is closed for a contained command unless the person
//! opened it in Settings. Loopback stays, so a local proxy is still a way
//! out — the wall is against a command reaching the internet by itself, not
//! against one this machine already forwards for.
//!
//! **The way out** is asked for by name: `run_command` with `unsandboxed:
//! true`, which is always put to the person.
//!
//! Pure on purpose: this file builds text and an argv, and `process.rs` is
//! the only place that starts anything.

// Only macOS has Seatbelt; elsewhere `wrap` answers `None` and the profile
// builder has no caller outside its tests.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};

/// Where macOS keeps the tool. An absolute path: the command's own PATH is
/// the login shell's and must not be able to substitute another binary.
#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// What a sandboxed command may touch.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Sandbox {
    /// Folders the command may write under. Relative paths are ignored — a
    /// rule that depends on the cwd is not a rule.
    pub writable: Vec<PathBuf>,
    /// Places inside a writable folder that stay closed all the same.
    pub protected: Vec<PathBuf>,
    /// Whether the command may reach beyond loopback.
    pub network: bool,
}

/// `/dev` nodes a shell writes to as a matter of course. Discarding output to
/// `/dev/null` is not a write anyone needs to approve.
const DEVICE_WRITES: &str = r##"  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/tty")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/dtracehelper")
  (regex #"^/dev/fd/[0-9]+$")
  (regex #"^/dev/ttys[0-9]+$")"##;

/// Everything but loopback and local sockets. Each exception names its
/// operation and its end of the connection: `(allow network* (local ip
/// "localhost:*"))` reads like a loopback rule and lets every outbound
/// connection through, because an unbound local address matches it. The name
/// service is closed by path — a lookup is a message to the outside too.
const NETWORK_OFF: &str = r#"(deny network*)
(allow network-bind (local ip "localhost:*") (local unix-socket))
(allow network-inbound (local ip "localhost:*") (local unix-socket))
(allow network-outbound (remote ip "localhost:*") (remote unix-socket))
(deny network-outbound (literal "/private/var/run/mDNSResponder"))
"#;

impl Sandbox {
    /// The Seatbelt profile for this policy.
    pub fn profile(&self) -> String {
        let mut out = String::from("(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n");
        out.push_str(DEVICE_WRITES);
        for path in self.real_writable() {
            out.push_str("\n  (subpath ");
            out.push_str(&quoted(&path));
            out.push(')');
        }
        out.push_str(")\n");
        let protected = real_paths(&self.protected);
        if !protected.is_empty() {
            out.push_str("(deny file-write*");
            for path in protected {
                out.push_str("\n  (subpath ");
                out.push_str(&quoted(&path));
                out.push(')');
            }
            out.push_str(")\n");
        }
        if !self.network {
            out.push_str(NETWORK_OFF);
        }
        out
    }

    fn real_writable(&self) -> Vec<PathBuf> {
        real_paths(&self.writable)
    }

    /// The policy for a command run in `root` with nobody reading it first.
    pub fn for_workspace(root: &Path) -> Sandbox {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Sandbox::for_workspace_in(root, home.as_deref(), &std::env::temp_dir())
    }

    /// [`Sandbox::for_workspace`] with the home and temp folders named, so a
    /// test can say what they are.
    pub fn for_workspace_in(root: &Path, home: Option<&Path>, temp: &Path) -> Sandbox {
        let mut writable = vec![root.to_path_buf(), temp.to_path_buf(), PathBuf::from("/tmp"), PathBuf::from("/var/tmp")];
        // macOS pairs the per-user temp folder `…/T` with a cache folder
        // `…/C`; compilers keep their module caches there.
        if temp.file_name().is_some_and(|name| name == "T") {
            if let Some(parent) = temp.parent() {
                writable.push(parent.join("C"));
            }
        }
        if let Some(home) = home {
            writable.extend(TOOL_CACHES.iter().map(|dir| home.join(dir)));
        }
        let mut protected = Vec::new();
        for git in git_dirs(root) {
            protected.push(git.join("hooks"));
            protected.push(git.join("config"));
            writable.push(git);
        }
        Sandbox { writable, protected, network: false }
    }

    /// The program and leading arguments that run `shell` inside this
    /// sandbox; the caller appends the shell's own arguments. `None` where
    /// there is no Seatbelt, so the caller starts the shell directly.
    #[cfg(target_os = "macos")]
    pub fn wrap(&self, shell: &str) -> Option<(String, Vec<String>)> {
        Some((SANDBOX_EXEC.to_string(), vec!["-p".to_string(), self.profile(), shell.to_string()]))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn wrap(&self, _shell: &str) -> Option<(String, Vec<String>)> {
        None
    }
}

/// Where build tools keep what they download and compile, under the home
/// directory. Short on purpose: each entry is a place a command may write
/// without asking. Grown from denials seen in real use, not from a guess at
/// every tool there is.
const TOOL_CACHES: &[&str] = &[".cargo", ".npm", ".cache", "Library/Caches"];

/// Paths as the kernel will see them: absolute, symlinks resolved, each one
/// once, in a stable order.
fn real_paths(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = paths
        .iter()
        .filter(|path| path.is_absolute())
        .map(|path| real_path(path))
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

/// The git directories a command in `root` writes to: the nearest `.git`
/// above it, and for a worktree — where `.git` is a file pointing elsewhere —
/// the repository's shared directory as well. Read from the files git itself
/// reads, so no process is started to find out.
fn git_dirs(root: &Path) -> Vec<PathBuf> {
    let Some(dot_git) = root.ancestors().map(|dir| dir.join(".git")).find(|path| path.exists()) else {
        return Vec::new();
    };
    if dot_git.is_dir() {
        return vec![dot_git];
    }
    let Some(git_dir) = std::fs::read_to_string(&dot_git)
        .ok()
        .and_then(|text| text.trim().strip_prefix("gitdir:").map(|path| path.trim().to_string()))
        .map(|path| absolute_from(dot_git.parent().unwrap_or(root), &path))
    else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    if let Ok(common) = std::fs::read_to_string(git_dir.join("commondir")) {
        dirs.push(absolute_from(&git_dir, common.trim()));
    }
    dirs.push(git_dir);
    dirs
}

fn absolute_from(base: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() { path.to_path_buf() } else { base.join(path) }
}

/// Whether a command that ran without a prompt is one nobody read. `exact`
/// says whether the project rule that matched names this very command.
pub fn covers(trusted: super::permission::Trusted, exact_rule: bool) -> bool {
    use super::permission::Trusted;
    match trusted {
        Trusted::FullAuto => true,
        Trusted::Project => !exact_rule,
        Trusted::Run => false,
    }
}

/// Whether the person has left containment on. Two switches, either one
/// turns it off: the one in Settings (kept in `~/.klide/sandbox.json`, a file
/// rather than a field on the run request, so the background host and every
/// child run read the same answer and no request can ask for less), and
/// `KLIDE_COMMAND_SANDBOX=0` in the app's environment for a session that
/// cannot reach Settings.
pub fn enabled() -> bool {
    if matches!(std::env::var("KLIDE_COMMAND_SANDBOX").as_deref(), Ok("0") | Ok("off") | Ok("false")) {
        return false;
    }
    // Tests decide for themselves; they never read the developer's setting.
    cfg!(test) || stored().commands
}

/// The stored choices. `network` is whether a contained command may reach
/// beyond loopback; it is absent from files written before it existed, and
/// absent means closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Stored {
    commands: bool,
    #[serde(default)]
    network: bool,
}

impl Default for Stored {
    fn default() -> Self {
        Stored { commands: true, network: false }
    }
}

fn settings_path() -> Option<PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide/sandbox.json"))
}

fn stored() -> Stored {
    settings_path().map(|path| stored_at(&path)).unwrap_or_default()
}

/// The stored choices. No file means contained with the network closed, and
/// so does a file that cannot be read: a damaged setting must not be the
/// thing that removes the wall.
fn stored_at(path: &Path) -> Stored {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
        .unwrap_or_default()
}

fn store_at(path: &Path, stored: Stored) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Create the Klide settings folder: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    crate::durable::write_atomic(path, &bytes)
}

/// What Settings shows: whether this platform can contain a command at all,
/// whether the person has it on, and whether contained commands keep the
/// network.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub network: bool,
}

pub fn status() -> Status {
    let stored = stored();
    Status { supported: cfg!(target_os = "macos"), enabled: stored.commands, network: stored.network }
}

/// Change either choice; the one left out keeps its value.
pub fn set(commands: Option<bool>, network: Option<bool>) -> Result<Status, String> {
    let path = settings_path().ok_or("Cannot locate the Klide settings directory.")?;
    let mut stored = stored_at(&path);
    if let Some(commands) = commands {
        stored.commands = commands;
    }
    if let Some(network) = network {
        stored.network = network;
    }
    store_at(&path, stored)?;
    Ok(status())
}

/// Whether a contained command keeps the network. Closed unless the person
/// opened it; tests always get the default.
fn network_open() -> bool {
    !cfg!(test) && stored().network
}

/// Whether commands are being contained here at all: a platform that has a
/// sandbox, and a person who left it on.
pub fn active() -> bool {
    cfg!(target_os = "macos") && enabled()
}

/// The sandbox for one command, or `None` when it runs as approved.
pub fn for_command(trusted: super::permission::Trusted, exact_rule: bool, root: &Path) -> Option<Sandbox> {
    (active() && covers(trusted, exact_rule)).then(|| Sandbox { network: network_open(), ..Sandbox::for_workspace(root) })
}

/// Whether a command that asked to leave the sandbox has to be put to the
/// person. It does whenever it would otherwise have run contained: the rung
/// and a wildcard rule let a command run, they do not let it out.
pub fn must_ask(unsandboxed: bool, trusted: super::permission::Trusted, exact_rule: bool) -> bool {
    unsandboxed && active() && covers(trusted, exact_rule)
}

/// What the approval card says about a command asking to leave the sandbox.
pub const ESCALATION_REASON: &str = " The agent asks to run this outside the sandbox, after a sandboxed attempt was refused: it could then write anywhere your account can and use the network. Full auto and wildcard rules don't cover this; it always asks.";

/// Added to the line that reports a contained background command started —
/// its refusals arrive later, in output nobody is waiting on.
pub const BACKGROUND_NOTE: &str = " It runs sandboxed: it can write only inside the project, temp folders and tool caches, and may have no network. If its output shows a refusal the task cannot do without, start it again with unsandboxed: true.";

/// What the model is told when a contained command hit the wall. Without it
/// "Operation not permitted" reads as a broken tool, and the next move is to
/// try the same thing a different way.
const WRITE_NOTE: &str = "\n\n[Klide] This command ran sandboxed because nobody approved it by hand: it can write only inside the project, temp folders and tool caches, and not to git hooks or git config. If the task needs the refused write, run the same command again with unsandboxed: true — the user will be asked to approve it. Do not look for another route to that path.";

const NETWORK_NOTE: &str = "\n\n[Klide] This command ran sandboxed because nobody approved it by hand, and sandboxed commands have no network beyond this machine. If the task needs the network, run the same command again with unsandboxed: true — the user will be asked to approve it. Do not look for another route out.";

/// The note for a failed contained command, when its output shows the
/// sandbox was the reason. A refused write and a refused connection both
/// print "Operation not permitted"; a closed name service prints whatever
/// the tool says when a host does not resolve.
pub fn denial_note(sandbox: &Sandbox, output: &str) -> Option<&'static str> {
    if !sandbox.network && looks_offline(output) {
        Some(NETWORK_NOTE)
    } else if output.contains("Operation not permitted") {
        Some(WRITE_NOTE)
    } else {
        None
    }
}

/// How tools report a host that would not resolve or a network that is not
/// there. Matched without case; a miss costs a note, never a wrong result.
const OFFLINE_SIGNS: &[&str] = &[
    "could not resolve host",
    "could not resolve hostname",
    "couldn't resolve host",
    "enotfound",
    "eai_again",
    "getaddrinfo",
    "name or service not known",
    "nodename nor servname",
    "temporary failure in name resolution",
    "failed to lookup address",
    "dns error",
    "network is unreachable",
];

fn looks_offline(output: &str) -> bool {
    let lower = output.to_lowercase();
    OFFLINE_SIGNS.iter().any(|sign| lower.contains(sign))
}

/// Whether this process may apply a Seatbelt profile at all. A test run that
/// is itself sandboxed cannot nest another one; those runs skip the
/// containment tests rather than fail on the host's own restriction.
#[cfg(all(test, target_os = "macos"))]
pub fn usable_here() -> bool {
    let usable = std::process::Command::new(SANDBOX_EXEC)
        .args(["-p", "(version 1)(allow default)", "/usr/bin/true"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    if !usable {
        eprintln!("skipped: this process cannot apply a Seatbelt profile");
    }
    usable
}

/// A path with its symlinks resolved. A folder that does not exist yet (a
/// build's output dir) resolves through its nearest existing parent, so the
/// rule still names the place the write will really land.
fn real_path(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => real_path(parent).join(name),
        _ => path.to_path_buf(),
    }
}

/// A path as a profile string literal. Backslash and quote are the only two
/// characters the literal gives meaning to; a path holding either must not be
/// able to end the string and write a rule of its own.
fn quoted(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        if ch == '\\' || ch == '"' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_closes_writes_before_it_opens_any() {
        let profile = Sandbox { writable: vec![PathBuf::from("/")], network: true, ..Default::default() }.profile();
        let deny = profile.find("(deny file-write*)").expect("writes are denied");
        let allow = profile.find("(allow file-write*").expect("then opened by path");
        assert!(deny < allow, "the last matching rule wins, so the denial comes first");
        assert!(profile.contains("(literal \"/dev/null\")"));
    }

    #[test]
    fn network_rules_appear_only_when_the_network_is_off() {
        let on = Sandbox { network: true, ..Default::default() }.profile();
        assert!(!on.contains("network"));
        let off = Sandbox::default().profile();
        let deny = off.find("(deny network*)").expect("the network is denied");
        let loopback = off.find("(allow network-outbound (remote ip \"localhost:*\")").expect("loopback stays open");
        assert!(deny < loopback);
        assert!(!off.contains("(allow network*"), "a wildcard allow matches every outbound connection");
        assert!(off.contains("(deny network-outbound (literal \"/private/var/run/mDNSResponder\"))"));
    }

    #[test]
    fn writable_paths_are_absolute_real_and_listed_once() {
        let dir = std::env::temp_dir().join(format!("klide-sandbox-paths-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.canonicalize().unwrap();
        let sandbox = Sandbox {
            writable: vec![dir.clone(), dir.join("."), PathBuf::from("relative/dir"), dir.join("not-built-yet")],
            network: true,
            ..Default::default()
        };
        assert_eq!(sandbox.real_writable(), vec![real.clone(), real.join("not-built-yet")]);
        let profile = sandbox.profile();
        assert_eq!(profile.matches("(subpath ").count(), 2);
        assert!(!profile.contains("relative/dir"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_cannot_write_a_rule_of_its_own() {
        let hostile = PathBuf::from("/tmp/a\") (subpath \"/");
        assert_eq!(quoted(&hostile), r#""/tmp/a\") (subpath \"/""#);
        let profile = Sandbox { writable: vec![hostile.clone()], network: true, ..Default::default() }.profile();
        let rule = format!("\n  (subpath {})", quoted(&real_path(&hostile)));
        assert!(profile.contains(&rule), "the path is one escaped literal: {profile}");
        assert_eq!(profile.matches("\n  (subpath ").count(), 1, "and no second rule starts a line");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-sandbox-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn the_stored_choices_default_to_contained_and_offline_and_survive_a_damaged_file() {
        let path = scratch("setting").join("nested/sandbox.json");
        assert_eq!(stored_at(&path), Stored { commands: true, network: false }, "no file");
        store_at(&path, Stored { commands: false, network: true }).unwrap();
        assert_eq!(stored_at(&path), Stored { commands: false, network: true });
        // A file from before the network choice existed.
        std::fs::write(&path, br#"{ "commands": true }"#).unwrap();
        assert_eq!(stored_at(&path), Stored { commands: true, network: false }, "absent means closed");
        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(stored_at(&path), Stored::default(), "a damaged setting must not remove the wall");
    }

    #[test]
    fn the_note_names_what_the_sandbox_refused() {
        let offline = Sandbox::default();
        let online = Sandbox { network: true, ..Default::default() };
        let dns = "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com";
        assert_eq!(denial_note(&offline, dns), Some(NETWORK_NOTE));
        assert_eq!(denial_note(&online, dns), None, "with the network open, a bad hostname is just a bad hostname");
        assert_eq!(denial_note(&offline, "npm error code ENOTFOUND"), Some(NETWORK_NOTE));
        assert_eq!(denial_note(&online, "sh: /etc/hosts: Operation not permitted"), Some(WRITE_NOTE));
        assert_eq!(denial_note(&offline, "1 test failed"), None, "an ordinary failure gets no note");
    }

    #[test]
    fn leaving_the_sandbox_asks_exactly_when_the_command_would_have_been_contained() {
        use super::super::permission::Trusted;
        if !active() {
            return;
        }
        assert!(must_ask(true, Trusted::FullAuto, false), "the rung lets a command run, not out");
        assert!(must_ask(true, Trusted::Project, false), "nor does a wildcard rule");
        assert!(!must_ask(true, Trusted::Project, true), "an exact rule already runs it uncontained");
        assert!(!must_ask(true, Trusted::Run, false), "so does an approval for this run");
        assert!(!must_ask(false, Trusted::FullAuto, false), "and nobody asked");
    }

    #[test]
    fn only_a_command_nobody_read_is_covered() {
        use super::super::permission::Trusted;
        assert!(covers(Trusted::FullAuto, false));
        assert!(covers(Trusted::FullAuto, true), "the rung, not the rule, let it run");
        assert!(covers(Trusted::Project, false), "a wildcard rule matched a command nobody saw");
        assert!(!covers(Trusted::Project, true), "an exact rule is this very command, approved");
        assert!(!covers(Trusted::Run, false));
    }

    #[test]
    fn a_plain_checkout_writes_to_the_project_temp_and_caches_only() {
        let base = scratch("plain");
        let (root, home, temp) = (base.join("project"), base.join("home"), base.join("tmp/T"));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let sandbox = Sandbox::for_workspace_in(&root, Some(&home), &temp);
        assert!(!sandbox.network, "closed until the policy opens it");
        for dir in [root.clone(), temp.clone(), base.join("tmp/C"), home.join(".cargo"), home.join("Library/Caches"), root.join(".git")] {
            assert!(sandbox.writable.contains(&dir), "{} should be writable", dir.display());
        }
        assert!(!sandbox.writable.contains(&home), "the home directory itself is not");
        assert_eq!(sandbox.protected, vec![root.join(".git/hooks"), root.join(".git/config")]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_worktree_reaches_the_repository_it_belongs_to() {
        let base = scratch("worktree");
        let (repo, tree) = (base.join("repo"), base.join("trees/feature"));
        let git_dir = repo.join(".git/worktrees/feature");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
        std::fs::write(git_dir.join("commondir"), "../..\n").unwrap();
        let sandbox = Sandbox::for_workspace_in(&tree, None, &base.join("tmp"));
        let real = real_paths(&sandbox.writable);
        assert!(real.contains(&repo.join(".git")), "a commit in a worktree writes the shared git directory");
        assert!(!real.contains(&repo), "but not the other checkout's files");
        assert!(real_paths(&sandbox.protected).contains(&repo.join(".git/hooks")));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_folder_inside_a_repository_reaches_the_git_directory_above_it() {
        let base = scratch("subfolder");
        let root = base.join("repo/packages/app");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(base.join("repo/.git")).unwrap();
        assert_eq!(git_dirs(&root), vec![base.join("repo/.git")]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn protected_places_are_denied_after_the_folders_are_opened() {
        let sandbox = Sandbox {
            writable: vec![PathBuf::from("/project")],
            protected: vec![PathBuf::from("/project/.git/hooks")],
            network: true,
        };
        let profile = sandbox.profile();
        let open = profile.find("(subpath \"/project\")").unwrap();
        let closed = profile.find("(deny file-write*\n  (subpath \"/project/.git/hooks\")").unwrap();
        assert!(open < closed, "the last matching rule wins");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wrapping_puts_the_shell_behind_sandbox_exec() {
        let sandbox = Sandbox::default();
        let (program, args) = sandbox.wrap("sh").unwrap();
        assert_eq!(program, "/usr/bin/sandbox-exec");
        assert_eq!(args, vec!["-p".to_string(), sandbox.profile(), "sh".to_string()]);
    }
}
