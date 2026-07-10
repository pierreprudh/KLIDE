//! Worktree setup — the per-workspace bootstrap seam.
//!
//! A fresh worktree has every TRACKED file but none of the gitignored
//! machinery a build actually needs — secrets (`.env`), dependency dirs
//! (`node_modules`), a free dev-server port. That gap is the #1 reason a
//! fresh worktree won't run. This module owns the whole answer: a declarative
//! recipe per workspace (`<workspace>/.klide/worktree.json`), and the code
//! that applies it. `git::git_worktree_add` is the only caller — it applies
//! the fast parts (copy / link / port) inline and runs the setup script on a
//! background thread, reporting completion over the `worktree-setup:done`
//! event.
//!
//! Recipe example:
//! ```json
//! {
//!   "copyFiles": [".env", ".env.local"],
//!   "linkDirs": ["node_modules"],
//!   "setupScript": "npm install --prefer-offline",
//!   "portBase": 3100,
//!   "scriptTimeoutSecs": 600
//! }
//! ```
//! Every field is optional; a missing file means "copy the usual .env names,
//! link nothing, run nothing". The script runs in the worktree via a login
//! shell with `KLIDE_WORKTREE_PATH` / `KLIDE_WORKTREE_BRANCH` /
//! `KLIDE_MAIN_ROOT` / `KLIDE_WORKTREE_PORT` in its environment.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;

/// The parsed per-workspace recipe. Defaults are deliberately conservative:
/// copying env files is safe everywhere; linking dependency dirs and running
/// scripts are opt-in.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorktreeSetup {
    /// Top-level untracked files to copy from the main checkout.
    pub copy_files: Vec<String>,
    /// Top-level dirs to symlink from the main checkout (e.g. `node_modules`)
    /// so a worktree is buildable without a full reinstall. Opt-in: a linked
    /// dir is SHARED with the main checkout.
    pub link_dirs: Vec<String>,
    /// Shell command run in the fresh worktree (login shell, background).
    pub setup_script: Option<String>,
    /// When set, each worktree gets a deterministic port in
    /// `[portBase, portBase+900)` derived from its directory name, exposed to
    /// the setup script as `KLIDE_WORKTREE_PORT` — so parallel dev servers
    /// don't fight over one port.
    pub port_base: Option<u16>,
    /// Kill a runaway setup script after this long.
    pub script_timeout_secs: u64,
}

impl Default for WorktreeSetup {
    fn default() -> Self {
        Self {
            copy_files: [
                ".env",
                ".env.local",
                ".env.development",
                ".env.development.local",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            link_dirs: Vec::new(),
            setup_script: None,
            port_base: None,
            script_timeout_secs: 600,
        }
    }
}

/// Load the workspace recipe, falling back to the defaults when the file is
/// missing. A present-but-invalid file also falls back (warn-only — a broken
/// recipe must never block creating a worktree), with a note on stderr.
pub fn load(workspace_root: &str) -> WorktreeSetup {
    let path = Path::new(workspace_root)
        .join(".klide")
        .join("worktree.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return WorktreeSetup::default();
    };
    match serde_json::from_str(&text) {
        Ok(setup) => setup,
        Err(err) => {
            eprintln!("invalid {}: {err} — using defaults", path.display());
            WorktreeSetup::default()
        }
    }
}

/// One top-level name, with no path tricks — the shared guard for everything
/// the recipe touches, so a recipe can't be coaxed into writing outside the
/// worktree.
fn safe_top_level(name: &str) -> Option<&str> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        None
    } else {
        Some(name)
    }
}

/// Copy small untracked config files (e.g. `.env`) from the main checkout into
/// a fresh worktree. Skips any already present in the worktree or missing from
/// the source. Returns the names actually copied.
pub fn copy_files_into(source_root: &str, worktree: &Path, files: &[String]) -> Vec<String> {
    let mut copied = Vec::new();
    for name in files {
        let Some(name) = safe_top_level(name) else {
            continue;
        };
        let src = Path::new(source_root).join(name);
        let dst = worktree.join(name);
        if src.is_file() && !dst.exists() && std::fs::copy(&src, &dst).is_ok() {
            copied.push(name.to_string());
        }
    }
    copied
}

