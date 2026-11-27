//! The one way Klide starts `git`.
//!
//! Klide runs git in whatever folder is open, often without anyone asking
//! for it: a status poll, a dirty-set check around a command, a worktree
//! commit. A repository's own `.git/config` is read on every one of those,
//! and some of its settings name a program git then starts by itself. So
//! every invocation is built here, with the settings below fixed on the
//! command line, where they outrank anything the repository says.
//!
//! Always fixed, in every folder: an fsmonitor command, `ext::` remotes, an
//! editor or a terminal prompt (Klide has no terminal to give them).
//!
//! In a folder nobody has trusted (`workspace_trust.rs`), the repository gets
//! no say at all. Its hooks are off, and Git runs only when the repository's
//! own config holds nothing but plain data — remotes, branches, the core
//! basics a clone writes ([`key_is_plain`]). A config that names anything
//! else (a filter, a diff driver, an ssh command, a credential helper, an
//! include) pauses Git in that folder until it is trusted: such settings come
//! from a downloaded `.git`, not from a clone, and there is no complete list
//! of the ones that start programs. In a trusted folder the repository's
//! settings apply as configured — git-lfs, a deploy key, pre-commit.
//!
//! `git_in_klide_is_only_started_here` fails on a `Command::new("git")`
//! anywhere else outside a test module.

use std::path::{Path, PathBuf};

/// `-c` settings every git Klide starts carries.
const SETTINGS: &[&str] = &[
    // A repository can name a program that runs on every `status`.
    "core.fsmonitor=false",
    // `ext::<command>` remotes run that command on fetch or push; a
    // repository's own config can allow them.
    "protocol.ext.allow=never",
];

/// Added in a restricted folder: hooks are found nowhere.
const RESTRICTED: &[&str] = &["core.hooksPath=/dev/null"];

/// Environment every git Klide starts carries. `:` is git's own "no editor":
/// a commit without a message aborts instead of starting `core.editor`.
const ENV: &[(&str, &str)] = &[
    ("GIT_EDITOR", ":"),
    ("GIT_SEQUENCE_EDITOR", ":"),
    ("GIT_TERMINAL_PROMPT", "0"),
];

/// What a git call in a paused folder answers.
pub(crate) const PAUSED: &str =
    "Git is paused in this folder: its Git settings can start programs. Trust the folder to use Git here.";

fn configure(cmd: &mut std::process::Command, extra: &[&str]) {
    // A hook an agent planted runs inside the wall too.
    crate::secret_wall::guard(cmd);
    for setting in SETTINGS.iter().chain(extra) {
        cmd.args(["-c", setting]);
    }
    cmd.envs(ENV.iter().copied());
}

/// `git` with the fixed settings and no folder — only for a command that
/// runs outside any repository (`clone` into a parent folder). Everything
/// that runs in a folder goes through [`git_in`].
pub(super) fn git_unscoped() -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    configure(&mut cmd, &[]);
    cmd
}

/// `git -C dir`, under that folder's trust. `Err(PAUSED)` when the folder is
/// restricted and its Git settings are not plain data.
pub(crate) fn git_in(dir: impl AsRef<Path>) -> Result<std::process::Command, String> {
    let dir = dir.as_ref();
    build(dir, crate::workspace_trust::is_trusted(dir))
}

fn build(dir: &Path, trusted: bool) -> Result<std::process::Command, String> {
    let extra = restriction(dir, trusted)?;
    let mut cmd = std::process::Command::new("git");
    configure(&mut cmd, extra);
    cmd.arg("-C").arg(dir);
    Ok(cmd)
}

/// Subcommands that run a repository's hooks — what a restricted folder skips.
const RUNS_HOOKS: &[&str] = &["commit", "push", "pull", "merge", "rebase", "checkout", "switch", "cherry-pick", "revert", "am"];

/// Whether `args` would run a repository hook: one of [`RUNS_HOOKS`], or
/// `worktree add` (post-checkout).
fn runs_hooks(args: &[&str]) -> bool {
    match args {
        ["worktree", "add", ..] => true,
        [sub, ..] => RUNS_HOOKS.contains(sub),
        [] => false,
    }
}

