mod accounts;
mod adapters;
mod agent;
mod custom_providers;
mod delegate;
mod git;
mod local_servers;
mod memory;
mod models;
mod pricing;
mod providers;
mod pty;
mod search;
mod skills;
mod workspace;

use crate::providers::ProviderKeyStatus;
use memory::{memory_list, memory_read, memory_write};
use pty::{
    delegate_pty_live_sessions, delegate_pty_resize, delegate_pty_snapshot, delegate_pty_spawn,
    delegate_pty_stop, delegate_pty_write, pty_spawn, pty_write, DelegatePtyState, PtyState,
};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Emitter;

pub(crate) const OLLAMA_URL: &str = "http://localhost:11434";
const MLX_DEFAULT_MODEL: &str = "mlx-community/Llama-3.1-8B-Instruct-4bit";
pub(crate) const MLX_MODEL_PRESETS: &[&str] = &[
    MLX_DEFAULT_MODEL,
    "Qwen/Qwen3-4B-MLX-4bit",
    "mlx-community/gemma-2-9b-it-4bit",
    "mlx-community/gemma-4-E4B-it-qat-4bit",
    "mlx-community/gemma-4-12B-it-qat-4bit",
];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    is_directory: bool,
}

/// Identity / host info used by the profile modal. All fields are
/// best-effort — failures during the shell-out become empty strings
/// rather than a hard error, so a missing `whoami` on some weird
/// container still returns a usable (if partial) struct.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUserInfo {
    username: String,
    hostname: String,
    home_dir: String,
}

fn shell_one_line(cmd: &str, arg: &str) -> Option<String> {
    let out = std::process::Command::new(cmd).arg(arg).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Resolve the user's home directory (HOME, or USERPROFILE on Windows).
/// Shared by the profile command and the MLX cache-dir logic.
pub(crate) fn home_dir_path() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        return Some(PathBuf::from(home));
    }
    if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        None
    }
}

#[tauri::command]
fn app_user_info() -> AppUserInfo {
    let username = shell_one_line("whoami", "")
        .or_else(|| std::env::var("USER").ok())
        .or_else(|| std::env::var("USERNAME").ok())
        .unwrap_or_default();
    let hostname = shell_one_line("hostname", "")
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_default();
    let home = home_dir_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    AppUserInfo {
        username,
        hostname,
        home_dir: home,
    }
}

// Real token accounting reported by the provider (Ollama eval counts,
// OpenAI/Anthropic usage blocks). All fields optional — adapters fill what
// their wire format exposes; the UI falls back to estimates when absent.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) completion_tokens: Option<u64>,
    /// Time spent generating the completion, ms (Ollama eval_duration).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) eval_duration_ms: Option<u64>,
    /// Time spent processing the prompt, ms (Ollama prompt_eval_duration).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) prompt_eval_duration_ms: Option<u64>,
    /// Real billed cost in USD, when the provider reports it directly.
    /// OpenRouter attaches `usage.cost` to every response (the actual
    /// charged amount, including any markup) — ground truth, not an
    /// estimate. `None` for providers that don't report cost; those are
    /// priced from the local table instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cost_usd: Option<f64>,
}

