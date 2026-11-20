//! Vibe — Mistral's CLI (`vibe`). The TUI takes an optional positional
//! prompt (`vibe [PROMPT]`); headless one-shots are `vibe -p TEXT --output
//! text` and resume is `vibe --resume <SESSION_ID>`.
//!
//! On-disk layout, all under the Vibe home (`$VIBE_HOME`, else `~/.vibe`):
//!   • `config.toml` — user config (MCP servers live in `[[mcp_servers]]`).
//!   • `logs/session/unified/<session-id>/` — one directory per session:
//!     `meta.json` (id, cwd, title, model, start/end), `chunks/*.json`
//!     (the materialized message history), `journal/*.jsonl` (the recovery
//!     event log), `CURRENT` (pointer at the newest chunk). `child-*`
//!     directories are subagent sessions of a parent run, not board rows.
//!   • `model_catalog_cache.json` — the model list keyed by account.
//!   • `whoami_cache.json` — non-secret login identity (plan, customer id).
//!
//! The OAuth tokens themselves ride the OS keyring (see `accounts.rs`), so
//! `auth_files` is empty — like Claude Code, listing never touches the
//! keychain; only capture does. `$VIBE_HOME/.env` may hold API keys and is
//! treated as secret.

use super::runs::{
    cap_messages, clean_title, mtime_ms, project_name, transcript_status, TranscriptState,
};
use super::chat::KLIDE_PREAMBLE;
use super::{shell_quote, AgentRun, Delegate, Env, RunCandidate, RunMessage, RunParser};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct Vibe;

