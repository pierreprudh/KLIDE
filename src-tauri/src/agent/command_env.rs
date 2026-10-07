//! The environment a Run's commands start in.
//!
//! A command used to inherit whatever Klide itself was started with — a
//! terminal's full PATH under `tauri dev`, but a Finder-launched app gets
//! macOS's minimal one (`/usr/bin:/bin:…`), so `python3` was Apple's 3.9 and
//! Homebrew, pyenv or nvm tools were missing. Three rules now decide it:
//!
//! 1. **The login shell's environment.** Captured once per process the way a
//!    terminal would build it (`$SHELL -l -i -c env`), laid over Klide's own,
//!    so the agent's `python3` is the one you'd get typing it yourself.
//! 2. **The project's `.venv` first.** When the command's folder (or a parent,
//!    up to the repository root) has one, its `bin` leads PATH and
//!    `VIRTUAL_ENV` is set — what activating it would do, without a shell
//!    that remembers it between commands.
//! 3. **No secrets by name.** Any variable whose name contains `KEY`,
//!    `SECRET` or `TOKEN` is left out, as Codex does by default: a model's
//!    command has no business reading the credentials of the shell it runs in.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// How long a login shell may take to print its environment before Klide
/// falls back to its own. A slow `.zshrc` costs one wait, once per process.
#[cfg(not(test))]
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const MARKER: &str = "__KLIDE_ENV_BEGIN__";

static BASE: OnceLock<BTreeMap<OsString, OsString>> = OnceLock::new();

/// Capture the login environment in the background at boot, so the first
/// command of the session doesn't pay for it.
pub(crate) fn warm() {
    std::thread::spawn(|| {
        let _ = base();
    });
}

/// Klide's environment with the login shell's laid over it.
fn base() -> &'static BTreeMap<OsString, OsString> {
    BASE.get_or_init(|| {
        let mut env: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
        if let Some(login) = capture_login_env() {
            env.extend(login);
        }
        env
    })
}

/// Tests never start a login shell: the process environment is the base.
#[cfg(test)]
fn capture_login_env() -> Option<Vec<(OsString, OsString)>> {
    None
}

#[cfg(all(unix, not(test)))]
fn capture_login_env() -> Option<Vec<(OsString, OsString)>> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c"])
        .arg(format!("printf '%s' '{MARKER}'; command env -0"))
        // A dotfile can test this to skip work a command doesn't need.
        .env("KLIDE_RESOLVING_ENVIRONMENT", "1")
        .current_dir(std::env::var_os("HOME").unwrap_or_else(|| "/".into()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = std::time::Instant::now() + CAPTURE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    parse_env_dump(&reader.join().ok()?)
}

#[cfg(all(not(unix), not(test)))]
fn capture_login_env() -> Option<Vec<(OsString, OsString)>> {
    None
}

/// `…noise…MARKER K=V\0K=V\0…` → pairs. Whatever a dotfile printed before
/// the marker is ignored; shell bookkeeping is dropped.
fn parse_env_dump(out: &[u8]) -> Option<Vec<(OsString, OsString)>> {
    let marker = MARKER.as_bytes();
    let at = out.windows(marker.len()).position(|w| w == marker)?;
    let pairs: Vec<(OsString, OsString)> = out[at + marker.len()..]
        .split(|b| *b == 0)
        .filter_map(|entry| {
            let eq = entry.iter().position(|b| *b == b'=')?;
            let (name, value) = (&entry[..eq], &entry[eq + 1..]);
            if name.is_empty() {
                return None;
            }
            Some((bytes_to_os(name), bytes_to_os(value)))
        })
        .filter(|(name, _)| {
            !matches!(
                name.to_str(),
                Some("_" | "PWD" | "OLDPWD" | "SHLVL" | "KLIDE_RESOLVING_ENVIRONMENT")
            )
        })
        .collect();
    (!pairs.is_empty()).then_some(pairs)
}

#[cfg(unix)]
fn bytes_to_os(bytes: &[u8]) -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(bytes.to_vec())
}