impl AiUsage {
    fn is_empty(&self) -> bool {
        self.prompt_tokens.is_none()
            && self.completion_tokens.is_none()
            && self.eval_duration_ms.is_none()
            && self.prompt_eval_duration_ms.is_none()
            && self.cost_usd.is_none()
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiChatResponse {
    pub(crate) content: String,
    pub(crate) thinking: Option<String>,
    pub(crate) tool_calls: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) usage: Option<AiUsage>,
    /// Why generation stopped, as reported by the provider. Ollama's
    /// `done_reason`: `"stop"` = the model finished naturally, `"length"` =
    /// it hit `num_ctx` and was cut off mid-answer. `None` when the provider
    /// doesn't report it. The harness uses `"length"` to warn the user the
    /// reply is truncated rather than silently showing a half-answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) stop_reason: Option<String>,
}

// One streamed delta pushed to the frontend through the per-request Channel.
// `content`/`thinking` are incremental fragments — the UI appends them for the
// live typing effect, then reconciles against ai_chat's authoritative return.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamChunk {
    pub(crate) content: String,
    pub(crate) thinking: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiConnectionStatus {
    provider: String,
    installed: bool,
    connected: bool,
    detail: String,
    command_path: Option<String>,
    login_options: Vec<String>,
}

// Keychain service name lives in `providers` (single source of truth for
// key storage). `KEYCHAIN_SERVICE` was moved when the registry absorbed
// the keychain helpers.

// Anthropic requires this header on every Messages API call; pinning a known
// version keeps the request/response shape stable as the API evolves.
pub(crate) const ANTHROPIC_VERSION: &str = "2023-06-01";

// Thin lib.rs-side wrappers around the registry. The lookup, the env-var
// fallback, and the local-vs-hosted decision all live in
// `providers::provider_key`; these are kept so call-sites in this file
// can stay one short line and don't have to reach into the module.
pub(crate) fn provider_key(provider: &str) -> Result<Option<String>, String> {
    providers::provider_key(provider)
}

// The `ProviderKeyStatus` struct lives in `providers` (single source of
// truth for the registry); this command is a thin shim that returns the
// registry's status unchanged.
//
// Report whether a usable key exists and where it comes from — never returns
// the key itself, so the value stays inside the Rust side.
#[tauri::command]
fn ai_provider_key_status(provider: String) -> ProviderKeyStatus {
    providers::key_status(&provider).unwrap_or(ProviderKeyStatus {
        has_key: false,
        source: "none".to_string(),
    })
}

#[tauri::command]
fn ai_set_provider_key(provider: String, key: String) -> Result<(), String> {
    providers::set_keychain_key(&provider, &key)
}

#[tauri::command]
fn ai_clear_provider_key(provider: String) -> Result<(), String> {
    providers::clear_keychain_key(&provider)
}

// Per-model list price (USD per million in/out tokens), or null for local /
// subscription / unknown models. The AI panel fetches this once per model and
// computes per-message + per-conversation cost from each turn's token usage.
#[tauri::command]
fn ai_model_pricing(model: String) -> Option<pricing::ModelPricing> {
    pricing::pricing_for_model(&model)
}

// The second key method for built-in providers: a `${VAR}` env reference
// (resolved from the env / project `.env` / ~/.klide/.env), exactly like a
// self-hosted endpoint. Keychain-free, so it never pops a macOS prompt.
#[tauri::command]
fn ai_set_provider_key_reference(provider: String, reference: String) -> Result<(), String> {
    providers::set_provider_reference(&provider, Some(&reference))
}

#[tauri::command]
fn ai_clear_provider_key_reference(provider: String) -> Result<(), String> {
    providers::set_provider_reference(&provider, None)
}

// ── Custom (self-hosted) providers ──────────────────────────────────────
// The runtime sibling of the static `providers` registry. Config (label,
// base URL, default model) persists to `~/.klide/custom_providers.json`;
// the bearer token rides the existing `ai_set_provider_key` keychain path,
// keyed by the same `custom:` id.

#[tauri::command]
fn custom_provider_list() -> Vec<custom_providers::CustomProvider> {
    custom_providers::list()
}

// Account snapshots for delegate CLIs (Codex / Claude Code / OpenCode). List
// saved snapshots with active-detection, and snapshot the current login. No
// activation/switching yet — see `accounts.rs`.
#[tauri::command]
fn accounts_list(provider: String) -> accounts::AccountsView {
    accounts::list(&provider)
}

#[tauri::command]
fn account_save_current(provider: String, name: String) -> Result<accounts::Account, String> {
    accounts::save_current(&provider, &name)
}

#[tauri::command]
fn account_activate(
    provider: String,
    name: String,
    delegate_state: tauri::State<DelegatePtyState>,
) -> Result<(), String> {
    // Live-run guard: a running delegate refreshes its token and writes back
    // to the store we're about to swap, so refuse while one is live.
    if delegate_state.has_live_session(&provider) {
        return Err(format!(
            "A {} session is live in Klide — finish or stop it before switching accounts.",
            provider
        ));
    }
    accounts::activate(&provider, &name)
}

/// Tell the backend which folder is open, so `${VAR}` token references can
/// resolve from that project's `.env`. Called by the frontend whenever the
/// workspace changes; `None` clears it.
#[tauri::command]
fn set_active_workspace(root: Option<String>) {
    providers::set_active_workspace(root);
}

#[tauri::command]
fn custom_provider_upsert(provider: custom_providers::CustomProvider) -> Result<(), String> {
    custom_providers::upsert(provider)
}

#[tauri::command]
fn custom_provider_remove(id: String) -> Result<(), String> {
    // Drop the keychain token alongside the config so a re-added id with
    // the same name doesn't silently inherit the old credential.
    let _ = providers::clear_keychain_key(&id);
    custom_providers::remove(&id)
}

pub(crate) fn is_subscription_provider(provider: &str) -> bool {
    providers::is_subscription(provider)
}

pub(crate) fn response_error(provider: &str, status: reqwest::StatusCode, body: &str) -> String {
    // Cloudflare edge codes are opaque ("524 <unknown status code>"), and a
    // self-hosted endpoint behind a tunnel is the common case — translate the
    // ones we actually hit into an actionable hint instead of the raw code.
    let hint = match status.as_u16() {
        524 | 504 => Some(
            "timed out waiting for the model (~100s proxy limit) — it may be cold or busy. \
             Try a smaller or pre-warmed model, or a shorter conversation.",
        ),
        520 | 521 | 522 | 523 => {
            Some("the endpoint's edge could not reach its origin server — check the host is up.")
        }
        _ => None,
    };
    if let Some(hint) = hint {
        return format!("{provider}: {hint} (HTTP {})", status.as_u16());
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        format!("{provider} returned {status}")
    } else {
        format!("{provider} returned {status}: {trimmed}")
    }
}

#[tauri::command]
fn ai_subscription_status(provider: String) -> Result<AiConnectionStatus, String> {
    let entry = providers::lookup(&provider)
        .ok_or_else(|| format!("Provider \"{provider}\" is not wired yet"))?;
    let spec = entry
        .subscription
        .as_ref()
        .ok_or_else(|| format!("Provider \"{provider}\" is not a subscription CLI"))?;
    let resolved = resolve_command(spec.cmd);
    let command_path = resolved.as_ref().ok().cloned();
    let installed = resolved.is_ok();

    // All per-CLI auth knowledge lives behind the Delegate seam. Every
    // subscription provider is a delegate, so this lookup always resolves.
    let adapter = delegate::lookup(&provider);
    let login_options = adapter.map(|d| d.login_commands()).unwrap_or_default();

    if !installed {
        return Ok(AiConnectionStatus {
            provider,
            installed: false,
            connected: false,
            detail: format!("{} CLI is not installed or not on PATH", spec.cmd),
            command_path: None,
            login_options,
        });
    }

    let (connected, detail) = match adapter {
        Some(d) => d.check_auth(command_path.as_deref().unwrap_or(spec.cmd))?,
        None => (false, "Unknown provider".to_string()),
    };

    Ok(AiConnectionStatus {
        provider,
        installed,
        connected,
        detail,
        command_path,
        login_options,
    })
}

#[tauri::command]
fn ai_list_tools(mode: String) -> Vec<serde_json::Value> {
    let mode = match mode.as_str() {
        "plan" => agent::types::AgentMode::Plan,
        "goal" => agent::types::AgentMode::Goal,
        _ => agent::types::AgentMode::Chat,
    };
    agent::tools::list_tools(&mode, &[])
}

// ── Find in files ───────────────────────────────────────────────────────

#[tauri::command]
fn search_in_files(
    workspace_root: String,
    pattern: String,
    include: Option<String>,
) -> Result<search::SearchResult, String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    search::search_workspace(&ws, &pattern, include.as_deref())
}