impl Delegate for Vibe {
    fn id(&self) -> &'static str {
        "vibe"
    }

    fn binary(&self) -> &'static str {
        "vibe"
    }

    fn label(&self) -> &'static str {
        "Vibe"
    }

    /// `$VIBE_HOME`, or `~/.vibe` — the one variable the CLI itself reads for
    /// every user-level path (config, logs, sessions).
    fn config_home(&self, env: &dyn Env) -> Option<PathBuf> {
        super::home::overridable(env, "VIBE_HOME", ".vibe")
    }

    /// Sessions are directories under `logs/session/unified`.
    fn sessions_dir(&self, env: &dyn Env) -> Option<PathBuf> {
        self.config_home(env)
            .map(|d| d.join("logs").join("session").join("unified"))
    }

    fn config_file(&self, env: &dyn Env) -> Option<PathBuf> {
        self.config_home(env).map(|d| d.join("config.toml"))
    }

    /// Keyring-based login: no plaintext auth file to snapshot (Claude Code's
    /// posture). The account switcher reads identity from `whoami_cache.json`.
    fn auth_files(&self, _env: &dyn Env) -> Vec<PathBuf> {
        Vec::new()
    }

    /// `.env` can hold API keys; `whoami_cache.json` is non-secret but still
    /// names the logged-in account, so both stay out of the command sandbox.
    fn secret_files(&self, env: &dyn Env) -> Vec<PathBuf> {
        self.config_home(env)
            .map(|d| vec![d.join(".env"), d.join("whoami_cache.json")])
            .unwrap_or_default()
    }

    /// The model list the CLI cached from the account's catalogue.
    fn models_cache(&self, env: &dyn Env) -> Option<PathBuf> {
        self.config_home(env)
            .map(|d| d.join("model_catalog_cache.json"))
    }

    fn supports_accounts(&self) -> bool {
        true
    }

    fn model_arg(&self, model: &str) -> String {
        format!(
            " --model {}",
            shell_quote(
                &crate::harness_source::cli_model("vibe", model).unwrap_or_else(|_| model.into())
            )
        )
    }

    /// `vibe --resume <id>` reopens a recorded session.
    fn resume_arg(&self, session_id: &str) -> String {
        format!(" --resume {}", shell_quote(session_id))
    }

    /// Vibe has no per-run effort flag (thinking level is a config/`/thinking`
    /// setting), so Klide never invents one.
    fn effort_arg(&self, _level: &str) -> Option<String> {
        None
    }

    /// One-shot Mission dispatch: `vibe -p <task>` exits after the turn.
    /// `--trust` skips the cwd trust prompt for this invocation only, the
    /// same posture Codex's `workspace-write` sandbox carries.
    fn mission_command(&self, task: Option<&str>, model: Option<&str>) -> Result<String, String> {
        if let Some(model) = model {
            crate::harness_source::cli_model(self.id(), model)?;
        }
        let task = self.mission_task(task)?;
        let model_arg = self.mission_model_arg(model);
        Ok(format!(
            "vibe -p{model_arg} --trust --output text {}",
            shell_quote(task)
        ))
    }

    /// Headless prose turn. `vibe -p` takes its prompt as a value, not from
    /// stdin, so — like Cursor's positional prompt — the invocation moves
    /// stdin into the `-p` argument with a shell wrapper that never evaluates
    /// the prompt text.
    fn chat_args(&self, _cwd: &str, model: &str) -> Result<Vec<String>, String> {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--trust".into(),
            "--output".into(),
            "text".into(),
        ];
        let model = crate::harness_source::cli_model(self.id(), model)?;
        if !model.trim().is_empty() && !model.eq_ignore_ascii_case(super::CLI_DEFAULT_MODEL) {
            args.extend(["--model".into(), model]);
        }
        Ok(args)
    }

    fn chat_invocation(&self, cwd: &str, model: &str) -> Result<tokio::process::Command, String> {
        let cli = crate::cli::resolve_command(self.binary())?;
        let args = self.chat_args(cwd, model)?;
        // `vibe -p` wants the prompt as the flag's value; the runner pipes the
        // conversation's newest message on stdin, so read it into a shell
        // variable and hand it to `-p` as one argument.
        let mut command = tokio::process::Command::new("sh");
        command
            .args([
                "-c",
                "prompt=$(cat); exec \"$@\" -p \"$prompt\"",
                "klide-vibe",
            ])
            .arg(&cli)
            .args(&args[1..]); // skip the placeholder "-p"; the wrapper supplies its value
        command.current_dir(cwd).envs(self.headless_env());
        let env = self.chat_source_env(cwd, model)?;
        command.args(self.chat_source_args(model, &env)?).envs(env);
        Ok(command)
    }

    /// Not yet: the headless turn (`chat_invocation`) never passes
    /// `--resume`, and a runner told the CLI resumes sends only the newest
    /// message — so claiming it would drop every earlier turn. Klide folds the
    /// whole conversation into each turn instead.
    fn resumes_sessions(&self) -> bool {
        false
    }

    /// Launching the CLI is the login: first run opens the browser sign-in
    /// flow. There is no separate `login` subcommand to copy.
    fn login_commands(&self) -> Vec<String> {
        vec!["vibe".to_string()]
    }

    /// No `auth status` subcommand exists. The CLI authenticates from its
    /// keychain entry (`ai.mistral.vibe` / legacy `vibe`, account
    /// `oidc:v1:<sha>`) or an API key in the environment — so that is what
    /// "connected" means here. The non-secret `whoami_cache.json` only adds
    /// the identity label; Vibe Desktop's own sign-in does not live in the
    /// keychain, so its cache alone is not proof the CLI can run.
    fn check_auth(&self, _command_path: &str) -> Result<(bool, String), String> {
        let Some(home) = self.config_home(&super::ProcessEnv) else {
            return Ok((false, "Could not resolve home directory".to_string()));
        };
        let cache = home.join("whoami_cache.json");
        let whoami = std::fs::read(&cache).ok().and_then(|b| {
            let v: Value = serde_json::from_slice(&b).ok()?;
            let (key, entry) = v.as_object()?.iter().next()?;
            Some((key.clone(), entry.get("payload")?.clone()))
        });
        let env_key = ["MISTRAL_API_KEY", "MISTRAL_CLIENT_API_KEY"]
            .iter()
            .any(|k| std::env::var(k).is_ok_and(|v| !v.is_empty()));
        let keychain_token = whoami
            .as_ref()
            .map(|(oidc_key, _)| {
                ["ai.mistral.vibe", "vibe"]
                    .iter()
                    .any(|service| keychain_entry_exists(service, oidc_key))
            })
            .unwrap_or(false);
        // An API key the user stored (by Klide or by the CLI from its env)
        // lives under the env var's name in the same service.
        let keychain_api_key = ["ai.mistral.vibe", "vibe"]
            .iter()
            .any(|service| keychain_entry_exists(service, "MISTRAL_API_KEY"));
        let connected = env_key || keychain_token || keychain_api_key;
        let detail = match (&whoami, connected, keychain_api_key && !keychain_token) {
            (Some((_, payload)), true, false) => {
                let plan = payload
                    .get("plan_name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if plan.is_empty() {
                    "Signed in".to_string()
                } else {
                    format!("Signed in · {plan}")
                }
            }
            (_, true, true) => "Signed in with API key".to_string(),
            (None, true, false) => "Signed in".to_string(),
            (Some(_), false, _) => {
                "Signed in to Vibe Desktop, but the CLI needs its own login — use Log in"
                    .to_string()
            }
            (None, false, _) => "Not signed in — use Log in, or set MISTRAL_API_KEY".to_string(),
        };
        Ok((connected, detail))
    }

    fn install_paths(&self, home: &str) -> Vec<String> {
        vec![
            format!("{home}/.local/bin/vibe"),
            "/opt/homebrew/bin/vibe".to_string(),
            "/usr/local/bin/vibe".to_string(),
        ]
    }

    /// `vibe update` checks and installs in one step, like the other CLIs.
    fn update_args(&self) -> Option<&'static [&'static str]> {
        Some(&["update"])
    }

    /// Vibe is not on a registry Klide can rank versions against (its own
    /// updater is the authority), so say so rather than invent a feed.
    fn release_package(&self) -> Option<&'static str> {
        None
    }

    // ── Run listing ──────────────────────────────────────────────────────

    fn discover_runs(&self, env: &dyn Env) -> Vec<RunCandidate> {
        let mut out = Vec::new();
        let Some(root) = self.sessions_dir(env) else {
            return out;
        };
        let Ok(entries) = std::fs::read_dir(&root) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // `child-*` directories are subagent sessions of a parent run;
            // the parent's row already counts them (`subagent_count`).
            if !path.is_dir()
                || path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("child-"))
            {
                continue;
            }
            if !path.join("meta.json").exists() {
                continue;
            }
            out.push(RunCandidate {
                key: path.to_string_lossy().to_string(),
                mtime_ms: session_updated_ms(&path),
            });
        }
        out
    }

    fn run_parser(&self, _env: &dyn Env) -> Box<dyn RunParser> {
        Box::new(VibeRunParser)
    }

    /// The session index moves independently of any one session directory, so
    /// a remembered parse must move with it (Codex's title index is the same
    /// idea).
    fn parse_inputs_stamp(&self, env: &dyn Env) -> u64 {
        self.sessions_dir(env)
            .map(|d| crate::file_memo::mtime_epoch(&d.join(".session-index.json")))
            .unwrap_or(0)
    }

    fn read_run(&self, _env: &dyn Env, key: &str) -> Result<Vec<RunMessage>, String> {
        let mut msgs: Vec<RunMessage> = Vec::new();
        for item in read_messages(Path::new(key))? {
            let text = match item.role.as_str() {
                "user" => user_text(&item.text),
                _ => item.text,
            };
            msgs.push(RunMessage {
                role: item.role,
                text,
                // Tool activity lives in the journal's action records; the
                // chunk history is the conversation itself.
                tools: vec![],
                images: vec![],
            });
        }
        cap_messages(&mut msgs);
        Ok(msgs)
    }
}

