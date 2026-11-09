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
//! Pure on purpose: this file builds text and an argv, and `process.rs` is
//! the only place that starts anything. Every caller still passes no sandbox
//! — the policy that decides *when* a command gets one is the next slice.

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
        if !self.network {
            out.push_str(NETWORK_OFF);
        }
        out
    }

    /// The writable folders as the kernel will see them: absolute, symlinks
    /// resolved, each one once, in a stable order.
    fn real_writable(&self) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = self
            .writable
            .iter()
            .filter(|path| path.is_absolute())
            .map(|path| real_path(path))
            .collect();
        paths.sort();
        paths.dedup();
        paths
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
        let profile = Sandbox { writable: vec![PathBuf::from("/")], network: true }.profile();
        let deny = profile.find("(deny file-write*)").expect("writes are denied");
        let allow = profile.find("(allow file-write*").expect("then opened by path");
        assert!(deny < allow, "the last matching rule wins, so the denial comes first");
        assert!(profile.contains("(literal \"/dev/null\")"));
    }

    #[test]
    fn network_rules_appear_only_when_the_network_is_off() {
        let on = Sandbox { writable: vec![], network: true }.profile();
        assert!(!on.contains("network"));
        let off = Sandbox { writable: vec![], network: false }.profile();
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
        let profile = Sandbox { writable: vec![hostile.clone()], network: true }.profile();
        let rule = format!("\n  (subpath {})", quoted(&real_path(&hostile)));
        assert!(profile.contains(&rule), "the path is one escaped literal: {profile}");
        assert_eq!(profile.matches("\n  (subpath ").count(), 1, "and no second rule starts a line");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wrapping_puts_the_shell_behind_sandbox_exec() {
        let sandbox = Sandbox { writable: vec![], network: false };
        let (program, args) = sandbox.wrap("sh").unwrap();
        assert_eq!(program, "/usr/bin/sandbox-exec");
        assert_eq!(args, vec!["-p".to_string(), sandbox.profile(), "sh".to_string()]);
    }
}