#[cfg(not(unix))]
fn bytes_to_os(bytes: &[u8]) -> OsString {
    OsString::from(String::from_utf8_lossy(bytes).into_owned())
}

/// A variable a model's command should not see, judged by its name alone.
fn is_secret(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    ["KEY", "SECRET", "TOKEN"].iter().any(|word| name.contains(word))
}

/// The `.venv` that owns `cwd`: the nearest one walking up, stopping at the
/// repository root (a `.git` directory or a worktree's `.git` file).
pub(crate) fn project_venv(cwd: &Path) -> Option<PathBuf> {
    for dir in cwd.ancestors() {
        let venv = dir.join(".venv");
        if venv.join("pyvenv.cfg").is_file() && venv.join("bin").is_dir() {
            return Some(venv);
        }
        if dir.join(".git").exists() {
            break;
        }
    }
    None
}

/// The whole environment a command started in `cwd` gets.
pub(crate) fn env_for(cwd: &Path) -> Vec<(OsString, OsString)> {
    compose(base(), project_venv(cwd).as_deref())
}

fn compose(base: &BTreeMap<OsString, OsString>, venv: Option<&Path>) -> Vec<(OsString, OsString)> {
    let mut env: BTreeMap<OsString, OsString> = base
        .iter()
        .filter(|(name, _)| !is_secret(name))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if let Some(venv) = venv {
        let mut paths = vec![venv.join("bin")];
        if let Some(path) = env.get(OsStr::new("PATH")) {
            paths.extend(std::env::split_paths(path));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            env.insert("PATH".into(), path);
        }
        env.insert("VIRTUAL_ENV".into(), venv.as_os_str().to_owned());
        env.remove(OsStr::new("PYTHONHOME"));
    }
    env.into_iter().collect()
}

/// The Python a command will start, for the approval card — resolved with
/// the exact PATH the command gets. `None` for anything that isn't a Python
/// interpreter as its first word.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Interpreter {
    /// As PATH found it — not canonicalised, so a venv's link stays a venv.
    pub path: String,
    /// `3.12.4`, when `--version` answered in time.
    pub version: Option<String>,
    /// The venv folder the interpreter belongs to, relative to `cwd` when
    /// inside it (`.venv`, `../.venv`), else absolute.
    pub venv: Option<String>,
}

pub(crate) fn interpreter_for(cwd: &Path, command: &str) -> Option<Interpreter> {
    let program = command.split_whitespace().next()?;
    let name = program.rsplit('/').next().unwrap_or(program);
    if !is_python_name(name) {
        return None;
    }
    let venv = project_venv(cwd);
    let env = compose(base(), venv.as_deref());
    let path = if program.contains('/') {
        let candidate = cwd.join(program);
        crate::cli::is_executable_file(&candidate).then_some(candidate)?
    } else {
        let path_var = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone())?;
        std::env::split_paths(&path_var)
            .map(|dir| dir.join(name))
            .find(|candidate| crate::cli::is_executable_file(candidate))?
    };
    let venv_label = venv.filter(|v| path.starts_with(v)).map(|v| relative_label(cwd, &v));
    Some(Interpreter {
        version: python_version(&path, &env),
        path: path.to_string_lossy().into_owned(),
        venv: venv_label,
    })
}

/// `python`, `python3`, `python3.12`.
fn is_python_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("python") else { return false };
    rest.is_empty()
        || rest == "3"
        || rest
            .strip_prefix("3.")
            .is_some_and(|minor| !minor.is_empty() && minor.bytes().all(|b| b.is_ascii_digit()))
}

fn relative_label(cwd: &Path, venv: &Path) -> String {
    let mut ups = 0;
    for dir in cwd.ancestors() {
        if let Ok(rest) = venv.strip_prefix(dir) {
            let rest = rest.to_string_lossy();
            return if ups == 0 { rest.into_owned() } else { format!("{}{rest}", "../".repeat(ups)) };
        }
        ups += 1;
    }
    venv.to_string_lossy().into_owned()
}