/// What the person typed. A turn Klide sent headless folds its preamble,
/// the system prompt and the whole conversation into one message; the newest
/// `[user]` block is the request.
fn user_text(text: &str) -> String {
    match text.trim_start().strip_prefix(KLIDE_PREAMBLE) {
        Some(rest) => rest.rsplit("[user]\n").next().unwrap_or(rest).trim().to_string(),
        None => text.to_string(),
    }
}

struct VibeRunParser;

impl RunParser for VibeRunParser {
    fn parse(&self, key: &str) -> Option<AgentRun> {
        parse_run(Path::new(key))
    }
}

/// Whether the macOS keychain holds an item for `service`/`account` — an
/// existence probe (`find-generic-password` without `-g` never discloses the
/// secret, and items the CLI adds with `-A` don't prompt).
fn keychain_entry_exists(service: &str, account: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-a", account])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// When a session last changed: the `CURRENT` pointer is rewritten on every
/// generation, so its mtime tracks activity even though the directory's own
/// mtime only moves when entries are added or removed.
fn session_updated_ms(dir: &Path) -> i64 {
    mtime_ms(&dir.join("CURRENT")).max(mtime_ms(dir))
}

/// Per-call token usage summed from a session's journal (`journal/*.jsonl`),
/// counting only lines at or after `since_ms`. Each model call's `usage` is
/// journalled twice — on its `action_result` record and again inside the
/// `core_input` record that feeds the result back — so only `action_result`
/// lines count (a line with no `type` is taken as-is). Fields follow the API's
/// `prompt_tokens` / `completion_tokens` or the CLI's own `input_tokens` /
/// `output_tokens`; cache reads are subtracted from input, mirroring the Codex
/// and Claude parsers. Vibe drops journal segments older than its latest
/// checkpoint, so an old session's total covers what is still on disk. A line's
/// time is its own timestamp when it has one, otherwise the session's last
/// update — the journal has no per-line clock Klide can trust, so a session
/// still active this week keeps its older calls in the week's total.
pub fn journal_usage_since(dir: &Path, since_ms: i64) -> (i64, i64) {
    let journal = dir.join("journal");
    let Ok(entries) = std::fs::read_dir(&journal) else {
        return (0, 0);
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    files.sort();
    let fallback_ms = session_updated_ms(dir);
    let mut input: i64 = 0;
    let mut output: i64 = 0;
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        for line in text.lines() {
            // A usage line can carry the whole answer, so there is no size
            // cap; the substring check keeps tool output from being parsed.
            if !line.contains("_tokens\"") {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if value
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| t != "action_result")
            {
                continue;
            }
            if line_time_ms(&value, fallback_ms) < since_ms {
                continue;
            }
            if let Some(usage) = find_usage_record(&value) {
                let (i, o) = usage_tokens(usage);
                input += i;
                output += o;
            }
        }
    }
    (input, output)
}

/// The first object in `value` that carries input/output token fields — the
/// action record's `usage`. One record per line: the journal appends events,
/// it does not rewrite a cumulative total (Codex's `token_count` is the
/// cumulative shape; Vibe's is per call).
fn find_usage_record(value: &Value) -> Option<&Value> {
    match value {
        Value::Object(map) => {
            let has = |keys: &[&str]| {
                keys.iter()
                    .any(|k| map.get(*k).and_then(|v| v.as_i64()).is_some())
            };
            if has(&["input_tokens", "prompt_tokens"]) || has(&["output_tokens", "completion_tokens"])
            {
                return Some(value);
            }
            map.values().find_map(find_usage_record)
        }
        Value::Array(items) => items.iter().find_map(find_usage_record),
        _ => None,
    }
}

/// (input, output) for one usage record, both naming conventions accepted;
/// cache reads are not input the way the Codex and Claude parsers treat them.
fn usage_tokens(u: &Value) -> (i64, i64) {
    let n = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| u.get(k).and_then(|v| v.as_i64()))
            .unwrap_or(0)
    };
    let input = (n(&["input_tokens", "prompt_tokens"])
        - n(&["cache_read_input_tokens", "cached_input_tokens", "cache_read"]))
    .max(0);
    let output = n(&["output_tokens", "completion_tokens"]);
    (input, output)
}

