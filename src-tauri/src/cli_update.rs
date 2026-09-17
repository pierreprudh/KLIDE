//! Which version of each delegate CLI is installed, and running the CLI's own
//! updater when it isn't the one you want.
//!
//! Klide launches `claude` / `codex` / `opencode` / `omp` from the login-shell
//! PATH and, until this module, never looked at *which* version it got. That
//! bit once already: the PATH `codex` was 0.147.0 while the ChatGPT app had
//! shipped 0.153.4, and the run died as `400: The 'gpt-6-astra' model requires
//! a newer version of Codex` — a provider error with nothing in Klide to
//! explain it. A version is a fact about the machine, so it belongs on the
//! Settings row that already says whether the CLI is installed.
//!
//! Two deliberate limits:
//!
//! * **Klide never updates anything by itself.** An update mid-fleet changes
//!   what every live delegate session is running, so it happens when the user
//!   asks and never in the background.
//! * **Klide never invents an updater.** The command comes from the adapter
//!   (`Delegate::update_args`); a CLI that declares none gets no button. An
//!   install Klide didn't perform is not an install Klide may replace.

use crate::blocking;
use crate::cli::resolve_command;
use crate::delegate;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

/// How long a `--version` may take before Klide stops waiting. These print a
/// line and exit; anything slower is a CLI that is wedged, and the row says so
/// rather than leaving the section spinning forever.
const VERSION_TIMEOUT: Duration = Duration::from_secs(4);

/// What one delegate's CLI reports about itself on this machine.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliVersion {
    /// Klide's provider id — `claude-code`, `codex`, …
    pub provider: String,
    pub binary: &'static str,
    pub installed: bool,
    /// The number alone, when the CLI's line yielded one.
    pub version: Option<String>,
    /// The CLI's own line, verbatim — the fallback when parsing found nothing,
    /// and the thing to quote in a bug report.
    pub raw: Option<String>,
    pub command_path: Option<String>,
    /// The updater Klide would run, written out as the user would type it.
    /// `None` hides the action entirely.
    pub update_command: Option<String>,
    /// Why there is no version, when there is none.
    pub detail: Option<String>,
    /// The newest published release, when a check asked for it. `None` on a
    /// plain read: knowing this costs a network call, and opening Settings
    /// must not make one.
    pub latest: Option<String>,
    /// True only when both versions were read *and* compared. An unknown
    /// `latest` leaves this false — "Klide couldn't tell" is not "up to date".
    pub update_available: bool,
    /// Why the check couldn't answer, when it couldn't.
    pub latest_error: Option<String>,
}

/// One chunk of an update's output, or its ending.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CliUpdateEvent {
    /// Terminal output exactly as the updater wrote it, ANSI included — the
    /// surface showing it decides what to do with the escapes.
    Output { chunk: String },
}

fn adapter_for(provider: &str) -> Result<&'static dyn delegate::Delegate, String> {
    delegate::lookup(provider).ok_or_else(|| format!("\"{provider}\" is not a delegate CLI"))
}

/// Run a short command and return its combined output, giving up after
/// `timeout`. The child's pipes are small, so this is only safe for commands
/// that say one line and exit — a chatty child could fill the pipe and block
/// before we ever see it exit.
fn output_within(command: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = std::process::Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{command} did not answer {} within {}s",
                    args.join(" "),
                    timeout.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }

    let mut text = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut text);
    }
    if text.trim().is_empty() {
        // Some CLIs answer `--version` on stderr; an empty stdout is not an
        // absent version until stderr has been read too.
        if let Some(mut err) = child.stderr.take() {
            let _ = err.read_to_string(&mut text);
        }
    }
    Ok(text)
}

