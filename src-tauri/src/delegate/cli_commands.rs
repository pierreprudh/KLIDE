//! The `/` commands a delegate CLI answers itself, so Klide's composer can
//! offer them.
//!
//! Claude Code already knows its own menu — built-ins (`/compact`, `/context`,
//! `/model`), the user's skills, plugin commands — and names it on the first
//! line of every headless turn (`system`/`init`: `slash_commands`, and apart
//! from them the `terminal_slash_commands` that only work in its TUI). Reading
//! that list is the whole source of truth; nothing here re-discovers
//! `~/.claude` on its own and drifts from what the CLI would accept.
//!
//! The list is remembered per (delegate, workspace) because project skills and
//! commands differ by folder. It is refreshed by every real turn, and primed
//! once — before a conversation has had a turn — by a probe that starts the CLI
//! only long enough to read that first line.
//!
//! In memory on purpose, like the session map in `chat.rs`: losing it costs one
//! probe on the next `/`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use super::Delegate;

/// What the CLI said it answers, as it said it.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCommands {
    /// Commands a headless turn can run — sent as the message, verbatim.
    pub commands: Vec<String>,
    /// Commands that need the CLI's own terminal UI.
    pub terminal: Vec<String>,
    /// What the CLI says a command does, when it says (omp does, Claude Code
    /// does not).
    #[serde(default)]
    pub descriptions: std::collections::BTreeMap<String, String>,
}

/// How to ask one CLI for its commands without starting a model turn: a
/// process, what to write on its stdin, and the adapter's
/// [`Delegate::parse_probe_line`] to read its answer.
pub struct SlashProbe {
    pub command: tokio::process::Command,
    pub stdin: Vec<u8>,
}

impl CliCommands {
    /// Whether `name` (without its slash) is something a headless turn runs.
    pub fn runs(&self, name: &str) -> bool {
        !self.terminal.iter().any(|c| c == name) && self.commands.iter().any(|c| c == name)
    }
}

static KNOWN: OnceLock<Mutex<HashMap<String, CliCommands>>> = OnceLock::new();

fn known() -> &'static Mutex<HashMap<String, CliCommands>> {
    KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(provider: &str, cwd: &str) -> String {
    format!("{provider}:{}", super::normalize_path(cwd))
}

pub(crate) fn remember(provider: &str, cwd: &str, commands: CliCommands) {
    if let Ok(mut map) = known().lock() {
        map.insert(key(provider, cwd), commands);
    }
}

pub(crate) fn remembered(provider: &str, cwd: &str) -> Option<CliCommands> {
    known().lock().ok()?.get(&key(provider, cwd)).cloned()
}

/// The command a message opens with, when the CLI said it runs it headless:
/// `/compact` or `/review focus on auth` → `compact` / `review`. A path
/// (`/src/App.tsx`) or an unknown word is not a command, and the message is
/// folded into the prompt as usual.
pub(crate) fn leading_command(provider: &str, cwd: &str, message: &str) -> Option<String> {
    let word = message.trim_start().strip_prefix('/')?.split_whitespace().next()?;
    let known = remembered(provider, cwd)?;
    known.runs(word).then(|| word.to_string())
}

/// How long the probe may take to reach the CLI's first line. Hooks run before
/// it (SessionStart), so this is generous.
const PROBE_CEILING: Duration = Duration::from_secs(20);