/// A line's own timestamp when it has one (RFC 3339, or epoch s/ms), else the
/// fallback the caller supplied.
fn line_time_ms(value: &Value, fallback: i64) -> i64 {
    for key in ["timestamp", "ts", "time", "createdAt", "created_at"] {
        match value.get(key) {
            Some(Value::String(s)) => {
                if let Some(ms) = parse_rfc3339_ms(s) {
                    return ms;
                }
                if let Ok(n) = s.parse::<i64>() {
                    return normalize_epoch_ms(n);
                }
            }
            Some(Value::Number(_)) => {
                if let Some(n) = value.get(key).and_then(|v| v.as_i64()) {
                    return normalize_epoch_ms(n);
                }
            }
            _ => {}
        }
    }
    fallback
}

/// Seconds vs milliseconds: anything before 2001 in seconds is millis.
fn normalize_epoch_ms(n: i64) -> i64 {
    if n > 10_000_000_000 { n } else { n * 1000 }
}

/// One conversation message lifted out of a chunk item. Chunks carry two
/// shapes: `{"message": {"role", "content"}, …}` (the materialized history)
/// and raw entries `{"type": "message", "role", "content", "createdAt"}`
/// (the live projection).
struct ChunkMessage {
    role: String,
    text: String,
    created_ms: i64,
}

/// Concatenate the `text` parts of one message's content; reasoning parts
/// nest their own content and are not conversation prose.
fn message_text(content: &Value) -> Option<String> {
    let parts = content.as_array()?;
    let mut out = String::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = part.get("text").and_then(Value::as_str) {
                out.push_str(t);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

fn chunk_message(item: &Value) -> Option<ChunkMessage> {
    let wrapped = item.get("message").filter(|m| m.is_object());
    if wrapped.is_none() && item.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = wrapped.unwrap_or(item);
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
        return None;
    }
    let text = message_text(message.get("content")?)?;
    let created_ms = item
        .get("createdAt")
        .and_then(Value::as_i64)
        .or_else(|| message.get("createdAt").and_then(Value::as_i64))
        .unwrap_or(0);
    Some(ChunkMessage {
        role: role.to_string(),
        text,
        created_ms,
    })
}

/// The manifest of the generation `CURRENT` points at
/// (`generations/<generation>/manifest.json`), or None for a session written
/// before the generation store or caught mid-write.
fn current_manifest(dir: &Path) -> Option<Value> {
    let current: Value = serde_json::from_slice(&std::fs::read(dir.join("CURRENT")).ok()?).ok()?;
    let generation = current.get("generation")?.as_str()?;
    // A generation is a directory name; never let it climb out of the session.
    if generation.is_empty() || !generation.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let path = dir.join("generations").join(generation).join("manifest.json");
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The chunk files that hold the conversation as the person saw it. `chunks/`
/// also keeps every older generation's copies (content-addressed, so a grown
/// history is a new file beside the old one) — reading them all repeats each
/// message once per generation. The current manifest's `projection_state`
/// lists the display history in order, with timestamps; the `checkpoint`
/// is the model's context (compacted, re-injected turns) and is not used.
/// With no manifest, every chunk is read — the pre-generation layout.
fn chunk_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let chunks_dir = dir.join("chunks");
    if let Some(manifest) = current_manifest(dir) {
        let listed = manifest
            .pointer("/projection_state/chunks")
            .and_then(Value::as_array)
            .map(|hashes| {
                hashes
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()))
                    .map(|h| chunks_dir.join(format!("{h}.json")))
                    .collect::<Vec<_>>()
            });
        if let Some(files) = listed {
            return Ok(files);
        }
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&chunks_dir)
        .map_err(|e| format!("Could not read {}: {e}", chunks_dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    Ok(files)
}

/// Every message of a session, in conversation order: the manifest's chunk
/// order, then a stable sort on `createdAt` (epoch millis) for the fallback
/// layout, whose content-hashed filenames carry no order.
fn read_messages(dir: &Path) -> Result<Vec<ChunkMessage>, String> {
    let files = chunk_files(dir)?;
    let mut out: Vec<ChunkMessage> = Vec::new();
    for file in files {
        let bytes =
            std::fs::read(&file).map_err(|e| format!("Could not read {}: {e}", file.display()))?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("{} isn't valid JSON: {e}", file.display()))?;
        if let Some(items) = value.as_array() {
            out.extend(items.iter().filter_map(chunk_message));
        }
    }
    out.sort_by_key(|m| m.created_ms);
    Ok(out)
}