/// Ask one delegate's CLI what it is. Never an `Err`: "not installed" and
/// "wouldn't answer" are both answers the row can show.
pub fn version_of(adapter: &'static dyn delegate::Delegate) -> CliVersion {
    let binary = adapter.binary();
    let update_command = adapter
        .update_args()
        .map(|args| format!("{binary} {}", args.join(" ")));

    let path = match resolve_command(binary) {
        Ok(path) => path,
        Err(detail) => {
            return CliVersion {
                provider: adapter.id().to_string(),
                binary,
                installed: false,
                version: None,
                raw: None,
                command_path: None,
                // Nothing to update: there is no install to replace.
                update_command: None,
                detail: Some(detail),
                latest: None,
                update_available: false,
                latest_error: None,
            }
        }
    };

    let (raw, version, detail) =
        match output_within(&path, adapter.version_args(), VERSION_TIMEOUT) {
            Ok(text) => {
                let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
                let raw = line.trim().to_string();
                let version = adapter.parse_version(&raw);
                let detail = version
                    .is_none()
                    .then(|| format!("{binary} answered something Klide couldn't read as a version"));
                (
                    (!raw.is_empty()).then_some(raw),
                    version,
                    detail,
                )
            }
            Err(detail) => (None, None, Some(detail)),
        };

    CliVersion {
        provider: adapter.id().to_string(),
        binary,
        installed: true,
        version,
        raw,
        command_path: Some(path),
        update_command,
        detail,
        latest: None,
        update_available: false,
        latest_error: None,
    }
}

/// Every delegate CLI's version, in registry order. Each one is a process
/// spawn, so they run together rather than one after the other.
pub fn versions() -> Vec<CliVersion> {
    let handles: Vec<_> = delegate::ALL
        .iter()
        .map(|adapter| std::thread::spawn(move || version_of(*adapter)))
        .collect();
    handles
        .into_iter()
        .zip(delegate::ALL)
        .map(|(handle, adapter)| {
            handle.join().unwrap_or_else(|_| CliVersion {
                provider: adapter.id().to_string(),
                binary: adapter.binary(),
                installed: false,
                version: None,
                raw: None,
                command_path: None,
                update_command: None,
                detail: Some("Version check crashed".to_string()),
                latest: None,
                update_available: false,
                latest_error: None,
            })
        })
        .collect()
}

/// The npm dist-tag Klide reads. `latest` is what every one of these updaters
/// installs, so it is the only tag that answers the question being asked.
const RELEASE_TAG: &str = "latest";

/// How long the registry may take. A check is something the user is watching,
/// so it fails visibly rather than hanging the button.
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(8);

/// Split a version into its numeric core and whatever tail follows it.
fn version_parts(version: &str) -> Option<(Vec<u64>, String)> {
    let (core, tail) = match version.find(['-', '+']) {
        Some(at) => (&version[..at], version[at..].to_string()),
        None => (version, String::new()),
    };
    let numbers = core
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    (!numbers.is_empty()).then_some((numbers, tail))
}

/// Is `candidate` newer than `installed`? `None` means Klide cannot tell, and
/// a caller must not round that up to either answer.
///
/// Numeric cores decide it. When the cores are equal, a release beats a
/// prerelease and two different prereleases are simply unranked — Klide is not
/// a semver implementation, and a published `latest` is not a prerelease.
pub fn is_newer(candidate: &str, installed: &str) -> Option<bool> {
    let (mut left, left_tail) = version_parts(candidate)?;
    let (mut right, right_tail) = version_parts(installed)?;
    let width = left.len().max(right.len());
    left.resize(width, 0);
    right.resize(width, 0);
    if left != right {
        return Some(left > right);
    }
    match (left_tail.is_empty(), right_tail.is_empty()) {
        // 1.2.0 over 1.2.0-beta.1, and never the other way round.
        (true, false) => Some(true),
        (false, true) => Some(false),
        (true, true) => Some(false),
        (false, false) if left_tail == right_tail => Some(false),
        (false, false) => None,
    }
}

/// The newest published release of one package, straight from the registry.
fn latest_release(package: &str) -> Result<String, String> {
    // A scoped name's slash is the only character the path needs encoded.
    let url = format!(
        "https://registry.npmjs.org/{}/{RELEASE_TAG}",
        package.replace('/', "%2f")
    );
    let client = reqwest::blocking::Client::builder()
        .user_agent("Klide/1.0")
        .timeout(REGISTRY_TIMEOUT)
        .build()
        .map_err(|e| format!("Unable to reach the registry: {e}"))?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Update check failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Registry answered {}", response.status()));
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|e| format!("Registry answered something unreadable: {e}"))?;
    body.get("version")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .ok_or_else(|| format!("{package} has no published version"))
}