#[tauri::command]
async fn ai_chat(
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    workspace_root: Option<String>,
    num_ctx: Option<usize>,
    num_predict: Option<usize>,
    reflection_level: Option<String>,
    on_chunk: Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    // Built-in providers resolve through the static registry. A miss
    // falls through to the custom (self-hosted) store below — those ids
    // (prefixed `custom:`) can't live in the `const` registry because
    // their URLs are typed in at runtime.
    let Some(entry) = providers::lookup(&provider) else {
        let cp = custom_providers::get(&provider)
            .ok_or_else(|| format!("Provider \"{provider}\" is not wired yet"))?;
        // Custom providers always speak the OpenAI wire. The token is
        // optional (a no-auth local endpoint has none); tools are sent
        // and stream usage is left off, matching the safe local-proxy
        // posture (LM Studio rejects `stream_options`).
        return adapters::openai_compatible_chat(
            cp.id.clone(),
            cp.chat_url(),
            true,
            false,
            false,
            false,
            providers::custom_token(&cp.id),
            None,
            model,
            messages,
            tools,
            &on_chunk,
        )
        .await;
    };

    // Subscription CLIs route first — the per-wire match is for
    // streaming backends only. The `wire` field on subscription rows
    // is a placeholder that's never reached.
    if let Some(spec) = entry.subscription {
        let adapter = delegate::lookup(entry.id)
            .ok_or_else(|| format!("\"{}\" has no delegate adapter", entry.id))?;
        return delegate::run_subscription_chat(
            adapter,
            spec.label,
            model,
            messages,
            workspace_root,
            &on_chunk,
        )
        .await;
    }

    match entry.wire {
        providers::WireFormat::Ollama => {
            adapters::ollama_chat(
                model,
                messages,
                tools,
                num_ctx,
                num_predict,
                reflection_level,
                &on_chunk,
            )
            .await
        }
        providers::WireFormat::Anthropic => {
            adapters::anthropic_chat(model, messages, tools, reflection_level, &on_chunk).await
        }
        providers::WireFormat::OpenAi(cfg) => {
            // Hosted providers require a key (`provider_key` errors when
            // missing); local OpenAI-wire ones (MLX, LM Studio) return
            // Ok(None) and send no auth header.
            let key = provider_key(entry.id)?;
            adapters::openai_compatible_chat(
                entry.id.to_string(),
                cfg.chat_url.to_string(),
                cfg.include_tools,
                cfg.include_usage_in_stream,
                cfg.include_cost_accounting,
                cfg.send_attribution,
                key,
                if cfg.supports_reasoning_effort {
                    adapters::reflection_level_to_openai_effort(reflection_level.as_deref())
                } else {
                    None
                },
                model,
                messages,
                tools,
                &on_chunk,
            )
            .await
        }
    }
}