/// `git -C dir <args>` for something a person or a Run set out to do (a
/// commit, a push, a checkout) rather than a poll. In a folder nobody trusted
/// it also reminds: when Git is paused there, or when these args would have
/// run the repository's hooks. The app turns that into the trust notification
/// ([`on_restricted_attempt`]). Reads that only look go through [`git_in`].
pub(crate) fn git_action(dir: impl AsRef<Path>, args: &[&str]) -> Result<std::process::Command, String> {
    let dir = dir.as_ref();
    let trusted = crate::workspace_trust::is_trusted(dir);
    let built = build(dir, trusted);
    if !trusted && (built.is_err() || runs_hooks(args)) {
        remind(dir, built.is_err());
    }
    let mut cmd = built?;
    cmd.args(args);
    Ok(cmd)
}

/// Who hears that something tried to run in a restricted folder: `(folder,
/// git_paused)`. Installed once by the app at startup; tests and the daemon
/// have none.
type Reminder = Box<dyn Fn(&Path, bool) + Send + Sync>;
static REMINDER: std::sync::OnceLock<Reminder> = std::sync::OnceLock::new();

pub(crate) fn on_restricted_attempt(reminder: Reminder) {
    let _ = REMINDER.set(reminder);
}

/// At most once per folder every ten seconds: a commit then a push is one
/// reminder, not two.
fn remind(dir: &Path, paused: bool) {
    if should_remind(dir, std::time::Instant::now()) {
        if let Some(reminder) = REMINDER.get() {
            reminder(dir, paused);
        }
    }
}

fn should_remind(dir: &Path, now: std::time::Instant) -> bool {
    use std::sync::Mutex;
    static LAST: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, std::time::Instant>>> = std::sync::OnceLock::new();
    let Ok(mut last) = LAST.get_or_init(Default::default).lock() else { return false };
    match last.get(dir) {
        Some(at) if now.duration_since(*at) < std::time::Duration::from_secs(10) => false,
        _ => {
            last.insert(dir.to_path_buf(), now);
            true
        }
    }
}

/// [`git_in`] for async callers.
pub(crate) fn git_in_tokio(dir: impl AsRef<Path>) -> Result<tokio::process::Command, String> {
    let std = git_in(dir)?;
    let mut cmd = tokio::process::Command::new(std.get_program());
    // Copying program and arguments drops the std command's pre-exec hook.
    crate::secret_wall::guard_tokio(&mut cmd);
    cmd.args(std.get_args());
    for (key, value) in std.get_envs() {
        if let Some(value) = value {
            cmd.env(key, value);
        }
    }
    Ok(cmd)
}

fn restriction(dir: &Path, trusted: bool) -> Result<&'static [&'static str], String> {
    if trusted {
        Ok(&[])
    } else if config_is_plain(dir) {
        Ok(RESTRICTED)
    } else {
        Err(PAUSED.to_string())
    }
}

/// Whether the repository at `dir` keeps only plain data in its own config
/// (the `local` and `worktree` scopes, includes followed). Remembered for a
/// few seconds: a status poll asks every couple of seconds.
pub(crate) fn config_is_plain(dir: &Path) -> bool {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static MEMO: OnceLock<Mutex<std::collections::HashMap<PathBuf, (Instant, bool)>>> = OnceLock::new();
    let memo = MEMO.get_or_init(Default::default);
    if let Some(&(at, plain)) = memo.lock().ok().and_then(|m| m.get(dir).copied()).as_ref() {
        if at.elapsed() < Duration::from_secs(5) {
            return plain;
        }
    }
    let plain = read_config_is_plain(dir);
    if let Ok(mut map) = memo.lock() {
        map.insert(dir.to_path_buf(), (Instant::now(), plain));
    }
    plain
}

fn read_config_is_plain(dir: &Path) -> bool {
    // Reading config starts nothing; a folder that is no repository lists
    // only the user's own scopes.
    let Ok(out) = git_unscoped()
        .arg("-C")
        .arg(dir)
        .args(["config", "--list", "--show-scope", "--includes", "-z"])
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        // Not a repository, or a config git cannot parse: nothing Klide runs
        // here would read it either.
        return true;
    }
    entries_are_plain(&String::from_utf8_lossy(&out.stdout))
}