/// Symlink top-level dirs (e.g. `node_modules`) from the main checkout into
/// the worktree. Skips names already present in the worktree or missing from
/// the source. Returns the names actually linked.
pub fn link_dirs_into(source_root: &str, worktree: &Path, dirs: &[String]) -> Vec<String> {
    let mut linked = Vec::new();
    for name in dirs {
        let Some(name) = safe_top_level(name) else {
            continue;
        };
        let src = Path::new(source_root).join(name);
        let dst = worktree.join(name);
        if src.is_dir()
            && !dst.exists()
            && std::os::unix::fs::symlink(&src, &dst).is_ok()
        {
            linked.push(name.to_string());
        }
    }
    linked
}

/// Deterministic per-worktree port: same worktree name → same port, different
/// names spread across `[base, base+900)`. Collisions across many worktrees
/// are possible but rare; determinism is the property that matters (a
/// worktree's dev server address never moves between sessions).
pub fn port_for(port_base: u16, worktree_name: &str) -> u16 {
    // FNV-1a over the name — tiny, dependency-free, stable.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in worktree_name.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    port_base.saturating_add((hash % 900) as u16)
}

/// What happened to the setup script.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOutcome {
    pub ok: bool,
    /// Combined stdout+stderr tail (last ~2000 chars), enough to see why a
    /// setup failed without shipping a full install log across IPC.
    pub output: String,
}

/// Run the setup script in the worktree via a login shell (so PATH matches
/// the user's terminal — Finder-launched apps have a minimal PATH), draining
/// output on side threads and killing the child past `timeout_secs`.
pub fn run_script(
    script: &str,
    worktree: &Path,
    envs: &[(String, String)],
    timeout_secs: u64,
) -> ScriptOutcome {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = match std::process::Command::new(shell)
        .arg("-lc")
        .arg(script)
        .current_dir(worktree)
        .envs(envs.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return ScriptOutcome {
                ok: false,
                output: format!("failed to start setup script: {err}"),
            }
        }
    };

    // Drain both pipes on side threads — a full pipe would deadlock the child
    // long before the timeout fires.
    fn drain<R: Read + Send + 'static>(reader: Option<R>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut out = String::new();
            if let Some(mut reader) = reader {
                let mut buf = Vec::new();
                let _ = reader.read_to_end(&mut buf);
                out = String::from_utf8_lossy(&buf).to_string();
            }
            out
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs.max(1));
    let (ok, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.success(), false),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break (false, true);
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(_) => break (false, false),
        }
    };

    let mut output = stdout.join().unwrap_or_default();
    let err_text = stderr.join().unwrap_or_default();
    if !err_text.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&err_text);
    }
    if timed_out {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&format!("setup script killed after {timeout_secs}s"));
    }
    // Keep the tail — the end of an install log is where the error lives.
    const TAIL: usize = 2000;
    if output.len() > TAIL {
        let cut = output.len() - TAIL;
        // Don't split a UTF-8 char.
        let cut = (cut..output.len())
            .find(|i| output.is_char_boundary(*i))
            .unwrap_or(cut);
        output = output[cut..].to_string();
    }
    ScriptOutcome { ok, output }
}