/// The CLI's commands for `cwd`, probing it once when nothing has reported
/// them yet. A delegate with no probe answers empty without being started —
/// a probe prompt sent to a CLI that does not recognise it would be a real
/// model turn.
pub async fn cli_commands(adapter: &dyn Delegate, cwd: &str) -> Result<CliCommands, String> {
    let Some(probe) = adapter.slash_command_probe(cwd) else {
        return Ok(CliCommands::default());
    };
    if let Some(known) = remembered(adapter.id(), cwd) {
        return Ok(known);
    }
    let SlashProbe { mut command, stdin } = probe?;
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("Unable to start {}: {e}", adapter.id()))?;
    if let Some(mut pipe) = child.stdin.take() {
        pipe.write_all(&stdin).await.map_err(|e| e.to_string())?;
    }
    let stdout = child.stdout.take().ok_or("Unable to read the CLI's output")?;
    let found = timeout(PROBE_CEILING, async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(commands) = adapter.parse_probe_line(&line) {
                return Some(commands);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let _ = child.kill().await;
    let commands = found.ok_or("The CLI did not list its commands")?;
    remember(adapter.id(), cwd, commands.clone());
    Ok(commands)
}

/// Claude Code's current settings, as far as its own files say — for marking
/// the chosen value in the composer's `/config` card. `/config` itself can
/// only set, never read back, so this reads the four files it writes, later
/// ones winning: `~/.claude.json`, `~/.claude/settings.json`, then the
/// project's `.claude/settings.json` and `.claude/settings.local.json`.
///
/// Top-level scalars only, keyed exactly as found. A setting the CLI stores
/// under another name simply has no current value; nothing here maps names.
pub fn claude_code_settings(home: &str, cwd: &str) -> HashMap<String, serde_json::Value> {
    let cwd = super::normalize_path(cwd);
    let files = [
        format!("{home}/.claude.json"),
        format!("{home}/.claude/settings.json"),
        format!("{cwd}/.claude/settings.json"),
        format!("{cwd}/.claude/settings.local.json"),
    ];
    let mut out = HashMap::new();
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        for (key, value) in map {
            if matches!(value, serde_json::Value::Bool(_) | serde_json::Value::String(_) | serde_json::Value::Number(_)) {
                out.insert(key, value);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live: starts the real CLIs. `cargo test --lib live_probe -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_probe_lists_each_clis_commands() {
        for adapter in [&super::super::ClaudeCode as &dyn Delegate, &super::super::Omp] {
            let got = cli_commands(adapter, env!("CARGO_MANIFEST_DIR")).await.unwrap();
            let runnable: Vec<_> = got.commands.iter().filter(|c| got.runs(c)).collect();
            println!("{}: {} listed, {} runnable, {} described: {:?}", adapter.id(), got.commands.len(), runnable.len(), got.descriptions.len(), &runnable[..runnable.len().min(12)]);
            assert!(!runnable.is_empty());
        }
    }

    #[test]
    fn only_a_known_headless_command_counts_as_one() {
        let cwd = "/tmp/klide-cli-commands-test";
        remember("claude-code", cwd, CliCommands {
            commands: vec!["compact".into(), "review".into(), "config".into()],
            terminal: vec!["config".into()],
            ..Default::default()
        });
        assert_eq!(leading_command("claude-code", cwd, "/compact"), Some("compact".into()));
        assert_eq!(leading_command("claude-code", cwd, "  /review the auth flow"), Some("review".into()));
        // A TUI-only command, a path, prose and another delegate are all prose.
        assert_eq!(leading_command("claude-code", cwd, "/config"), None);
        assert_eq!(leading_command("claude-code", cwd, "/src/App.tsx is broken"), None);
        assert_eq!(leading_command("claude-code", cwd, "please /compact"), None);
        assert_eq!(leading_command("codex", cwd, "/compact"), None);
        // The workspace key ignores a trailing slash.
        assert_eq!(leading_command("claude-code", &format!("{cwd}/"), "/compact"), Some("compact".into()));
    }

    #[test]
    fn settings_read_later_files_over_earlier_ones_and_keep_scalars_only() {
        let root = std::env::temp_dir().join(format!("klide-cc-settings-{}", std::process::id()));
        let (home, ws) = (root.join("home"), root.join("ws"));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(ws.join(".claude")).unwrap();
        std::fs::write(home.join(".claude.json"), r#"{"theme":"dark","autoConnectIde":true,"projects":{}}"#).unwrap();
        std::fs::write(home.join(".claude/settings.json"), r#"{"model":"opus","verbose":false}"#).unwrap();
        std::fs::write(ws.join(".claude/settings.local.json"), r#"{"model":"sonnet"}"#).unwrap();
        let got = claude_code_settings(home.to_str().unwrap(), ws.to_str().unwrap());
        assert_eq!(got.get("theme"), Some(&serde_json::json!("dark")));
        assert_eq!(got.get("verbose"), Some(&serde_json::json!(false)));
        assert_eq!(got.get("model"), Some(&serde_json::json!("sonnet")));
        assert!(!got.contains_key("projects"));
        let _ = std::fs::remove_dir_all(root);
    }
}
