//! The one way Klide starts `git`.
//!
//! Klide runs git in whatever folder is open, often without anyone asking
//! for it: a status poll, a dirty-set check around a command, a worktree
//! commit. A repository's own `.git/config` is read on every one of those,
//! and some of its settings name a program git then starts by itself. So
//! every invocation is built here, with the settings below fixed on the
//! command line, where they outrank anything the repository says.
//!
//! What is fixed is only what no repository needs from Klide's git: an
//! fsmonitor command, `ext::` remotes, an editor or a terminal prompt (Klide
//! has no terminal to give them). Hooks, clean/smudge filters, `textconv`,
//! `core.sshCommand` and credential helpers stay as configured — a trusted
//! repository relies on them (git-lfs, a per-repo deploy key, pre-commit).
//! Turning those off belongs to the restricted state of a folder nobody has
//! trusted, and that state switches them here, not at a call site.
//!
//! `git_in_klide_is_only_started_here` fails on a `Command::new("git")`
//! anywhere else outside a test module.

/// `-c` settings every git Klide starts carries.
const SETTINGS: &[&str] = &[
    // A repository can name a program that runs on every `status`.
    "core.fsmonitor=false",
    // `ext::<command>` remotes run that command on fetch or push; a
    // repository's own config can allow them.
    "protocol.ext.allow=never",
];

/// Environment every git Klide starts carries. `:` is git's own "no editor":
/// a commit without a message aborts instead of starting `core.editor`.
const ENV: &[(&str, &str)] = &[
    ("GIT_EDITOR", ":"),
    ("GIT_SEQUENCE_EDITOR", ":"),
    ("GIT_TERMINAL_PROMPT", "0"),
];

/// `git` with Klide's fixed settings, for blocking callers.
pub(crate) fn git() -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    for setting in SETTINGS {
        cmd.args(["-c", setting]);
    }
    cmd.envs(ENV.iter().copied());
    cmd
}

/// [`git`] for async callers.
pub(crate) fn git_tokio() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("git");
    for setting in SETTINGS {
        cmd.args(["-c", setting]);
    }
    cmd.envs(ENV.iter().copied());
    cmd
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
        assert!(git().args(["init", "-q"]).current_dir(&root).status().unwrap().success());
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
        assert!(git().args(["status", "--short"]).current_dir(&root).output().unwrap().status.success());
        assert!(!canary.exists(), "the repository's fsmonitor command ran");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A commit with no message aborts rather than opening `core.editor`.
    #[test]
    fn no_editor_is_ever_started() {
        let root = scratch("editor");
        assert!(git().args(["init", "-q"]).current_dir(&root).status().unwrap().success());
        let canary = root.join("edited");
        std::process::Command::new("git")
            .args(["config", "core.editor", &format!("touch '{}'", canary.display())])
            .current_dir(&root)
            .status()
            .unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        git().args(["add", "a.txt"]).current_dir(&root).status().unwrap();
        let commit = git()
            .args(["-c", "user.name=t", "-c", "user.email=t@klide.local", "commit", "-q"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(!commit.status.success(), "an empty message aborts the commit");
        assert!(!canary.exists(), "the repository's editor ran");
        let _ = std::fs::remove_dir_all(&root);
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
            "git started outside git/cmd.rs — use crate::git::cmd::git() / git_tokio():\n{}",
            offenders.join("\n")
        );
    }
}