pub(crate) fn resolve_command(command: &str) -> Result<String, String> {
    let output = Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {command}"))
        .output()
        .map_err(|e| format!("Unable to check {command}: {e}"))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Ok(path);
        }
    }

    let home = std::env::var("HOME").unwrap_or_default();
    // Delegate binaries keep their install-path fallbacks behind the seam;
    // only non-delegate binaries (the MLX local server) stay tabled here.
    let candidates = match delegate::ALL.iter().find(|d| d.binary() == command) {
        Some(d) => d.install_paths(&home),
        None => match command {
            "mlx_lm.server" => vec![
                format!("{home}/.pyenv/shims/mlx_lm.server"),
                format!("{home}/.local/bin/mlx_lm.server"),
            ],
            _ => Vec::new(),
        },
    };
    candidates
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
        .ok_or_else(|| format!("{command} CLI is not installed or not on PATH"))
}

pub(crate) fn ensure_command_available(command: &str) -> Result<(), String> {
    resolve_command(command).map(|_| ())
}

fn text_from_message(message: &serde_json::Value) -> String {
    message
        .get("content")
        .and_then(|content| {
            if let Some(text) = content.as_str() {
                return Some(text.to_string());
            }
            content.as_array().map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        })
        .unwrap_or_default()
}

#[tauri::command]
fn list_dir(workspace_root: String, path: String) -> Result<Vec<FsEntry>, String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    let path = ws.resolve_abs_read(&path)?;
    let entries = std::fs::read_dir(path).map_err(|e| format!("Unable to read folder: {e}"))?;

    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Unable to read folder entry: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Unable to read folder entry type: {e}"))?;
        out.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_directory: file_type.is_dir(),
        });
    }

    Ok(out)
}