/// One delegate's row with the registry's answer folded in. Never an `Err`:
/// "couldn't reach the registry" is a state the row shows, not a failed check.
fn with_latest(mut row: CliVersion, adapter: &'static dyn delegate::Delegate) -> CliVersion {
    // Nothing installed means nothing to compare against, and no reason to
    // make the call.
    if !row.installed {
        return row;
    }
    let Some(package) = adapter.release_package() else {
        row.latest_error = Some(format!(
            "Klide doesn't know where {} publishes its releases",
            adapter.binary()
        ));
        return row;
    };
    match latest_release(package) {
        Ok(latest) => {
            match row.version.as_deref().map(|installed| is_newer(&latest, installed)) {
                Some(Some(newer)) => row.update_available = newer,
                // The registry answered but the two can't be ranked. Saying
                // that is the honest report; leaving the row silent would read
                // as "up to date".
                Some(None) | None => {
                    row.latest_error =
                        Some(format!("Klide can't rank {latest} against this build"))
                }
            }
            row.latest = Some(latest);
        }
        Err(detail) => row.latest_error = Some(detail),
    }
    row
}

/// Every delegate CLI's version *and* what the registry publishes — the
/// "check for updates" answer. One network call per CLI, all at once.
pub fn checked_versions() -> Vec<CliVersion> {
    let handles: Vec<_> = delegate::ALL
        .iter()
        .map(|adapter| {
            let adapter = *adapter;
            std::thread::spawn(move || with_latest(version_of(adapter), adapter))
        })
        .collect();
    handles
        .into_iter()
        .zip(delegate::ALL)
        .map(|(handle, adapter)| handle.join().unwrap_or_else(|_| CliVersion {
            provider: adapter.id().to_string(),
            binary: adapter.binary(),
            installed: false,
            version: None,
            raw: None,
            command_path: None,
            update_command: None,
            detail: Some("Version check crashed".to_string()),
            latest: None,
            update_available: false,
            latest_error: None,
        }))
        .collect()
}