/// The env the setup script sees, so one recipe can serve every worktree.
pub fn script_env(
    main_root: &str,
    worktree: &Path,
    branch: &str,
    port: Option<u16>,
) -> Vec<(String, String)> {
    let mut envs = vec![
        (
            "KLIDE_WORKTREE_PATH".to_string(),
            worktree.to_string_lossy().to_string(),
        ),
        ("KLIDE_WORKTREE_BRANCH".to_string(), branch.to_string()),
        ("KLIDE_MAIN_ROOT".to_string(), main_root.to_string()),
    ];
    if let Some(port) = port {
        envs.push(("KLIDE_WORKTREE_PORT".to_string(), port.to_string()));
    }
    envs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_pair(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "klide-wt-setup-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let src = base.join("main");
        let wt = base.join("wt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        (base, src, wt)
    }

    #[test]
    fn load_falls_back_to_defaults_when_config_missing_or_invalid() {
        let (base, src, _wt) = temp_pair("load");
        let missing = load(src.to_str().unwrap());
        assert!(missing.copy_files.contains(&".env".to_string()));
        assert!(missing.link_dirs.is_empty());
        assert!(missing.setup_script.is_none());

        let klide = src.join(".klide");
        std::fs::create_dir_all(&klide).unwrap();
        std::fs::write(klide.join("worktree.json"), "{ not json").unwrap();
        let invalid = load(src.to_str().unwrap());
        assert!(invalid.setup_script.is_none(), "invalid file → defaults");

        std::fs::write(
            klide.join("worktree.json"),
            r#"{ "linkDirs": ["node_modules"], "setupScript": "npm ci", "portBase": 3100 }"#,
        )
        .unwrap();
        let parsed = load(src.to_str().unwrap());
        assert_eq!(parsed.link_dirs, vec!["node_modules".to_string()]);
        assert_eq!(parsed.setup_script.as_deref(), Some("npm ci"));
        assert_eq!(parsed.port_base, Some(3100));
        // Unspecified fields keep their defaults.
        assert!(parsed.copy_files.contains(&".env".to_string()));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn copy_files_skips_present_missing_and_traversal_names() {
        let (base, src, wt) = temp_pair("copy");
        std::fs::write(src.join(".env"), "SECRET=1").unwrap();
        std::fs::write(src.join(".env.local"), "L=2").unwrap();
        std::fs::write(wt.join(".env.local"), "KEEP").unwrap();

        let copied = copy_files_into(
            src.to_str().unwrap(),
            &wt,
            &[
                ".env".into(),
                ".env.local".into(),   // exists in wt → skipped
                ".env.missing".into(), // not in src → skipped
                "../escape".into(),    // traversal → rejected
                "nested/x".into(),     // not top-level → rejected
            ],
        );

        assert_eq!(copied, vec![".env".to_string()]);
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1");
        assert_eq!(
            std::fs::read_to_string(wt.join(".env.local")).unwrap(),
            "KEEP"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn link_dirs_symlinks_missing_dirs_only() {
        let (base, src, wt) = temp_pair("link");
        std::fs::create_dir_all(src.join("node_modules").join("pkg")).unwrap();
        std::fs::create_dir_all(wt.join("already")).unwrap();
        std::fs::create_dir_all(src.join("already")).unwrap();

        let linked = link_dirs_into(
            src.to_str().unwrap(),
            &wt,
            &[
                "node_modules".into(),
                "already".into(), // exists in wt → skipped
                "missing".into(), // not in src → skipped
                "../up".into(),   // traversal → rejected
            ],
        );

        assert_eq!(linked, vec!["node_modules".to_string()]);
        let link = wt.join("node_modules");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(link.join("pkg").is_dir(), "resolves into the main checkout");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn port_is_deterministic_and_in_range() {
        let a = port_for(3100, "klide-wt-abc");
        let b = port_for(3100, "klide-wt-abc");
        let c = port_for(3100, "klide-wt-xyz");
        assert_eq!(a, b, "same worktree → same port");
        assert!((3100..4000).contains(&a));
        assert!((3100..4000).contains(&c));
    }

    #[test]
    fn run_script_reports_success_failure_and_env() {
        let (base, src, wt) = temp_pair("script");
        let envs = script_env(src.to_str().unwrap(), &wt, "klide/wt-1", Some(3107));

        let ok = run_script("echo port=$KLIDE_WORKTREE_PORT on $KLIDE_WORKTREE_BRANCH", &wt, &envs, 30);
        assert!(ok.ok);
        assert!(ok.output.contains("port=3107 on klide/wt-1"), "got: {}", ok.output);

        let fail = run_script("echo doomed >&2; exit 3", &wt, &envs, 30);
        assert!(!fail.ok);
        assert!(fail.output.contains("doomed"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn run_script_kills_a_runaway_after_the_timeout() {
        let (base, _src, wt) = temp_pair("timeout");
        let start = std::time::Instant::now();
        let outcome = run_script("sleep 30", &wt, &[], 1);
        assert!(!outcome.ok);
        assert!(outcome.output.contains("killed after 1s"));
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "did not wait for the sleep"
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