#[tauri::command]
fn read_text_file(workspace_root: String, path: String) -> Result<String, String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    let path = ws.resolve_abs_read(&path)?;
    std::fs::read_to_string(&path).map_err(|e| format!("Unable to read file: {e}"))
}

#[tauri::command]
fn path_exists(workspace_root: String, path: String) -> Result<bool, String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    Ok(ws.resolve_abs_readwrite(&path)?.exists())
}

#[tauri::command]
fn write_text_file(workspace_root: String, path: String, content: String) -> Result<(), String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    let target = ws.resolve_abs_readwrite(&path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Unable to create folder: {e}"))?;
    }
    std::fs::write(&target, content).map_err(|e| format!("Unable to write file: {e}"))
}

#[tauri::command]
fn create_entry(workspace_root: String, path: String, is_directory: bool) -> Result<(), String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    let target = ws.resolve_abs_entry(&path)?;
    if target.exists() {
        return Err("An entry with that name already exists".to_string());
    }
    if is_directory {
        std::fs::create_dir(&target).map_err(|e| format!("Unable to create folder: {e}"))
    } else {
        std::fs::write(&target, "").map_err(|e| format!("Unable to create file: {e}"))
    }
}

#[tauri::command]
fn rename_entry(workspace_root: String, from: String, to: String) -> Result<(), String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    let from_path = ws.resolve_abs_entry(&from)?;
    let to_path = ws.resolve_abs_entry(&to)?;
    if to_path.exists() {
        return Err("An entry with that name already exists".to_string());
    }
    std::fs::rename(&from_path, &to_path).map_err(|e| format!("Unable to rename: {e}"))
}

#[tauri::command]
fn delete_entry(workspace_root: String, path: String) -> Result<(), String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    let target = ws.resolve_abs_entry(&path)?;
    // symlink_metadata: delete a symlink itself, never follow it.
    let meta =
        std::fs::symlink_metadata(&target).map_err(|e| format!("Unable to read entry: {e}"))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Unable to delete folder: {e}"))
    } else {
        std::fs::remove_file(&target).map_err(|e| format!("Unable to delete file: {e}"))
    }
}

#[tauri::command]
fn reveal_entry(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|e| format!("Unable to reveal in Finder: {e}"))
}

// ── Agent runs aggregation ──────────────────────────────────────────────
// Mission Control's board: every run a delegate CLI left on disk, plus the
// parent links recorded at dispatch time. All per-CLI discovery and parsing
// lives behind the Delegate seam (src/delegate/); these commands only add
// the Tauri glue.

use crate::delegate::{AgentRun, Delegate, RunMessage};

#[tauri::command]
fn list_agent_runs(
    app: tauri::AppHandle,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<AgentRun>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let mut runs = delegate::list_runs(&home, limit.unwrap_or(10), offset.unwrap_or(0));

    // Inject parent ids from the spawn mappings recorded at dispatch time.
    // Try by Klide's internal ID first, then by the external session ID (for
    // cases where the CLI created its own session id different from the one
    // we passed to delegate_pty_spawn).
    let (by_delegate, by_external) = crate::pty::read_delegate_sessions_by_id(&app);
    for run in runs.iter_mut() {
        // Evidence: surface the linked git worktree a run executed in (when its
        // cwd is one), so the board can answer "where did this happen?".
        if run.worktree.is_none() {
            if let Some(cwd) = run.cwd.as_deref() {
                run.worktree = crate::delegate::worktree_label(cwd);
            }
        }
        if run.parent_id.is_none() {
            if let Some(mapping) = by_delegate
                .get(&run.id)
                .or_else(|| by_external.get(&run.id))
            {
                run.parent_id = Some(mapping.parent_id.clone());
            }
        }
    }
    Ok(runs)
}