fn python_version(path: &Path, env: &[(OsString, OsString)]) -> Option<String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(path)
        .arg("--version")
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + VERSION_TIMEOUT;
    while child.try_wait().ok()?.is_none() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let out = child.wait_with_output().ok()?;
    // Python 2 printed its version to stderr.
    let text = [out.stdout, out.stderr].concat();
    let text = String::from_utf8_lossy(&text);
    text.split_whitespace()
        .skip_while(|word| *word != "Python")
        .nth(1)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_with(pairs: &[(&str, &str)]) -> BTreeMap<OsString, OsString> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    /// A fresh scratch folder under the system temp dir, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("klide-command-env-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir.canonicalize().unwrap())
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn get<'a>(env: &'a [(OsString, OsString)], name: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == name).and_then(|(_, v)| v.to_str())
    }

    #[test]
    fn variables_named_like_secrets_are_left_out() {
        let env = compose(
            &base_with(&[
                ("PATH", "/usr/bin"),
                ("OPENAI_API_KEY", "sk-1"),
                ("GH_TOKEN", "t"),
                ("aws_secret_access_key", "s"),
                ("HOME", "/Users/me"),
            ]),
            None,
        );
        assert_eq!(get(&env, "PATH"), Some("/usr/bin"));
        assert_eq!(get(&env, "HOME"), Some("/Users/me"));
        assert!(get(&env, "OPENAI_API_KEY").is_none());
        assert!(get(&env, "GH_TOKEN").is_none());
        assert!(get(&env, "aws_secret_access_key").is_none());
    }

    #[test]
    fn a_project_venv_leads_path_and_is_announced() {
        let dir = Scratch::new("venv");
        let root = dir.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::fs::write(root.join(".venv/pyvenv.cfg"), "home = /usr/bin\n").unwrap();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();

        let venv = project_venv(&root.join("src/deep")).expect("found from a subfolder");
        assert_eq!(venv, root.join(".venv"));
        let env = compose(&base_with(&[("PATH", "/usr/bin"), ("PYTHONHOME", "/x")]), Some(&venv));
        let path = get(&env, "PATH").unwrap();
        assert!(path.starts_with(&format!("{}:", root.join(".venv/bin").display())), "{path}");
        assert!(path.ends_with(":/usr/bin"));
        assert_eq!(get(&env, "VIRTUAL_ENV"), venv.to_str());
        assert!(get(&env, "PYTHONHOME").is_none());
    }

    #[test]
    fn the_venv_search_stops_at_the_repository_root() {
        let dir = Scratch::new("stop");
        std::fs::create_dir_all(dir.path().join(".venv/bin")).unwrap();
        std::fs::write(dir.path().join(".venv/pyvenv.cfg"), "").unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".git"), "gitdir: elsewhere\n").unwrap();
        assert_eq!(project_venv(&repo), None);
    }

    #[test]
    fn the_login_dump_is_read_after_the_marker() {
        let dump = format!("motd noise\n{MARKER}PATH=/opt/homebrew/bin:/usr/bin\0EQ=a=b\0SHLVL=2\0_=/usr/bin/env\0");
        let pairs = parse_env_dump(dump.as_bytes()).unwrap();
        assert_eq!(
            pairs,
            vec![
                (OsString::from("PATH"), OsString::from("/opt/homebrew/bin:/usr/bin")),
                (OsString::from("EQ"), OsString::from("a=b")),
            ]
        );
        assert!(parse_env_dump(b"no marker here").is_none());
    }

    #[test]
    fn only_python_interpreters_are_named() {
        for name in ["python", "python3", "python3.12"] {
            assert!(is_python_name(name), "{name}");
        }
        for name in ["python2", "python3.", "pythonista", "py", "node"] {
            assert!(!is_python_name(name), "{name}");
        }
        assert_eq!(interpreter_for(Path::new("/"), "git status"), None);
    }

    #[test]
    fn a_venv_label_is_relative_to_the_command_folder() {
        assert_eq!(relative_label(Path::new("/p"), Path::new("/p/.venv")), ".venv");
        assert_eq!(relative_label(Path::new("/p/src"), Path::new("/p/.venv")), "../.venv");
    }
}
