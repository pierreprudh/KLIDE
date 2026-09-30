//! Where a Delegate CLI keeps its things — resolved by its adapter, read by
//! everyone else.
//!
//! Each CLI has a home of its own (`~/.codex`, `~/.claude`, OpenCode's XDG
//! pair, `~/.omp`) and most let the user move it with an environment variable
//! of their own (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` /
//! `XDG_DATA_HOME`). Before this module, nine places in seven files spelled
//! Codex's home by hand and exactly one of them honoured `CODEX_HOME` — so
//! with it set, the hook installer wrote one `config.toml` and the gateway's
//! un-inject read another. Now an adapter answers, once, and the answer
//! carries the override.
//!
//! Resolution reads through [`Env`] rather than `std::env` directly, so a
//! test can set `CODEX_HOME` for one call without touching the process, and
//! a developer who has it set sees the fixture, not their own sessions.

use std::path::{Path, PathBuf};

/// Where an adapter reads environment variables from. The runtime hands in
/// [`ProcessEnv`]; a test hands in a map.
pub trait Env: Sync {
    fn var(&self, key: &str) -> Option<String>;
}

/// The real process environment.
pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.is_empty())
    }
}

/// The user's home directory: `HOME`, or `USERPROFILE` on Windows. This is
/// the one place the crate resolves it — every other path that used to read
/// `HOME` itself now goes through an adapter, and the adapter through here.
pub fn home_dir(env: &dyn Env) -> Option<PathBuf> {
    if let Some(home) = env.var("HOME") {
        return Some(PathBuf::from(home));
    }
    if cfg!(windows) {
        env.var("USERPROFILE").map(PathBuf::from)
    } else {
        None
    }
}

/// A directory the user may have moved: the override variable when it is
/// set, otherwise `default` under home.
pub(super) fn overridable(env: &dyn Env, var: &str, default: &str) -> Option<PathBuf> {
    if let Some(dir) = env.var(var) {
        return Some(PathBuf::from(dir));
    }
    home_dir(env).map(|h| h.join(default))
}

/// An XDG base directory: `$XDG_*_HOME/<app>` when set, otherwise
/// `~/<default>/<app>`.
pub(super) fn xdg(env: &dyn Env, var: &str, default: &str, app: &str) -> Option<PathBuf> {
    overridable(env, var, default).map(|base| base.join(app))
}

/// Klide's own hook shims — a Klide directory, not a CLI's, but the hooks
/// point into it, so the same resolver names it.
pub fn klide_hooks_dir(env: &dyn Env) -> Option<PathBuf> {
    home_dir(env).map(|h| h.join(".klide").join("hooks"))
}

/// Whether `path` sits inside `root` after both are canonicalized — the
/// containment test for reading a run transcript, shared by every root.
pub fn is_under(root: &Path, path: &Path) -> bool {
    match (root.canonicalize(), path.canonicalize()) {
        (Ok(root), Ok(path)) => path.starts_with(root),
        _ => false,
    }
}

/// A fixed environment for tests: only the pairs it was given, nothing from
/// the process. `with_home` is the common case — a throwaway directory as
/// HOME, every override unset.
#[cfg(test)]
pub struct MapEnv(pub std::collections::HashMap<String, String>);

#[cfg(test)]
impl MapEnv {
    pub fn with_home(home: &Path) -> Self {
        let mut map = std::collections::HashMap::new();
        map.insert("HOME".to_string(), home.to_string_lossy().to_string());
        MapEnv(map)
    }

    pub fn set(mut self, key: &str, value: &Path) -> Self {
        self.0
            .insert(key.to_string(), value.to_string_lossy().to_string());
        self
    }
}

#[cfg(test)]
impl Env for MapEnv {
    fn var(&self, key: &str) -> Option<String> {
        self.0.get(key).cloned().filter(|v| !v.is_empty())
    }
}