/// `git config --list --show-scope -z` output: `scope\0key[\nvalue]\0` per
/// entry. Only what the repository wrote is judged.
fn entries_are_plain(listing: &str) -> bool {
    let mut tokens = listing.split('\0');
    while let (Some(scope), Some(entry)) = (tokens.next(), tokens.next()) {
        let (key, value) = entry.split_once('\n').map_or((entry, None), |(key, value)| (key, Some(value)));
        // An empty helper resets credential lookup; Klide's exact SSH command
        // selects one managed key. Neither grants folder trust or enables hooks.
        let managed = (key == "credential.helper" && value == Some(""))
            || (key == "core.sshcommand" && value.is_some_and(crate::machine_repository::is_managed_ssh_command));
        if matches!(scope, "local" | "worktree") && !key_is_plain(key) && !managed {
            return false;
        }
    }
    true
}

/// A repository config key that is data, never a program: what `git clone`,
/// `git init`, `git branch`, `gh` and editors write. Anything not named here
/// pauses Git in a restricted folder — a false alarm costs one click.
fn key_is_plain(key: &str) -> bool {
    let (section, rest) = key.split_once('.').unwrap_or((key, ""));
    // `section.subsection.name` — the subsection may itself hold dots.
    let (sub, name) = match rest.rsplit_once('.') {
        Some((sub, name)) => (Some(sub), name),
        None => (None, rest),
    };
    match (section, sub, name) {
        ("core", None, n) => matches!(
            n,
            "repositoryformatversion" | "filemode" | "bare" | "logallrefupdates" | "ignorecase"
                | "precomposeunicode" | "symlinks" | "autocrlf" | "eol" | "safecrlf" | "sparsecheckout"
                | "sparsecheckoutcone" | "untrackedcache" | "splitindex" | "commitgraph"
                | "multipackindex" | "abbrev" | "quotepath" | "checkstat" | "trustctime"
        ),
        ("extensions", None, _) | ("advice", None, _) | ("color", _, _) => true,
        ("branch", Some(_), _) => true,
        ("remote", None, "pushdefault") => true,
        ("remote", Some(_), n) => matches!(
            n,
            "url" | "pushurl" | "fetch" | "push" | "tagopt" | "prune" | "prunetags" | "mirror" | "promisor"
                | "partialclonefilter" | "skipdefaultupdate" | "skipfetchall"
        ),
        ("submodule", Some(_), n) => matches!(n, "url" | "active" | "branch" | "shallow" | "ignore" | "fetchrecursesubmodules"),
        ("submodule", None, "active") => true,
        ("user", None, n) => matches!(n, "name" | "email" | "signingkey"),
        ("lfs", None, "repositoryformatversion") => true,
        ("pull", None, n) => matches!(n, "rebase" | "ff"),
        ("push", None, n) => matches!(n, "default" | "autosetupremote" | "followtags"),
        ("fetch", None, n) => matches!(n, "prune" | "prunetags"),
        ("init", None, "defaultbranch") => true,
        ("merge", None, n) => matches!(n, "ff" | "conflictstyle"),
        ("diff", None, n) => matches!(n, "renames" | "algorithm" | "colormoved"),
        ("rebase", None, n) => matches!(n, "autosquash" | "autostash"),
        ("rerere", None, "enabled") => true,
        ("gc", None, n) => matches!(n, "auto" | "autodetach"),
        ("maintenance", None, n) => matches!(n, "auto" | "strategy"),
        ("index", None, "version") => true,
        ("status", None, "showuntrackedfiles") => true,
        ("checkout", None, "defaultremote") => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-git-cmd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A repository that names an fsmonitor command gets no say: `status`
    /// through the launcher never starts it.
    #[cfg(unix)]
    #[test]
    fn a_repository_fsmonitor_never_runs() {
        let root = scratch("fsmonitor");
        let canary = root.join("ran");
        assert!(git_unscoped().args(["init", "-q"]).current_dir(&root).status().unwrap().success());
        let hook = root.join("monitor.sh");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", canary.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let set = std::process::Command::new("git")
            .args(["config", "core.fsmonitor", &hook.to_string_lossy()])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(set.success());
        std::fs::write(root.join("a.txt"), "a").unwrap();
        assert!(git_unscoped().args(["status", "--short"]).current_dir(&root).output().unwrap().status.success());
        assert!(!canary.exists(), "the repository's fsmonitor command ran");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A commit with no message aborts rather than opening `core.editor`.
    #[test]
    fn no_editor_is_ever_started() {
        let root = scratch("editor");
        assert!(git_unscoped().args(["init", "-q"]).current_dir(&root).status().unwrap().success());
        let canary = root.join("edited");
        std::process::Command::new("git")
            .args(["config", "core.editor", &format!("touch '{}'", canary.display())])
            .current_dir(&root)
            .status()
            .unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        git_unscoped().args(["add", "a.txt"]).current_dir(&root).status().unwrap();
        let commit = git_unscoped()
            .args(["-c", "user.name=t", "-c", "user.email=t@klide.local", "commit", "-q"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(!commit.status.success(), "an empty message aborts the commit");
        assert!(!canary.exists(), "the repository's editor ran");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plain_keys_are_what_a_clone_writes_and_nothing_that_runs() {
        for key in [
            "core.repositoryformatversion", "core.bare", "remote.origin.url", "remote.origin.fetch",
            "branch.main.merge", "branch.feat/claude.stop.remote", "branch.main.vscode-merge-base",
            "user.email", "extensions.worktreeconfig", "push.autosetupremote", "lfs.repositoryformatversion",
        ] {
            assert!(key_is_plain(key), "{key} is data");
        }
        for key in [
            "core.fsmonitor", "core.hookspath", "core.sshcommand", "core.askpass", "core.gitproxy",
            "core.pager", "core.editor", "credential.helper", "credential.https://x.helper", "include.path",
            "includeif.gitdir:/x.path", "filter.lfs.clean", "diff.x.textconv", "diff.external",
            "remote.origin.uploadpack", "remote.origin.receivepack", "remote.origin.vcs",
            "submodule.a.update", "gpg.program", "commit.gpgsign", "alias.st", "lfs.customtransfer.x.path",
        ] {
            assert!(!key_is_plain(key), "{key} can start a program");
        }
    }

    #[test]
    fn only_the_repository_scopes_are_judged() {
        let clone = "local\0core.bare\nfalse\0local\0remote.origin.url\nhttps://x\0global\0filter.lfs.clean\ngit-lfs clean -- %f\0";
        assert!(entries_are_plain(clone), "the user's own lfs filter is theirs");
        assert!(!entries_are_plain("local\0core.bare\nfalse\0local\0filter.x.clean\nsh evil\0"));
        assert!(!entries_are_plain("worktree\0core.sshcommand\nsh evil\0"));
        // A value cannot smuggle a scope: it stays inside its own entry.
        assert!(!entries_are_plain("local\0core.sshcommand\nx\nlocal\0core.bare\0"));
        assert!(entries_are_plain("local\0core.bare\0"), "a key with no value");
    }

    #[test]
    fn repository_only_access_remains_restricted_without_blocking_worktrees() {
        let root = scratch("repository-key");
        assert!(git_unscoped().args(["init", "-q"]).current_dir(&root).status().unwrap().success());
        let os = if cfg!(windows) { crate::remote_platform::HostOs::Windows } else { crate::remote_platform::HostOs::Linux };
        let ssh = crate::machine_repository::ssh_command("pierreprudh/KLIDE", os);
        for (key, value) in [("core.sshCommand", ssh.as_str()), ("credential.helper", "")] {
            assert!(git_unscoped().arg("-C").arg(&root).args(["config", "--local", key, value]).status().unwrap().success());
        }
        assert!(read_config_is_plain(&root), "Klide's own repo-only settings must not pause Git");
        let command = build(&root, false).unwrap();
        let args: Vec<_> = command.get_args().map(|v| v.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|arg| arg == "core.hooksPath=/dev/null"), "repository hooks stay disabled");
        assert!(git_unscoped().arg("-C").arg(&root).args(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]).status().unwrap().success());
        let tree = root.join("conversation");
        assert!(build(&root, false).unwrap().args(["worktree", "add", "--detach"]).arg(&tree).arg("HEAD").output().unwrap().status.success());
        assert!(read_config_is_plain(&tree), "conversation worktrees inherit the same safe settings");
        for (key, value) in [("core.sshcommand", format!("{ssh}; echo injected")), ("credential.helper", "!echo injected".into()), ("filter.x.clean", "echo injected".into())] {
            assert!(!entries_are_plain(&format!("local\0core.sshcommand\n{ssh}\0local\0credential.helper\n\0local\0{key}\n{value}\0")), "{key} must remain blocked");
        }
        for altered in [ssh.replace("IdentityAgent=none", "IdentityAgent=attacker"), ssh.replace("/key\"", "/key\"; echo injected"), ssh.replace("$HOME/.klide/repository-keys/", "$HOME/other/")] {
            assert!(!crate::machine_repository::is_managed_ssh_command(&altered));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn actions_that_run_hooks_are_told_from_ones_that_only_look() {
        assert!(runs_hooks(&["commit", "-m", "x"]));
        assert!(runs_hooks(&["push"]));
        assert!(runs_hooks(&["worktree", "add", "../x"]));
        assert!(!runs_hooks(&["worktree", "list"]));
        assert!(!runs_hooks(&["add", "-A"]));
        assert!(!runs_hooks(&["stash", "push"]));
        assert!(!runs_hooks(&[]));
    }

    #[test]
    fn a_burst_of_attempts_reminds_once() {
        let dir = scratch("remind");
        let start = std::time::Instant::now();
        assert!(should_remind(&dir, start));
        assert!(!should_remind(&dir, start + std::time::Duration::from_secs(3)), "a commit then a push");
        assert!(should_remind(&dir, start + std::time::Duration::from_secs(11)));
        assert!(should_remind(&scratch("remind-other"), start), "per folder");
    }

    fn git_raw(dir: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git").args(args).current_dir(dir).output().unwrap()
    }

    /// A restricted folder: hooks don't run, a clone-like config keeps Git
    /// working, and a config that names a program pauses it.
    #[cfg(unix)]
    #[test]
    fn a_restricted_folder_runs_no_hook_and_pauses_on_a_program_setting() {
        let root = scratch("restricted").canonicalize().unwrap();
        assert!(git_raw(&root, &["init", "-q"]).status.success());
        let canary = root.join("hook-ran");
        let hook = root.join(".git/hooks/pre-commit");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", canary.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        let extra = restriction(&root, false).expect("a fresh repository's config is plain");
        let mut cmd = std::process::Command::new("git");
        configure(&mut cmd, extra);
        let commit = cmd
            .arg("-C")
            .arg(&root)
            .args(["-c", "user.name=t", "-c", "user.email=t@klide.local", "commit", "-qm", "one", "--allow-empty"])
            .output()
            .unwrap();
        assert!(commit.status.success(), "{}", String::from_utf8_lossy(&commit.stderr));
        assert!(!canary.exists(), "the repository's hook ran in a restricted folder");
        assert!(restriction(&root, true).unwrap().is_empty(), "a trusted folder keeps its hooks");

        let paused = scratch("paused").canonicalize().unwrap();
        assert!(git_raw(&paused, &["init", "-q"]).status.success());
        assert!(git_raw(&paused, &["config", "filter.x.clean", "sh evil"]).status.success());
        assert_eq!(restriction(&paused, false).unwrap_err(), PAUSED);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&paused);
    }

    /// Source scan: outside test modules, git is started here and nowhere
    /// else, so a setting added above reaches every call.
    #[test]
    fn git_in_klide_is_only_started_here() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![src.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "rs") || path.ends_with("git/cmd.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                let mut lines = text.lines().enumerate().peekable();
                let mut after_cfg_test = false;
                while let Some((n, line)) = lines.next() {
                    // A top-level `#[cfg(test)] mod … {` runs to the first
                    // `}` in column 0.
                    if after_cfg_test && line.starts_with("mod ") && line.trim_end().ends_with('{') {
                        for (_, inner) in lines.by_ref() {
                            if inner == "}" {
                                break;
                            }
                        }
                        after_cfg_test = false;
                        continue;
                    }
                    after_cfg_test = line.trim() == "#[cfg(test)]";
                    let code = line.split("//").next().unwrap_or("");
                    if code.contains("Command::new(\"git\")") {
                        offenders.push(format!("{}:{}: {}", path.strip_prefix(&src).unwrap().display(), n + 1, line.trim()));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "git started outside git/cmd.rs — use crate::git::cmd::git_in(dir) / git_in_tokio(dir):\n{}",
            offenders.join("\n")
        );
    }
}