/// Parse one session directory into a board row. `meta.json` carries every
/// fact the board shows; the chunks only add the message count and the last
/// assistant line.
fn parse_run(dir: &Path) -> Option<AgentRun> {
    let meta_bytes = std::fs::read(dir.join("meta.json")).ok()?;
    let meta: Value = serde_json::from_slice(&meta_bytes).ok()?;
    let id = meta
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if id.is_empty() {
        return None;
    }
    let cwd = meta
        .pointer("/environment/working_directory")
        .and_then(Value::as_str)
        .map(str::to_string);
    let model = meta
        .pointer("/config/active_model")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .map(str::to_string);
    let title = meta
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(clean_title)
        .unwrap_or_else(|| "Vibe session".to_string());
    let branch = meta
        .get("git_branch")
        .and_then(Value::as_str)
        .map(str::to_string);
    let parent_id = meta
        .get("parent_session_id")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    let subagent_count = meta
        .get("child_sessions")
        .and_then(Value::as_array)
        .map(|c| c.len() as u32)
        .unwrap_or(0);

    let updated_ms = session_updated_ms(dir);
    let created_ms = meta
        .get("start_time")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_ms)
        .unwrap_or(updated_ms);
    // The current generation says whether a turn is in flight. Without one,
    // `end_time` is the clue — but the TUI writes it on exit and keeps it
    // through a `--resume`, so it only counts when nothing was written after
    // it. Anything else is left to recency (`transcript_status`).
    let state = match current_manifest(dir)
        .as_ref()
        .and_then(|m| m.get("execution_state"))
        .and_then(Value::as_str)
    {
        Some("quiescent") => TranscriptState::TurnComplete,
        Some(_) => TranscriptState::Working,
        None => match meta
            .get("end_time")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_ms)
        {
            Some(end) if end + 1_000 >= updated_ms => TranscriptState::TurnComplete,
            _ => TranscriptState::Working,
        },
    };

    let mut message_count: u32 = 0;
    let mut last_event: Option<String> = None;
    let mut klide_hosted = false;
    if let Ok(messages) = read_messages(dir) {
        // A headless turn Klide sent opens with its preamble; that session is
        // already a Klide conversation, so the board doesn't list it twice.
        klide_hosted = messages
            .iter()
            .find(|m| m.role == "user")
            .is_some_and(|m| m.text.trim_start().starts_with(KLIDE_PREAMBLE));
        for message in &messages {
            message_count += 1;
            if message.role == "assistant" {
                last_event = Some(clean_title(&message.text));
            }
        }
    }

    // The journal's action records carry per-call usage; the session total is
    // their sum. Subscription runs are unpriced, so `cost_usd` stays None.
    let (input_tokens, output_tokens) = journal_usage_since(dir, 0);

    Some(AgentRun {
        id,
        path: dir.to_string_lossy().to_string(),
        source: "vibe".to_string(),
        title,
        model,
        cwd: cwd.clone(),
        project: cwd.as_deref().and_then(project_name),
        git_branch: branch,
        created_ms,
        updated_ms,
        message_count,
        input_tokens,
        output_tokens,
        status: transcript_status(updated_ms, state),
        files_touched: 0,
        cost_usd: None,
        subagent_count,
        last_event,
        worktree: None, // filled centrally in list_agent_runs from cwd
        parent_id,
        klide_hosted,
    })
}