#[cfg(test)]
pub fn test_env(home: &Path) -> MapEnv {
    MapEnv::with_home(home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delegate::{ClaudeCode, Codex, Delegate, Omp, OpenCode, ALL};

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-home-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn home_dir_reads_only_the_env_it_is_given() {
        let env = MapEnv(Default::default());
        assert_eq!(home_dir(&env), None);
        let home = PathBuf::from("/u/x");
        assert_eq!(home_dir(&MapEnv::with_home(&home)), Some(home));
    }

    #[test]
    fn codex_home_honours_codex_home() {
        let home = PathBuf::from("/u/x");
        let env = MapEnv::with_home(&home);
        assert_eq!(Codex.config_home(&env), Some(home.join(".codex")));
        assert_eq!(Codex.sessions_dir(&env), Some(home.join(".codex/sessions")));
        assert_eq!(Codex.config_file(&env), Some(home.join(".codex/config.toml")));
        assert_eq!(Codex.auth_files(&env), vec![home.join(".codex/auth.json")]);
        assert_eq!(Codex.models_cache(&env), Some(home.join(".codex/models_cache.json")));

        let moved = PathBuf::from("/srv/codex-home");
        let env = env.set("CODEX_HOME", &moved);
        assert_eq!(Codex.config_home(&env), Some(moved.clone()));
        assert_eq!(Codex.sessions_dir(&env), Some(moved.join("sessions")));
        assert_eq!(Codex.config_file(&env), Some(moved.join("config.toml")));
        assert_eq!(Codex.auth_files(&env), vec![moved.join("auth.json")]);
        assert_eq!(Codex.models_cache(&env), Some(moved.join("models_cache.json")));
    }

    #[test]
    fn claude_home_honours_claude_config_dir() {
        let home = PathBuf::from("/u/x");
        let env = MapEnv::with_home(&home);
        assert_eq!(ClaudeCode.config_home(&env), Some(home.join(".claude")));
        assert_eq!(ClaudeCode.sessions_dir(&env), Some(home.join(".claude/projects")));
        assert_eq!(ClaudeCode.config_file(&env), Some(home.join(".claude/settings.json")));
        // The user-state file sits beside the config dir by default…
        assert_eq!(ClaudeCode.user_state_file(&env), Some(home.join(".claude.json")));
        assert!(ClaudeCode.auth_files(&env).is_empty(), "keychain, not files");

        // …and moves inside it when the dir is moved.
        let moved = PathBuf::from("/srv/claude-cfg");
        let env = env.set("CLAUDE_CONFIG_DIR", &moved);
        assert_eq!(ClaudeCode.config_home(&env), Some(moved.clone()));
        assert_eq!(ClaudeCode.sessions_dir(&env), Some(moved.join("projects")));
        assert_eq!(ClaudeCode.config_file(&env), Some(moved.join("settings.json")));
        assert_eq!(ClaudeCode.user_state_file(&env), Some(moved.join(".claude.json")));
        assert_eq!(ClaudeCode.skills_dir(&env), Some(moved.join("skills")));
    }

    #[test]
    fn opencode_has_two_roots_and_honours_xdg() {
        let home = tmp("oc-xdg");
        let env = MapEnv::with_home(&home);
        assert_eq!(OpenCode.config_home(&env), Some(home.join(".config/opencode")));
        assert_eq!(OpenCode.data_home(&env), Some(home.join(".local/share/opencode")));
        assert_eq!(OpenCode.config_file(&env), Some(home.join(".config/opencode/opencode.json")));
        assert_eq!(
            OpenCode.auth_files(&env),
            vec![
                home.join(".local/share/opencode/auth.json"),
                home.join(".local/share/opencode/account.json"),
            ]
        );

        let cfg = PathBuf::from("/xdg/config");
        let data = PathBuf::from("/xdg/data");
        let env = env.set("XDG_CONFIG_HOME", &cfg).set("XDG_DATA_HOME", &data);
        assert_eq!(OpenCode.config_home(&env), Some(cfg.join("opencode")));
        assert_eq!(OpenCode.data_home(&env), Some(data.join("opencode")));
        assert_eq!(OpenCode.sessions_dir(&env), Some(data.join("opencode")));
        assert_eq!(OpenCode.auth_files(&env)[0], data.join("opencode/auth.json"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_falls_back_to_the_apple_dir_for_runs_and_accounts_alike() {
        // An older macOS install kept its DB under Library/Application
        // Support. The run listing knew that; the account switcher did not,
        // so the two could look at different installs. One resolver now.
        let home = tmp("oc-apple");
        let apple = home.join("Library/Application Support/opencode");
        std::fs::create_dir_all(&apple).unwrap();
        let env = MapEnv::with_home(&home);
        assert_eq!(OpenCode.data_home(&env), Some(apple.clone()));
        assert_eq!(OpenCode.sessions_dir(&env), Some(apple.clone()));
        assert_eq!(OpenCode.auth_files(&env)[1], apple.join("account.json"));

        // The XDG dir wins as soon as it exists.
        let xdg = home.join(".local/share/opencode");
        std::fs::create_dir_all(&xdg).unwrap();
        assert_eq!(OpenCode.data_home(&env), Some(xdg));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn omp_home_is_under_home() {
        let home = PathBuf::from("/u/x");
        let env = MapEnv::with_home(&home);
        assert_eq!(Omp.config_home(&env), Some(home.join(".omp")));
        assert_eq!(Omp.sessions_dir(&env), Some(home.join(".omp/agent/sessions")));
        assert_eq!(Omp.models_cache(&env), Some(home.join(".omp/agent/models.db")));
        assert_eq!(Omp.config_file(&env), None);
        assert!(Omp.auth_files(&env).is_empty());
    }

    #[test]
    fn no_home_means_no_paths_not_a_relative_one() {
        let env = MapEnv(Default::default());
        for d in ALL {
            assert_eq!(d.config_home(&env), None, "{}", d.id());
            assert_eq!(d.sessions_dir(&env), None, "{}", d.id());
            assert!(d.auth_files(&env).is_empty(), "{}", d.id());
        }
    }

    #[test]
    fn the_hook_installer_and_the_gateway_agree_on_codex_config() {
        // The bug this module exists for: with CODEX_HOME set, Klide's status
        // hook went into one config.toml and the gateway un-injected another.
        let home = tmp("codex-agree");
        let moved = home.join("elsewhere");
        std::fs::create_dir_all(&moved).unwrap();
        let env = MapEnv::with_home(&home).set("CODEX_HOME", &moved);
        assert_eq!(Codex.ensure_status_hooks(&env), Ok(true));
        let hooked = moved.join("config.toml");
        assert!(
            std::fs::read_to_string(&hooked).unwrap().starts_with("notify = ["),
            "the hook landed in $CODEX_HOME"
        );
        assert!(!home.join(".codex").exists(), "nothing written under ~/.codex");
        assert_eq!(crate::gateway::codex_config_path(&env), Some(hooked));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Source-scan: no Rust file outside `delegate/` spells a CLI's home by
    /// hand. The adapter is the one place, so a moved home is honoured
    /// everywhere or nowhere.
    #[test]
    fn no_module_outside_delegate_spells_a_cli_home() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        // Paths, and *reads* of the override variables (`var("CODEX_HOME")`).
        // A test that sets one to prove the override is honoured is fine.
        let needles = [
            "\".codex", ".codex/", "\".claude", ".claude/", ".claude.json", "\".omp", ".omp/",
            ".config/opencode", "share/opencode", "Application Support/opencode",
            "\"CODEX_HOME\")", "\"CLAUDE_CONFIG_DIR\")", "\"XDG_CONFIG_HOME\")", "\"XDG_DATA_HOME\")",
        ];
        let mut offenders = Vec::new();
        let mut stack = vec![src.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|n| n == "delegate") {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                for (n, line) in text.lines().enumerate() {
                    let code = line.split("//").next().unwrap_or("");
                    if needles.iter().any(|needle| code.contains(needle)) {
                        offenders.push(format!(
                            "{}:{}: {}",
                            path.strip_prefix(&src).unwrap().display(),
                            n + 1,
                            line.trim()
                        ));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "CLI home paths spelled outside delegate/ — ask the adapter instead:\n{}",
            offenders.join("\n")
        );
    }
}