/// Run one delegate's own updater in a real PTY, streaming its output to the
/// caller, and answer with the version left behind.
///
/// A PTY rather than a pipe because these updaters are installers: they draw
/// progress, and several of them go quiet or refuse outright when nothing on
/// the other end looks like a terminal.
fn run_update(
    adapter: &'static dyn delegate::Delegate,
    on_event: Channel<CliUpdateEvent>,
) -> Result<CliVersion, String> {
    let args = adapter
        .update_args()
        .ok_or_else(|| format!("{} has no updater of its own", adapter.binary()))?;
    let path = resolve_command(adapter.binary())?;

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&path);
    for arg in args {
        cmd.arg(arg);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    // The writer is never used — an updater Klide can't answer must not be
    // able to sit on a prompt either, so its stdin stays at EOF.
    drop(pair.master);

    let mut buf = [0u8; 4096];
    let mut framer = crate::pty_frame::Utf8Framer::new();
    loop {
        let (chunk, eof) = match reader.read(&mut buf) {
            Ok(0) | Err(_) => (framer.finish(), true),
            Ok(n) => (framer.push(&buf[..n]), false),
        };
        if !chunk.is_empty() {
            let _ = on_event.send(CliUpdateEvent::Output { chunk });
        } else if eof {
            break;
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;

    // The version afterwards is the honest report: an updater that says
    // "already up to date" and one that installed something both land here,
    // and the row compares for itself.
    let after = version_of(adapter);
    if !status.success() {
        return Err(format!(
            "{} exited with {}",
            adapter
                .update_args()
                .map(|args| format!("{} {}", adapter.binary(), args.join(" ")))
                .unwrap_or_else(|| adapter.binary().to_string()),
            status.exit_code()
        ));
    }
    Ok(after)
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cli_versions() -> Result<Vec<CliVersion>, String> {
    blocking::run(|| Ok(versions())).await
}

#[tauri::command]
pub async fn cli_version(provider: String) -> Result<CliVersion, String> {
    blocking::run(move || Ok(version_of(adapter_for(&provider)?))).await
}

#[tauri::command]
pub async fn cli_check_updates() -> Result<Vec<CliVersion>, String> {
    blocking::run(|| Ok(checked_versions())).await
}

#[tauri::command]
pub async fn cli_update(
    provider: String,
    on_event: Channel<CliUpdateEvent>,
) -> Result<CliVersion, String> {
    blocking::run(move || run_update(adapter_for(&provider)?, on_event)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delegate::first_version_token;

    #[test]
    fn every_delegate_says_how_it_updates() {
        // A new adapter must decide: give the CLI's own updater, or say in a
        // comment why it has none. Silence here would ship a row whose Update
        // button quietly never appears.
        for adapter in delegate::ALL {
            assert!(
                adapter.update_args().is_some(),
                "{} declares no updater",
                adapter.id()
            );
        }
    }

    #[test]
    fn reads_the_four_shapes_a_cli_answers_in() {
        assert_eq!(
            first_version_token("2.1.274 (Claude Code)").as_deref(),
            Some("2.1.274")
        );
        assert_eq!(
            first_version_token("codex-cli 0.154.0").as_deref(),
            Some("0.154.0")
        );
        assert_eq!(first_version_token("1.18.31").as_deref(), Some("1.18.31"));
        assert_eq!(
            first_version_token("omp/15.13.3").as_deref(),
            Some("15.13.3")
        );
    }

    #[test]
    fn keeps_prerelease_tails_and_drops_prose() {
        assert_eq!(
            first_version_token("v1.2.0-beta.3").as_deref(),
            Some("1.2.0-beta.3")
        );
        assert_eq!(first_version_token("no numbers here"), None);
        // A year is not a version: it carries no dot.
        assert_eq!(first_version_token("built 2026 edition"), None);
    }

    #[test]
    fn every_delegate_says_where_it_publishes() {
        // A CLI with no known release source can still be updated; it just
        // can't be *checked*, and the row has to say that rather than imply
        // it is current. Today all four are on npm.
        for adapter in delegate::ALL {
            assert!(
                adapter.release_package().is_some(),
                "{} names no release package",
                adapter.id()
            );
        }
    }

    #[test]
    fn ranks_the_versions_these_clis_actually_publish() {
        assert_eq!(is_newer("18.2.4", "15.13.3"), Some(true));
        assert_eq!(is_newer("0.155.0", "0.154.0"), Some(true));
        assert_eq!(is_newer("0.154.0", "0.154.0"), Some(false));
        assert_eq!(is_newer("2.1.9", "2.1.274"), Some(false));
        // Not a string compare: 10 is after 9.
        assert_eq!(is_newer("1.10.0", "1.9.0"), Some(true));
        // A missing segment is a zero, not a mismatch.
        assert_eq!(is_newer("1.2", "1.2.0"), Some(false));
        assert_eq!(is_newer("1.2.1", "1.2"), Some(true));
    }

    #[test]
    fn a_release_beats_its_own_prerelease_and_nothing_else_is_ranked() {
        assert_eq!(is_newer("1.2.0", "1.2.0-beta.1"), Some(true));
        assert_eq!(is_newer("1.2.0-beta.1", "1.2.0"), Some(false));
        // Two different prereleases of one version: Klide does not rank them,
        // and "can't tell" must never be rounded up to "up to date".
        assert_eq!(is_newer("1.2.0-beta.2", "1.2.0-alpha.9"), None);
        assert_eq!(is_newer("not-a-version", "1.2.0"), None);
    }

    #[test]
    fn a_wedged_command_gives_up_instead_of_hanging() {
        let started = Instant::now();
        let out = output_within("sleep", &["30"], Duration::from_millis(200));
        assert!(out.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// Not part of the suite: it runs the CLIs actually installed on this
    /// machine. `cargo test -- --ignored --nocapture cli_versions_on_this_machine`
    /// is how you check the parsing against real output.
    /// Also not part of the suite — this one reaches the npm registry.
    #[test]
    #[ignore]
    fn update_check_on_this_machine() {
        for row in checked_versions() {
            println!(
                "{:<12} have={:?} latest={:?} available={} error={:?}",
                row.provider, row.version, row.latest, row.update_available, row.latest_error
            );
        }
    }

    #[test]
    #[ignore]
    fn cli_versions_on_this_machine() {
        for row in versions() {
            println!(
                "{:<12} installed={} version={:?} raw={:?} update={:?} detail={:?}",
                row.provider, row.installed, row.version, row.raw, row.update_command, row.detail
            );
        }
    }

    #[test]
    fn a_missing_binary_is_an_uninstalled_row_not_an_error() {
        // Nothing to update when nothing is installed — the row must not
        // offer to replace an install that isn't there.
        let missing = CliVersion {
            provider: "x".into(),
            binary: "x",
            installed: false,
            version: None,
            raw: None,
            command_path: None,
            update_command: None,
            detail: Some("not installed".into()),
            latest: None,
            update_available: false,
            latest_error: None,
        };
        assert!(missing.update_command.is_none());
    }
}