/// RFC 3339 (`2026-11-17T21:48:51.257000+00:00`) to epoch millis. Hand-rolled
/// because the fractional seconds and offset are fixed-width in every stamp
/// the CLI writes; anything stranger falls back to the caller's default.
fn parse_rfc3339_ms(stamp: &str) -> Option<i64> {
    // YYYY-MM-DDTHH:MM:SS[.frac]±HH:MM or Z
    let bytes = stamp.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[10] != b'T' || bytes[13] != b':' {
        return None;
    }
    let year: i64 = stamp.get(0..4)?.parse().ok()?;
    let month: i64 = stamp.get(5..7)?.parse().ok()?;
    let day: i64 = stamp.get(8..10)?.parse().ok()?;
    let hour: i64 = stamp.get(11..13)?.parse().ok()?;
    let min: i64 = stamp.get(14..16)?.parse().ok()?;
    let sec: i64 = stamp.get(17..19)?.parse().ok()?;
    // Optional fractional seconds (kept to milliseconds), then the offset.
    let tail = stamp.get(19..)?;
    let (millis, tail) = match tail.strip_prefix('.') {
        Some(r) => {
            let digits = r.bytes().take_while(|b| b.is_ascii_digit()).count();
            let frac = &r[..digits];
            let ms: i64 = format!("{:<03}", &frac[..frac.len().min(3)]).parse().ok()?;
            (ms, &r[digits..])
        }
        None => (0, tail),
    };
    let offset_min = if tail.starts_with('Z') {
        0
    } else {
        let sign = match tail.as_bytes().first() {
            Some(b'+') => 1,
            Some(b'-') => -1,
            _ => return None,
        };
        let oh: i64 = tail.get(1..3)?.parse().ok()?;
        let om: i64 = tail.get(4..6)?.parse().ok()?;
        sign * (oh * 60 + om)
    };
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + min * 60 + sec - offset_min * 60;
    Some(secs * 1_000 + millis)
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delegate::home::test_env;

    fn fixture(name: &str) -> PathBuf {
        let home =
            std::env::temp_dir().join(format!("klide-vibe-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = home
            .join(".vibe/logs/session/unified/aaaa-bbbb")
            .join("chunks");
        std::fs::create_dir_all(&dir).unwrap();
        home
    }

    /// A generation store: `CURRENT` → `generations/<g>/manifest.json`.
    fn write_generation(dir: &Path, execution_state: &str, projection: &[&str]) {
        std::fs::write(dir.join("CURRENT"), r#"{"generation":"0000000000000007"}"#).unwrap();
        let gen = dir.join("generations/0000000000000007");
        std::fs::create_dir_all(&gen).unwrap();
        let manifest = serde_json::json!({
            "execution_state": execution_state,
            "checkpoint": {"chunks": ["cccc"]},
            "projection_state": {"chunks": projection},
        });
        std::fs::write(gen.join("manifest.json"), manifest.to_string()).unwrap();
    }

    fn write_meta(home: &Path, meta: &str) {
        let dir = home.join(".vibe/logs/session/unified/aaaa-bbbb");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("meta.json"), meta).unwrap();
    }

    #[test]
    fn vibe_home_honours_vibe_home() {
        let home = Path::new("/u/x");
        let env = test_env(home);
        assert_eq!(Vibe.config_home(&env), Some(home.join(".vibe")));
        assert_eq!(
            Vibe.sessions_dir(&env),
            Some(home.join(".vibe/logs/session/unified"))
        );
        assert_eq!(
            Vibe.models_cache(&env),
            Some(home.join(".vibe/model_catalog_cache.json"))
        );
        assert!(Vibe.auth_files(&env).is_empty(), "keyring, not files");
        let moved = Path::new("/srv/vibe-home");
        let env = env.set("VIBE_HOME", moved);
        assert_eq!(Vibe.config_home(&env), Some(moved.to_path_buf()));
    }

    #[test]
    fn spawn_and_mission_commands_use_vibe_flags() {
        assert_eq!(
            Vibe.spawn_command(
                Some("fix it"),
                Some("mistral-large-4-0"),
                Some("sid-1"),
                None
            ),
            "vibe --resume 'sid-1' --model 'mistral-large-4-0' 'fix it'"
        );
        // The CLI_DEFAULT_MODEL sentinel means "no flag", like every delegate.
        assert_eq!(
            Vibe.spawn_command(Some("hi"), Some("default"), None, None),
            "vibe 'hi'"
        );
        assert_eq!(
            Vibe.mission_command(Some("task"), Some("default")).unwrap(),
            "vibe -p --trust --output text 'task'"
        );
        assert!(Vibe.mission_command(None, None).is_err());
        assert_eq!(
            Vibe.chat_args("/tmp", "default").unwrap(),
            ["-p", "--trust", "--output", "text"]
        );
        assert_eq!(
            Vibe.chat_args("/tmp", "mistral-large-4-0").unwrap(),
            [
                "-p",
                "--trust",
                "--output",
                "text",
                "--model",
                "mistral-large-4-0"
            ]
        );
    }

    #[test]
    fn discovers_only_root_sessions_with_meta() {
        let home = fixture("discover");
        let root = home.join(".vibe/logs/session/unified");
        write_meta(
            &home,
            r#"{"session_id":"aaaa-bbbb","start_time":"2026-11-17T21:48:51.257000+00:00","end_time":"2026-11-17T22:54:35.566000+00:00","environment":{"working_directory":"/tmp/proj"},"config":{"active_model":"mistral-large-4-0"},"title":"A session","child_sessions":["child-1"]}"#,
        );
        write_generation(&root.join("aaaa-bbbb"), "quiescent", &[]);
        // A subagent directory and a meta-less directory are not rows.
        std::fs::create_dir_all(root.join("child-1")).unwrap();
        std::fs::create_dir_all(root.join("stray")).unwrap();

        let env = test_env(&home);
        let runs = Vibe.discover_runs(&env);
        assert_eq!(runs.len(), 1);
        assert!(runs[0].key.ends_with("aaaa-bbbb"));

        let run = Vibe.run_parser(&env).parse(&runs[0].key).unwrap();
        assert_eq!(run.id, "aaaa-bbbb");
        assert_eq!(run.source, "vibe");
        assert_eq!(run.title, "A session");
        assert_eq!(run.model.as_deref(), Some("mistral-large-4-0"));
        assert_eq!(run.cwd.as_deref(), Some("/tmp/proj"));
        assert_eq!(run.project.as_deref(), Some("proj"));
        assert_eq!(run.status, "done");
        assert_eq!(run.subagent_count, 1);
        assert_eq!(run.created_ms, 1_794_952_131_257);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_session_klide_drove_is_hosted_and_shows_only_the_request() {
        let home = fixture("hosted");
        write_meta(&home, r#"{"session_id":"aaaa-bbbb"}"#);
        let dir = home.join(".vibe/logs/session/unified/aaaa-bbbb");
        let prompt = format!("{KLIDE_PREAMBLE}\\nAnswer…\\n\\n[system]\\nWORK MODE\\n\\n[user]\\nhello\\n\\n");
        std::fs::write(
            dir.join("chunks/a.json"),
            format!(r#"[{{"message":{{"role":"user","content":[{{"type":"text","text":"{prompt}"}}],"createdAt":1}}}}]"#),
        )
        .unwrap();
        let env = test_env(&home);
        assert!(Vibe.run_parser(&env).parse(&dir.to_string_lossy()).unwrap().klide_hosted);
        let msgs = Vibe.read_run(&env, &dir.to_string_lossy()).unwrap();
        assert_eq!(msgs[0].text, "hello");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn read_run_reads_chunk_history_in_order() {
        let home = fixture("read");
        write_meta(&home, r#"{"session_id":"aaaa-bbbb"}"#);
        let chunks = home.join(".vibe/logs/session/unified/aaaa-bbbb/chunks");
        std::fs::write(
            chunks.join("b.json"),
            r#"[{"message":{"role":"assistant","content":[{"type":"text","text":"second answer"}],"createdAt":4}}]"#,
        )
        .unwrap();
        std::fs::write(
            chunks.join("a.json"),
            r#"[{"message":{"role":"user","content":[{"type":"text","text":"first question"}],"createdAt":1}},
                 {"message":{"role":"assistant","content":[{"type":"reasoning","content":[{"type":"text","text":"thinking"}]},{"type":"text","text":"first answer"}],"createdAt":2}},
                 {"type":"message","role":"assistant","content":[{"type":"text","text":"raw entry answer"}],"createdAt":3}]"#,
        )
        .unwrap();
        let env = test_env(&home);
        let msgs = Vibe
            .read_run(
                &env,
                &home
                    .join(".vibe/logs/session/unified/aaaa-bbbb")
                    .to_string_lossy(),
            )
            .unwrap();
        let texts: Vec<(&str, &str)> = msgs
            .iter()
            .map(|m| (m.role.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            [
                ("user", "first question"),
                ("assistant", "first answer"),
                ("assistant", "raw entry answer"),
                ("assistant", "second answer")
            ]
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn only_the_current_generations_display_chunks_are_read() {
        let home = fixture("generations");
        write_meta(&home, r#"{"session_id":"aaaa-bbbb"}"#);
        let dir = home.join(".vibe/logs/session/unified/aaaa-bbbb");
        let msg = |role: &str, text: &str, at: i64| {
            format!(r#"{{"type":"message","role":"{role}","content":[{{"type":"text","text":"{text}"}}],"createdAt":{at}}}"#)
        };
        // An older generation's copy of the history, still in `chunks/`.
        std::fs::write(dir.join("chunks/0a.json"), format!("[{}]", msg("user", "hi", 1))).unwrap();
        // The model's checkpoint context (no timestamps) — not the display.
        std::fs::write(
            dir.join("chunks/cccc.json"),
            r#"[{"message":{"role":"user","content":[{"type":"text","text":"hi"}]}},{"message":"opaque"}]"#,
        )
        .unwrap();
        // The current projection, split over two chunks.
        std::fs::write(dir.join("chunks/1b.json"), format!("[{}]", msg("user", "hi", 1))).unwrap();
        std::fs::write(dir.join("chunks/2c.json"), format!("[{}]", msg("assistant", "hello", 2))).unwrap();
        write_generation(&dir, "quiescent", &["1b", "2c"]);

        let env = test_env(&home);
        let msgs = Vibe.read_run(&env, &dir.to_string_lossy()).unwrap();
        let texts: Vec<&str> = msgs.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["hi", "hello"], "each message once");
        assert_eq!(Vibe.run_parser(&env).parse(&dir.to_string_lossy()).unwrap().message_count, 2);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_resumed_session_is_not_done_because_an_earlier_exit_wrote_end_time() {
        let home = fixture("resumed");
        // `end_time` from the first exit, long before the directory's mtime.
        write_meta(
            &home,
            r#"{"session_id":"aaaa-bbbb","end_time":"2026-01-01T00:00:00Z"}"#,
        );
        let dir = home.join(".vibe/logs/session/unified/aaaa-bbbb");
        let env = test_env(&home);
        assert_eq!(Vibe.run_parser(&env).parse(&dir.to_string_lossy()).unwrap().status, "running");
        // A turn in flight per the generation store is running too…
        write_generation(&dir, "executing", &[]);
        assert_eq!(Vibe.run_parser(&env).parse(&dir.to_string_lossy()).unwrap().status, "running");
        // …and a quiescent one is settled.
        write_generation(&dir, "quiescent", &[]);
        assert_eq!(Vibe.run_parser(&env).parse(&dir.to_string_lossy()).unwrap().status, "done");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn headless_turns_do_not_claim_to_resume() {
        // The runner would send only the newest message to a CLI that resumes;
        // `chat_invocation` passes no `--resume`, so the history must be folded.
        assert!(!Vibe.resumes_sessions());
    }

    #[test]
    fn rfc3339_stamps_parse_to_millis() {
        assert_eq!(
            parse_rfc3339_ms("2026-11-17T21:48:51.257000+00:00"),
            Some(1_794_952_131_257)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-17T23:48:51Z"),
            Some(1_794_959_331_000)
        );
        assert_eq!(parse_rfc3339_ms("not a date"), None);
    }

    #[test]
    fn journal_usage_sums_per_call_records_in_both_namings() {
        let home = fixture("usage");
        let dir = home.join(".vibe/logs/session/unified/aaaa-bbbb");
        let journal = dir.join("journal");
        std::fs::create_dir_all(&journal).unwrap();
        std::fs::write(
            journal.join("1.jsonl"),
            concat!(
                // CLI naming, cache reads excluded from input.
                r#"{"type":"action_result","timestamp":"2026-11-17T21:48:51Z","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":55}}"#,
                "\n",
                // The `core_input` echo of that same call is not counted again.
                r#"{"type":"core_input","payload":{"input":{"command":{"result":{"usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":55}}}}}}"#,
                "\n",
                // API naming, nested as the CLI journals it (no line timestamp).
                r#"{"type":"action_result","payload":{"result":{"result":{"usage":{"prompt_tokens":200,"completion_tokens":20}}}}}"#,
                "\n",
                // A tool record with no usage adds nothing.
                r#"{"type":"tool_call","tool":"read_file","timestamp":"2026-11-17T21:49:00Z"}"#,
                "\n",
                // A truncated last line is skipped without failing.
                r#"{"type":"action_result","usage":{"input_tokens":"#,
            ),
        )
        .unwrap();
        // The truncated last line is not valid JSON and is skipped.
        let (input, output) = journal_usage_since(&dir, 0);
        assert_eq!((input, output), (800, 75));
        // A window that starts after the first record keeps only the second:
        // that line carries no timestamp, so it falls back to the session's
        // own mtime (now) and counts.
        let since = parse_rfc3339_ms("2026-11-17T21:48:55Z").unwrap();
        let (input, output) = journal_usage_since(&dir, since);
        assert_eq!((input, output), (200, 20));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn parse_run_carries_journal_token_totals() {
        let home = fixture("run-usage");
        write_meta(&home, r#"{"session_id":"aaaa-bbbb","start_time":"2026-11-17T21:48:51.257000+00:00","end_time":"2026-11-17T22:00:00.000000+00:00"}"#);
        let dir = home.join(".vibe/logs/session/unified/aaaa-bbbb");
        let journal = dir.join("journal");
        std::fs::create_dir_all(&journal).unwrap();
        std::fs::write(
            journal.join("1.jsonl"),
            r#"{"type":"action_result","usage":{"input_tokens":500,"output_tokens":40}}"#,
        )
        .unwrap();
        let env = test_env(&home);
        let run = Vibe.run_parser(&env).parse(&dir.to_string_lossy()).unwrap();
        assert_eq!(run.input_tokens, 500);
        assert_eq!(run.output_tokens, 40);
        assert_eq!(run.cost_usd, None, "subscription runs stay unpriced");
        let _ = std::fs::remove_dir_all(&home);
    }
}