#[tauri::command]
fn read_agent_run(path: String, source: String) -> Result<Vec<RunMessage>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let p = std::path::Path::new(&path);
    // Sandbox: only ever read the known agent-log directories. (OpenCode runs
    // go through read_opencode_run instead — their key is a session id, not a
    // path under home.)
    let allowed = [".claude", ".codex", ".omp"];
    if !allowed
        .iter()
        .any(|dir| p.starts_with(std::path::Path::new(&home).join(dir)))
    {
        return Err("Path is outside the agent log directories".to_string());
    }
    // Route through the registry so every delegate uses its own parser — an
    // unknown source errors loudly instead of being mis-read as Claude.
    let adapter = delegate::lookup(&source)
        .ok_or_else(|| format!("No delegate adapter for source: {source}"))?;
    adapter.read_run(&home, &path)
}

#[tauri::command]
fn read_opencode_run(session_id: String) -> Result<Vec<RunMessage>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    delegate::OpenCode.read_run(&home, &session_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState {
            writer: Mutex::new(None),
            cwd: Mutex::new(None),
        })
        .manage(DelegatePtyState {
            sessions: Mutex::new(std::collections::HashMap::new()),
        })
        .manage(agent::AgentSupervisorState::default())
        .manage(local_servers::LocalServerState::default())
        .manage(models::ReflectionProbeCache::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
            use tauri::Manager;

            let handle = app.handle();

            // Open at a comfortable fraction of the display the window lands on,
            // centered — like a native macOS app, rather than a fixed pixel size
            // that's cramped on a large screen and oversized on a laptop. The
            // window starts hidden (tauri.conf.json `visible: false`) so the user
            // never sees it snap from the config size to this one. Panels then
            // lay out against the real size (the workbench ResizeObserver clamps
            // every rect to it — see usePanelLayout).
            if let Some(window) = app.get_webview_window("main") {
                let monitor = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| window.primary_monitor().ok().flatten());
                if let Some(monitor) = monitor {
                    let screen = monitor.size().to_logical::<f64>(monitor.scale_factor());
                    // ~80% wide / ~85% tall leaves room for the menu bar + Dock,
                    // clamped so it never goes below the min size or absurdly big.
                    let w = (screen.width * 0.80).clamp(960.0, 1600.0);
                    let h = (screen.height * 0.85).clamp(640.0, 1040.0);
                    let _ = window.set_size(tauri::LogicalSize::new(w, h));
                }
                let _ = window.center();
                let _ = window.show();
            }

            let open_folder = MenuItemBuilder::with_id("open-folder", "Open Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(handle)?;
            let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(handle)?;
            let close_window = MenuItemBuilder::with_id("close-window", "Close Window")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(handle)?;

            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&open_folder)
                .separator()
                .item(&close_tab)
                .item(&close_window)
                .build()?;

            let find_item = MenuItemBuilder::with_id("find-in-files", "Find in Files…")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(handle)?;

            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .item(&PredefinedMenuItem::undo(handle, None)?)
                .item(&PredefinedMenuItem::redo(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(handle, None)?)
                .item(&PredefinedMenuItem::copy(handle, None)?)
                .item(&PredefinedMenuItem::paste(handle, None)?)
                .item(&PredefinedMenuItem::select_all(handle, None)?)
                .separator()
                .item(&find_item)
                .build()?;

            let cmd_palette = MenuItemBuilder::with_id("command-palette", "Command Palette…")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(handle)?;
            let toggle_terminal = MenuItemBuilder::with_id("toggle-terminal", "Toggle Terminal")
                .accelerator("CmdOrCtrl+`")
                .build(handle)?;
            let toggle_search = MenuItemBuilder::with_id("toggle-search", "Toggle Search Panel")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(handle)?;

            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&cmd_palette)
                .item(&toggle_terminal)
                .item(&toggle_search)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(handle, None)?)
                .build()?;

            let menu = MenuBuilder::new(handle)
                .item(
                    &SubmenuBuilder::new(handle, "Klide")
                        .item(
                            &MenuItemBuilder::with_id("settings", "Settings…")
                                .accelerator("CmdOrCtrl+,")
                                .build(handle)?,
                        )
                        .separator()
                        .item(&PredefinedMenuItem::hide(handle, None)?)
                        .item(&PredefinedMenuItem::hide_others(handle, None)?)
                        .item(&PredefinedMenuItem::show_all(handle, None)?)
                        .separator()
                        .item(&PredefinedMenuItem::quit(handle, None)?)
                        .build()?,
                )
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |_app_handle, event| {
                let id = event.id().as_ref();
                match id {
                    "command-palette" => {
                        let _ = _app_handle.emit("menu:command-palette", ());
                    }
                    "find-in-files" => {
                        let _ = _app_handle.emit("menu:find-in-files", ());
                    }
                    "toggle-terminal" => {
                        let _ = _app_handle.emit("menu:toggle-terminal", ());
                    }
                    "toggle-search" => {
                        let _ = _app_handle.emit("menu:toggle-search", ());
                    }
                    "settings" => {
                        let _ = _app_handle.emit("menu:open-settings", ());
                    }
                    "close-tab" => {
                        let _ = _app_handle.emit("menu:close-tab", ());
                    }
                    "close-window" => {
                        let _ = _app_handle.emit("menu:close-window", ());
                    }
                    "open-folder" => {
                        let _ = _app_handle.emit("menu:open-folder", ());
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            delegate_pty_spawn,
            delegate_pty_write,
            delegate_pty_resize,
            delegate_pty_stop,
            delegate_pty_snapshot,
            delegate_pty_live_sessions,
            list_dir,
            read_text_file,
            path_exists,
            write_text_file,
            create_entry,
            rename_entry,
            delete_entry,
            reveal_entry,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_diff,
            git::git_branch_diff,
            list_agent_runs,
            read_agent_run,
            read_opencode_run,
            models::ai_provider_models,
            models::ai_provider_credits,
            models::ai_provider_model_meta,
            ai_subscription_status,
            app_user_info,
            models::ai_context_window,
            models::ai_model_supports_tools,
            models::ai_model_supports_reflection,
            models::ai_count_tokens,
            ai_list_tools,
            search_in_files,
            ai_provider_key_status,
            ai_set_provider_key,
            ai_clear_provider_key,
            ai_set_provider_key_reference,
            ai_clear_provider_key_reference,
            ai_model_pricing,
            custom_provider_list,
            custom_provider_upsert,
            custom_provider_remove,
            accounts_list,
            account_save_current,
            account_activate,
            set_active_workspace,
            ai_chat,
            local_servers::ai_local_server_start,
            local_servers::ai_local_server_stop,
            local_servers::ai_local_server_status,
            agent::agent_start_run,
            agent::agent_submit_user_turn,
            agent::agent_resolve_permission,
            agent::agent_resolve_diff,
            agent::agent_resolve_question,
            agent::agent_compact_context,
            agent::agent_abort_run,
            agent::agent_list_runs,
            agent::agent_read_run,
            agent::agent_list_checkpoints,
            agent::agent_revert_checkpoint,
            agent::agent_revert_run_checkpoints,
            skills::install_skill,
            skills::uninstall_skill,
            skills::list_filesystem_skills,
            memory_write,
            memory_list,
            memory_read,
            git::create_pr,
            git::git_log,
            git::git_checkout_branch,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_discard,
            git::git_stash,
            git::git_stash_list,
            git::git_pr_list,
            git::git_pr_view,
            git::git_pr_checkout,
            git::git_pr_merge,
            git::git_pr_open,
            git::git_pr_merged,
            git::git_worktree_add,
            git::git_worktree_list,
            git::git_worktree_merge,
            git::git_worktree_remove,
            git::project_create,
            git::project_clone
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
