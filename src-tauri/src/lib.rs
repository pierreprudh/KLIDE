mod agent;
mod memory;
mod pty;
use memory::{memory_list, memory_read, memory_write};
use pty::{
    delegate_pty_resize, delegate_pty_spawn, delegate_pty_stop, delegate_pty_write, pty_spawn,
    pty_write, DelegatePtyState, PtyState,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

const OLLAMA_URL: &str = "http://localhost:11434";
const MLX_DEFAULT_MODEL: &str = "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit";

static OLLAMA_MODELS_CACHE: LazyLock<Mutex<Option<(Instant, Vec<String>)>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    is_directory: bool,
}

#[derive(serde::Serialize)]
struct GitFile {
    path: String,
    status: String,
    staged: bool,
}

#[derive(serde::Serialize)]
struct GitStatus {
    branch: String,
    files: Vec<GitFile>,
}

#[derive(serde::Serialize)]
struct GitDiff {
    path: String,
    diff: String,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    author_email: String,
    /// Seconds since unix epoch.
    timestamp: i64,
    refs: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranch {
    name: String,
    is_current: bool,
    is_remote: bool,
    /// Commits ahead of the upstream tracking branch (-).
    ahead: i32,
    /// Commits behind the upstream tracking branch (+).
    behind: i32,
    last_subject: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitLog {
    branch: String,
    upstream: Option<String>,
    ahead: i32,
    behind: i32,
    /// ISO-8601 timestamp of the last `git fetch`.
    last_fetch_ms: Option<i64>,
    commits: Vec<GitCommit>,
    branches: Vec<GitBranch>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStash {
    index: u32,
    branch: String,
    message: String,
    /// ISO-8601 timestamp.
    timestamp: i64,
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequest {
    number: u32,
    title: String,
    state: String,
    is_draft: bool,
    author: String,
    head_ref: String,
    base_ref: String,
    url: String,
    additions: i64,
    deletions: i64,
    changed_files: i32,
    /// ISO-8601 updated timestamp.
    updated_at_ms: i64,
    /// "open" | "merged" | "closed" | "draft" — derived for the badge.
    badge: String,
    /// True if this PR targets the current branch.
    is_current_branch: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestDetails {
    number: u32,
    title: String,
    body: String,
    state: String,
    is_draft: bool,
    author: String,
    head_ref: String,
    base_ref: String,
    url: String,
    additions: i64,
    deletions: i64,
    changed_files: i32,
    /// "open" | "merged" | "closed" | "draft" — derived for the badge.
    badge: String,
    mergeable: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiChatResponse {
    pub(crate) content: String,
    pub(crate) thinking: Option<String>,
    pub(crate) tool_calls: Vec<serde_json::Value>,
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

// Keychain service name — all Klide API keys are stored under this service,
// keyed by provider id (the "account"). Keys never touch the React webview.
const KEYCHAIN_SERVICE: &str = "com.klide.app";

// Anthropic requires this header on every Messages API call; pinning a known
// version keeps the request/response shape stable as the API evolves.
const ANTHROPIC_VERSION: &str = "2023-06-01";

fn env_key(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set"))
}

// Environment variable each provider reads as a fallback when no key has been
// saved to the keychain. Kept so an existing shell-based dev setup still works.
fn provider_env_name(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("OPENAI_API_KEY"),
        "mistral" => Some("MISTRAL_API_KEY"),
        "xai" => Some("XAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        _ => None,
    }
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(|e| e.to_string())
}

// Look up a saved key, treating "no entry" and blank values as absent.
fn keyring_lookup(provider: &str) -> Option<String> {
    let value = keyring_entry(provider).ok()?.get_password().ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// Env fallback — keychain misses fall through to the provider's env var (and
// xAI also accepts the legacy GROK_API_KEY name).
fn env_fallback(provider: &str) -> Option<String> {
    if let Some(name) = provider_env_name(provider) {
        if let Ok(value) = env_key(name) {
            return Some(value);
        }
    }
    if provider == "xai" {
        if let Ok(value) = env_key("GROK_API_KEY") {
            return Some(value);
        }
    }
    None
}

fn provider_key(provider: &str) -> Result<Option<String>, String> {
    match provider {
        "ollama" | "mlx" => Ok(None),
        "openai" | "mistral" | "xai" | "anthropic" => {
            match keyring_lookup(provider).or_else(|| env_fallback(provider)) {
                Some(key) => Ok(Some(key)),
                None => Err(format!("No API key saved for {provider}")),
            }
        }
        _ => Err(format!("Provider \"{provider}\" is not wired yet")),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyStatus {
    has_key: bool,
    source: String, // "keychain" | "env" | "none"
}

// Report whether a usable key exists and where it comes from — never returns
// the key itself, so the value stays inside the Rust side.
#[tauri::command]
fn ai_provider_key_status(provider: String) -> ProviderKeyStatus {
    if keyring_lookup(&provider).is_some() {
        ProviderKeyStatus {
            has_key: true,
            source: "keychain".to_string(),
        }
    } else if env_fallback(&provider).is_some() {
        ProviderKeyStatus {
            has_key: true,
            source: "env".to_string(),
        }
    } else {
        ProviderKeyStatus {
            has_key: false,
            source: "none".to_string(),
        }
    }
}

#[tauri::command]
fn ai_set_provider_key(provider: String, key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key is empty".to_string());
    }
    keyring_entry(&provider)?
        .set_password(trimmed)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ai_clear_provider_key(provider: String) -> Result<(), String> {
    match keyring_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn is_subscription_provider(provider: &str) -> bool {
    matches!(provider, "claude-code" | "codex" | "opencode")
}

fn subscription_command(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude-code" => Ok("claude"),
        "codex" => Ok("codex"),
        "opencode" => Ok("opencode"),
        _ => Err(format!("Provider \"{provider}\" is not a subscription CLI")),
    }
}

fn provider_chat_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "openai" => Ok("https://api.openai.com/v1/chat/completions"),
        "mistral" => Ok("https://api.mistral.ai/v1/chat/completions"),
        "xai" => Ok("https://api.x.ai/v1/chat/completions"),
        "mlx" => Ok("http://127.0.0.1:8080/v1/chat/completions"),
        "openrouter" => Ok("https://openrouter.ai/api/v1/chat/completions"),
        _ => Err(format!(
            "Provider \"{provider}\" has no chat-completions endpoint"
        )),
    }
}

fn provider_models_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "openai" => Ok("https://api.openai.com/v1/models"),
        "mistral" => Ok("https://api.mistral.ai/v1/models"),
        "xai" => Ok("https://api.x.ai/v1/models"),
        "mlx" => Ok("http://127.0.0.1:8080/v1/models"),
        "openrouter" => Ok("https://openrouter.ai/api/v1/models"),
        _ => Err(format!("Provider \"{provider}\" has no models endpoint")),
    }
}

fn response_error(provider: &str, status: reqwest::StatusCode, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        format!("{provider} returned {status}")
    } else {
        format!("{provider} returned {status}: {trimmed}")
    }
}

fn normalize_model_ids(value: &serde_json::Value) -> Vec<String> {
    value
        .get("data")
        .and_then(|data| data.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m.get("id").and_then(|id| id.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
async fn ai_provider_models(provider: String) -> Result<Vec<String>, String> {
    if is_subscription_provider(&provider) {
        return subscription_models(&provider);
    }

    if provider == "ollama" {
        {
            let cache = OLLAMA_MODELS_CACHE.lock().unwrap();
            if let Some((ts, names)) = cache.as_ref() {
                if ts.elapsed() < Duration::from_secs(10) {
                    return Ok(names.clone());
                }
            }
        }
        let res = reqwest::get(format!("{OLLAMA_URL}/api/tags"))
            .await
            .map_err(|e| format!("Unable to reach Ollama: {e}"))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(response_error("Ollama", status, &body));
        }
        let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let names: Vec<String> = value
            .get("models")
            .and_then(|models| models.as_array())
            .map(|models| {
                models
                    .iter()
                    .filter_map(|m| m.get("name").and_then(|name| name.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        *OLLAMA_MODELS_CACHE.lock().unwrap() = Some((Instant::now(), names.clone()));
        return Ok(names);
    }

    if provider == "anthropic" {
        let key = provider_key("anthropic")?.ok_or_else(|| "Missing API key".to_string())?;
        let res = reqwest::Client::new()
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .send()
            .await
            .map_err(|e| format!("Unable to reach Anthropic: {e}"))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(response_error("Anthropic", status, &body));
        }
        let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        return Ok(normalize_model_ids(&value));
    }

    if provider == "mlx" {
        // mlx_lm.server's /v1/models endpoint is expensive/noisy and can
        // interfere with prompt processing. Klide treats MLX model selection
        // as an explicit configured value instead of polling the server.
        return Ok(vec![MLX_DEFAULT_MODEL.to_string()]);
    }

    let key = provider_key(&provider)?.ok_or_else(|| "Missing API key".to_string())?;
    let url = provider_models_url(&provider)?;
    let res = reqwest::Client::new()
        .get(url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("Unable to reach {provider}: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(response_error(&provider, status, &body));
    }
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(normalize_model_ids(&value))
}

fn subscription_models(provider: &str) -> Result<Vec<String>, String> {
    ensure_command_available(subscription_command(provider)?)?;
    let models = match provider {
        "claude-code" => claude_cached_models().unwrap_or_else(|| {
            vec![
                "claude-sonnet-4-6".to_string(),
                "claude-opus-4-6".to_string(),
                "claude-haiku-4-5-20251001".to_string(),
            ]
        }),
        "codex" => codex_cached_models().unwrap_or_else(|| {
            vec![
                "gpt-5.5".to_string(),
                "gpt-5.4".to_string(),
                "gpt-5.4-mini".to_string(),
                "gpt-5.3-codex".to_string(),
                "gpt-5.2".to_string(),
            ]
        }),
        "opencode" => opencode_cached_models().unwrap_or_else(|| vec!["opencode".to_string()]),
        _ => return Err(format!("Provider \"{provider}\" is not a subscription CLI")),
    };
    Ok(models)
}

fn opencode_cached_models() -> Option<Vec<String>> {
    let cli = resolve_command("opencode").ok()?;
    let output = std::process::Command::new(cli)
        .arg("models")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let models: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

fn claude_cached_models() -> Option<Vec<String>> {
    let home = std::env::var("HOME").ok()?;
    let claude_dir = std::path::Path::new(&home).join(".claude");
    let mut models = Vec::new();

    let stats_path = claude_dir.join("stats-cache.json");
    if let Ok(text) = std::fs::read_to_string(stats_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(usage) = value.get("modelUsage").and_then(|usage| usage.as_object()) {
                models.extend(
                    usage
                        .keys()
                        .filter(|model| is_claude_model_id(model))
                        .cloned(),
                );
            }
        }
    }

    collect_claude_models_from_dir(&claude_dir.join("projects"), &mut models, 0);
    models.sort_by(|a, b| {
        claude_model_rank(a)
            .cmp(&claude_model_rank(b))
            .then(b.cmp(a))
    });
    models.dedup();
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

fn collect_claude_models_from_dir(path: &std::path::Path, models: &mut Vec<String>, depth: usize) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_claude_models_from_dir(&path, models, depth + 1);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')) {
            if is_claude_model_id(token) {
                models.push(token.to_string());
            }
        }
    }
}

fn is_claude_model_id(model: &str) -> bool {
    let Some(rest) = model.strip_prefix("claude-") else {
        return false;
    };
    let family = rest.split('-').next().unwrap_or_default();
    if !matches!(family, "sonnet" | "opus" | "haiku") {
        return false;
    }
    let parts: Vec<&str> = rest.split('-').skip(1).collect();
    if parts.len() < 2 {
        return false;
    }
    parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

fn claude_model_rank(model: &str) -> usize {
    if model.contains("sonnet") {
        0
    } else if model.contains("opus") {
        1
    } else if model.contains("haiku") {
        2
    } else {
        3
    }
}

fn codex_cached_models() -> Option<Vec<String>> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home).join(".codex/models_cache.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let mut models: Vec<String> = value
        .get("models")?
        .as_array()?
        .iter()
        .filter(|model| model.get("visibility").and_then(|v| v.as_str()) != Some("hide"))
        .filter_map(|model| model.get("slug").and_then(|slug| slug.as_str()))
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

fn codex_context_window(model: &str) -> Option<usize> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home).join(".codex/models_cache.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("models")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("slug").and_then(|slug| slug.as_str()) == Some(model))
        .and_then(|entry| {
            entry
                .get("context_window")
                .and_then(|window| window.as_u64())
        })
        .map(|window| window as usize)
}

fn fallback_context_window(provider: &str, model: &str) -> usize {
    let lower = model.to_lowercase();
    if provider == "claude-code" || lower.starts_with("claude-") {
        200_000
    } else if provider == "codex" || lower.starts_with("gpt-5") {
        272_000
    } else if lower.starts_with("gpt-4.1") {
        1_000_000
    } else if lower.contains("gemini-2.5") {
        1_000_000
    } else if lower.contains("mistral-large") {
        128_000
    } else if lower.contains("grok") {
        256_000
    } else if provider == "mlx" || lower.contains("gemma") {
        128_000
    } else {
        128_000
    }
}

fn find_context_window(value: &serde_json::Value) -> Option<usize> {
    match value {
        serde_json::Value::Number(n) => n.as_u64().map(|n| n as usize),
        serde_json::Value::Object(map) => {
            for key in [
                "context_window",
                "max_context_window",
                "context_length",
                "num_ctx",
                "n_ctx",
                "llama.context_length",
            ] {
                if let Some(window) = map.get(key).and_then(find_context_window) {
                    return Some(window);
                }
            }
            for child in map.values() {
                if let Some(window) = find_context_window(child) {
                    if window >= 1024 {
                        return Some(window);
                    }
                }
            }
            None
        }
        serde_json::Value::Array(items) => items.iter().find_map(find_context_window),
        _ => None,
    }
}

#[tauri::command]
async fn ai_context_window(provider: String, model: String) -> Result<usize, String> {
    if provider == "codex" {
        return Ok(codex_context_window(&model)
            .unwrap_or_else(|| fallback_context_window(&provider, &model)));
    }

    if provider == "ollama" {
        let res = reqwest::Client::new()
            .post(format!("{OLLAMA_URL}/api/show"))
            .json(&serde_json::json!({ "model": model }))
            .send()
            .await
            .map_err(|e| format!("Unable to reach Ollama: {e}"))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(response_error("Ollama", status, &body));
        }
        let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        return Ok(
            find_context_window(&value).unwrap_or_else(|| fallback_context_window("ollama", ""))
        );
    }

    if provider == "mlx" {
        return Ok(fallback_context_window("mlx", &model));
    }

    Ok(fallback_context_window(&provider, &model))
}

#[tauri::command]
fn ai_subscription_status(provider: String) -> Result<AiConnectionStatus, String> {
    let command = subscription_command(&provider)?;
    let resolved = resolve_command(command);
    let command_path = resolved.as_ref().ok().cloned();
    let installed = resolved.is_ok();

    let login_options = match provider.as_str() {
        "claude-code" => vec![
            "claude auth login --claudeai".to_string(),
            "claude auth login --console".to_string(),
            "claude auth login --sso".to_string(),
            "claude setup-token".to_string(),
        ],
        "codex" => vec![
            "codex login".to_string(),
            "codex login --device-auth".to_string(),
            "codex login --with-api-key".to_string(),
            "codex login --with-access-token".to_string(),
        ],
        "opencode" => vec!["opencode".to_string()],
        _ => Vec::new(),
    };

    if !installed {
        return Ok(AiConnectionStatus {
            provider,
            installed: false,
            connected: false,
            detail: format!("{command} CLI is not installed or not on PATH"),
            command_path: None,
            login_options,
        });
    }

    let (connected, detail) = match provider.as_str() {
        "claude-code" => {
            let output = Command::new(command_path.as_deref().unwrap_or(command))
                .args(["auth", "status"])
                .output()
                .map_err(|e| format!("Unable to check Claude auth: {e}"))?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let value = serde_json::from_str::<serde_json::Value>(&stdout).ok();
            let logged_in = value
                .as_ref()
                .and_then(|v| v.get("loggedIn"))
                .and_then(|v| v.as_bool())
                .unwrap_or(output.status.success());
            let method = value
                .as_ref()
                .and_then(|v| v.get("authMethod"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let provider_name = value
                .as_ref()
                .and_then(|v| v.get("apiProvider"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            (
                logged_in,
                if logged_in {
                    format!("Logged in via {method} ({provider_name})")
                } else {
                    "Not logged in".to_string()
                },
            )
        }
        "codex" => {
            let output = Command::new(command_path.as_deref().unwrap_or(command))
                .args(["login", "status"])
                .output()
                .map_err(|e| format!("Unable to check Codex login: {e}"))?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let text = if stdout.is_empty() { stderr } else { stdout };
            let connected = output.status.success() && text.to_lowercase().contains("logged in");
            (
                connected,
                if text.is_empty() {
                    "Unknown".to_string()
                } else {
                    text
                },
            )
        }
        "opencode" => (
            true,
            "OpenCode CLI is installed; authentication is handled by OpenCode.".to_string(),
        ),
        _ => (false, "Unknown provider".to_string()),
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
async fn ai_model_supports_tools(provider: String, model: String) -> Result<bool, String> {
    if is_subscription_provider(&provider) {
        return Ok(true);
    }

    if provider == "ollama" {
        let res = reqwest::Client::new()
            .post(format!("{OLLAMA_URL}/api/show"))
            .json(&serde_json::json!({ "model": model }))
            .send()
            .await
            .map_err(|e| format!("Unable to reach Ollama: {e}"))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(response_error("Ollama", status, &body));
        }
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("Invalid Ollama model info: {e}"))?;
        let details = value.get("details");
        let family = details
            .and_then(|d| d.get("family"))
            .and_then(|v| v.as_str());
        if family == Some("deepseek") || family == Some("qwen2") {
            return Ok(true);
        }
        let has_tools = details
            .and_then(|d| d.get("capabilities"))
            .and_then(|c| c.get("tools"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        return Ok(has_tools);
    }

    if provider == "mlx" {
        return Ok(false);
    }

    Ok(true)
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    file: String,
    line: usize,
    column: usize,
    content: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    matches: Vec<SearchMatch>,
    file_count: usize,
    capped: bool,
}

#[tauri::command]
fn search_in_files(
    workspace_root: String,
    pattern: String,
    include: Option<String>,
) -> Result<SearchResult, String> {
    if pattern.trim().is_empty() {
        return Err("Pattern cannot be empty".to_string());
    }
    let root = std::path::Path::new(&workspace_root);
    if !root.is_dir() {
        return Err("Workspace root is not a directory".to_string());
    }

    const CAP: usize = 500;
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut file_count = 0_u32;
    let mut capped = false;

    let include_filter = include
        .as_ref()
        .filter(|s| !s.trim().is_empty() && s.as_str() != "*")
        .map(|s| {
            let s = s.trim();
            if s.starts_with('*') {
                &s[1..]
            } else {
                s
            }
        })
        .map(|s| s.to_lowercase());

    let mut pending: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if matches.len() >= CAP {
                capped = true;
                break;
            }
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if ft.is_dir() {
                if !matches!(
                    name.as_str(),
                    ".git"
                        | "node_modules"
                        | "target"
                        | "dist"
                        | ".next"
                        | ".cache"
                        | ".venv"
                        | "__pycache__"
                ) {
                    pending.push(path);
                }
                continue;
            }
            if ft.is_file() {
                if let Some(ref filter) = include_filter {
                    if !name.ends_with(filter) {
                        continue;
                    }
                }
                if path.metadata().map(|m| m.len() > 500_000).unwrap_or(true) {
                    continue;
                }
                let content = match std::fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let rel = path
                    .strip_prefix(root)
                    .ok()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.to_string_lossy().to_string());
                let mut found_in_file = false;
                for (idx, line) in content.lines().enumerate() {
                    if matches.len() >= CAP {
                        capped = true;
                        break;
                    }
                    if let Some(col) = line.find(&pattern) {
                        if !found_in_file {
                            file_count += 1;
                            found_in_file = true;
                        }
                        matches.push(SearchMatch {
                            file: rel.clone(),
                            line: idx + 1,
                            column: col + 1,
                            content: line.chars().take(300).collect(),
                        });
                    }
                }
            }
        }
        if capped {
            break;
        }
    }

    Ok(SearchResult {
        matches,
        file_count: file_count as usize,
        capped,
    })
}

#[tauri::command]
async fn ai_chat(
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    workspace_root: Option<String>,
    on_chunk: Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    if is_subscription_provider(&provider) {
        return subscription_cli_chat(provider, model, messages, workspace_root, &on_chunk).await;
    }
    if provider == "ollama" {
        return ollama_chat(model, messages, tools, &on_chunk).await;
    }
    if provider == "anthropic" {
        return anthropic_chat(model, messages, tools, &on_chunk).await;
    }
    if provider == "mlx" {
        return mlx_chat(model, messages, tools, &on_chunk).await;
    }
    openai_compatible_chat(provider, model, messages, tools, &on_chunk).await
}

fn resolve_command(command: &str) -> Result<String, String> {
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
    let candidates = match command {
        "claude" => vec![format!("{home}/.local/bin/claude")],
        "codex" => vec![
            format!("{home}/.local/bin/codex"),
            "/Applications/Codex.app/Contents/Resources/codex".to_string(),
        ],
        "opencode" => vec![
            format!("{home}/.opencode/bin/opencode"),
            format!("{home}/.local/bin/opencode"),
        ],
        "mlx_lm.server" => vec![
            format!("{home}/.pyenv/shims/mlx_lm.server"),
            format!("{home}/.local/bin/mlx_lm.server"),
        ],
        _ => Vec::new(),
    };
    candidates
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
        .ok_or_else(|| format!("{command} CLI is not installed or not on PATH"))
}

fn ensure_command_available(command: &str) -> Result<(), String> {
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

fn prompt_from_messages(messages: &[serde_json::Value]) -> String {
    let mut out = String::from(
        "You are running as a subscription CLI backend inside Klide.\n\
         Answer the user's latest request using the conversation below.\n\
         Follow the active Klide mode described in the system message. In Goal mode,\n\
         you may edit files directly in the current workspace; Klide will surface the\n\
         resulting file and git diffs after you finish. In Chat or Plan mode, do not\n\
         edit files unless the mode instructions explicitly allow it.\n\n",
    );

    for message in messages {
        let role = message
            .get("role")
            .and_then(|role| role.as_str())
            .unwrap_or("message");
        if role == "tool" {
            continue;
        }
        let content = text_from_message(message);
        if content.trim().is_empty() {
            continue;
        }
        out.push_str(&format!("[{role}]\n{content}\n\n"));
    }
    out
}

async fn run_cli_with_stdin(
    mut command: TokioCommand,
    prompt: String,
    label: &str,
    on_chunk: &Channel<StreamChunk>,
) -> Result<String, String> {
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Unable to start {label}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Unable to write prompt to {label}: {e}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stderr"))?;

    let (status, stdout, stderr) = timeout(Duration::from_secs(180), async {
        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut stderr_lines = BufReader::new(stderr).lines();
        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut stdout_text = String::new();
        let mut stderr_text = String::new();

        while !stdout_done || !stderr_done {
            tokio::select! {
                line = stdout_lines.next_line(), if !stdout_done => {
                    match line.map_err(|e| format!("Unable to read {label} stdout: {e}"))? {
                        Some(line) => {
                            stdout_text.push_str(&line);
                            stdout_text.push('\n');
                            let _ = on_chunk.send(StreamChunk {
                                content: format!("{line}\n"),
                                thinking: String::new(),
                            });
                        }
                        None => stdout_done = true,
                    }
                }
                line = stderr_lines.next_line(), if !stderr_done => {
                    match line.map_err(|e| format!("Unable to read {label} stderr: {e}"))? {
                        Some(line) => {
                            stderr_text.push_str(&line);
                            stderr_text.push('\n');
                            let _ = on_chunk.send(StreamChunk {
                                content: format!("stderr: {line}\n"),
                                thinking: String::new(),
                            });
                        }
                        None => stderr_done = true,
                    }
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("Unable to read {label} exit status: {e}"))?;
        Ok::<_, String>((
            status,
            stdout_text.trim().to_string(),
            stderr_text.trim().to_string(),
        ))
    })
    .await
    .map_err(|_| format!("{label} timed out after 180 seconds"))?
    .map_err(|e| e)?;

    if status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else if stderr.is_empty() {
        Err(format!("{label} exited with {status}"))
    } else {
        Err(format!("{label} exited with {status}: {stderr}"))
    }
}

async fn subscription_cli_chat(
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    workspace_root: Option<String>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let prompt = prompt_from_messages(&messages);
    let cwd = workspace_root.unwrap_or_else(|| ".".to_string());

    let content = match provider.as_str() {
        "claude-code" => {
            let cli = resolve_command("claude")?;
            let mut command = TokioCommand::new(cli);
            command
                .current_dir(&cwd)
                .arg("-p")
                .arg("--model")
                .arg(model)
                .arg("--permission-mode")
                .arg("acceptEdits")
                .arg("--output-format")
                .arg("text");
            run_cli_with_stdin(command, prompt, "Claude Code", on_chunk).await?
        }
        "codex" => {
            let cli = resolve_command("codex")?;
            let mut command = TokioCommand::new(cli);
            command
                .arg("exec")
                .arg("-m")
                .arg(model)
                .arg("-s")
                .arg("workspace-write")
                .arg("-C")
                .arg(&cwd)
                .arg("--skip-git-repo-check")
                .arg("--color")
                .arg("never")
                .arg("-");
            run_cli_with_stdin(command, prompt, "Codex", on_chunk).await?
        }
        "opencode" => {
            ensure_command_available("opencode")?;
            return Err("OpenCode is available as an interactive PTY delegate.".to_string());
        }
        _ => return Err(format!("Provider \"{provider}\" is not wired yet")),
    };

    Ok(AiChatResponse {
        content,
        thinking: None,
        tool_calls: Vec::new(),
    })
}

// ── Provider streaming trait + shared loop ──────────────────────────────

trait StreamingProvider {
    type ToolAccumulator: Default;

    fn name(&self) -> &str;

    fn build_request(&self, client: &reqwest::Client) -> Result<reqwest::RequestBuilder, String>;

    /// Parse one streamed line. Err means the provider reported a fatal
    /// mid-stream error (delivered over HTTP 200) — the whole request fails.
    /// `on_chunk` is a closure so unit tests can record chunks without
    /// spinning up a Tauri `Channel`.
    fn parse_line(
        &mut self,
        line: &str,
        content: &mut String,
        thinking: &mut String,
        tools: &mut Self::ToolAccumulator,
        on_chunk: &dyn Fn(StreamChunk),
    ) -> Result<(), String>;

    fn finalize_response(
        content: String,
        thinking: String,
        tools: Self::ToolAccumulator,
    ) -> AiChatResponse;
}

async fn stream_provider<S: StreamingProvider>(
    provider: S,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("Unable to build HTTP client: {e}"))?;
    let res = provider
        .build_request(&client)?
        .send()
        .await
        .map_err(|e| format!("Unable to reach {}: {e}", provider.name()))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(response_error(provider.name(), status, &text));
    }

    let mut content = String::new();
    let mut thinking = String::new();
    let mut tools = S::ToolAccumulator::default();
    // Buffer raw bytes and only decode complete lines: a multi-byte UTF-8
    // char can be split across network chunks, and decoding each chunk
    // separately would corrupt it into U+FFFD (and break the line's JSON).
    let mut buf: Vec<u8> = Vec::new();

    // Bridge the Tauri `Channel` (a one-shot sink) to the `&dyn Fn` sink the
    // trait expects. `send` returns a Result we deliberately swallow: a
    // dropped webview should fail the request, not the individual chunk.
    let send = |chunk: StreamChunk| {
        let _ = on_chunk.send(chunk);
    };

    let mut stream = res;
    let mut provider = provider;
    while let Some(bytes) = stream.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&bytes);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            provider.parse_line(&line, &mut content, &mut thinking, &mut tools, &send)?;
        }
    }
    if buf.iter().any(|b| !b.is_ascii_whitespace()) {
        let line = String::from_utf8_lossy(&buf).to_string();
        provider.parse_line(&line, &mut content, &mut thinking, &mut tools, &send)?;
    }

    Ok(S::finalize_response(content, thinking, tools))
}

// ── Ollama adapter ──

struct OllamaAdapter {
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
}

impl StreamingProvider for OllamaAdapter {
    type ToolAccumulator = Vec<serde_json::Value>;

    fn name(&self) -> &str {
        "Ollama"
    }

    fn build_request(&self, client: &reqwest::Client) -> Result<reqwest::RequestBuilder, String> {
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": self.messages,
            "stream": true,
        });
        if let Some(tools) = &self.tools {
            body["tools"] = serde_json::Value::Array(tools.clone());
        }
        Ok(client.post(format!("{OLLAMA_URL}/api/chat")).json(&body))
    }

    fn parse_line(
        &mut self,
        line: &str,
        content: &mut String,
        thinking: &mut String,
        tools: &mut Self::ToolAccumulator,
        on_chunk: &dyn Fn(StreamChunk),
    ) -> Result<(), String> {
        let line = line.trim();
        if line.is_empty() {
            return Ok(());
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return Ok(());
        };
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            return Err(format!("Ollama error: {error}"));
        }
        let Some(message) = value.get("message") else {
            return Ok(());
        };
        let c = message
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let t = message
            .get("thinking")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if !c.is_empty() || !t.is_empty() {
            content.push_str(c);
            thinking.push_str(t);
            on_chunk(StreamChunk {
                content: c.to_string(),
                thinking: t.to_string(),
            });
        }
        if let Some(calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
            tools.extend(calls.iter().cloned());
        }
        Ok(())
    }

    fn finalize_response(
        content: String,
        thinking: String,
        tools: Self::ToolAccumulator,
    ) -> AiChatResponse {
        AiChatResponse {
            content,
            thinking: if thinking.is_empty() {
                None
            } else {
                Some(thinking)
            },
            tool_calls: tools,
        }
    }
}

async fn ollama_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let adapter = OllamaAdapter {
        model,
        messages,
        tools,
    };
    stream_provider(adapter, on_chunk).await
}

// ── OpenAI-compatible adapter ──

#[derive(Default)]
struct OpenAiToolAcc {
    id: String,
    name: String,
    args: String,
}

struct OpenAiAdapter {
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    key: Option<String>,
}

impl StreamingProvider for OpenAiAdapter {
    type ToolAccumulator = Vec<OpenAiToolAcc>;

    fn name(&self) -> &str {
        &self.provider
    }

    fn build_request(&self, client: &reqwest::Client) -> Result<reqwest::RequestBuilder, String> {
        let body = openai_chat_body(
            &self.model,
            self.messages.clone(),
            self.tools.clone(),
            self.provider != "mlx",
        );
        let mut req = client.post(provider_chat_url(&self.provider)?).json(&body);
        if let Some(key) = &self.key {
            req = req.bearer_auth(key);
        }
        Ok(req)
    }

    fn parse_line(
        &mut self,
        line: &str,
        content: &mut String,
        _thinking: &mut String,
        tools: &mut Self::ToolAccumulator,
        on_chunk: &dyn Fn(StreamChunk),
    ) -> Result<(), String> {
        let Some(data) = line.trim().strip_prefix("data:") else {
            return Ok(());
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(());
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return Ok(());
        };
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("stream error");
            return Err(format!("{} error: {message}", self.provider));
        }
        let Some(delta) = value
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .and_then(|c| c.get("delta"))
        else {
            return Ok(());
        };
        if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
            if !c.is_empty() {
                content.push_str(c);
                on_chunk(StreamChunk {
                    content: c.to_string(),
                    thinking: String::new(),
                });
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for call in calls {
                let index = call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                while tools.len() <= index {
                    tools.push(OpenAiToolAcc::default());
                }
                let acc = &mut tools[index];
                if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                    acc.id = id.to_string();
                }
                if let Some(function) = call.get("function") {
                    if let Some(name) = function.get("name").and_then(|v| v.as_str()) {
                        acc.name.push_str(name);
                    }
                    if let Some(args) = function.get("arguments").and_then(|v| v.as_str()) {
                        acc.args.push_str(args);
                    }
                }
            }
        }
        Ok(())
    }

    fn finalize_response(
        content: String,
        _thinking: String,
        tools: Self::ToolAccumulator,
    ) -> AiChatResponse {
        let (content, thinking) = split_thinking_tags(&content);
        let tool_calls: Vec<serde_json::Value> = tools
            .into_iter()
            .filter(|t| !t.name.is_empty())
            .map(|t| {
                serde_json::json!({
                    "id": t.id, "type": "function",
                    "function": { "name": t.name, "arguments": t.args },
                })
            })
            .collect();
        AiChatResponse {
            content,
            thinking: if thinking.trim().is_empty() {
                None
            } else {
                Some(thinking)
            },
            tool_calls,
        }
    }
}

fn openai_chat_body(
    model: &str,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    include_tools: bool,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": normalize_openai_messages(messages),
        "stream": true,
    });
    if include_tools {
        if let Some(tools) = tools {
            if !tools.is_empty() {
                body["tools"] = serde_json::Value::Array(tools);
                body["tool_choice"] = serde_json::json!("auto");
            }
        }
    }
    body
}

fn split_thinking_tags(raw: &str) -> (String, String) {
    const OPEN: &str = "<think>";
    const CLOSE: &str = "</think>";
    let mut thinking = String::new();
    let mut content = String::new();
    let mut rest = raw;
    loop {
        let Some(open) = rest.find(OPEN) else {
            content.push_str(rest);
            break;
        };
        content.push_str(&rest[..open]);
        let after_open = &rest[open + OPEN.len()..];
        let Some(close) = after_open.find(CLOSE) else {
            thinking.push_str(after_open);
            break;
        };
        thinking.push_str(&after_open[..close]);
        rest = &after_open[close + CLOSE.len()..];
    }
    (content.trim_start().to_string(), thinking)
}

async fn openai_compatible_chat(
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let key = provider_key(&provider)?.ok_or_else(|| "Missing API key".to_string())?;
    let adapter = OpenAiAdapter {
        provider,
        model,
        messages,
        tools,
        key: Some(key),
    };
    stream_provider(adapter, on_chunk).await
}

async fn mlx_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let adapter = OpenAiAdapter {
        provider: "mlx".to_string(),
        model,
        messages,
        tools,
        key: None,
    };
    stream_provider(adapter, on_chunk).await
}

fn normalize_openai_messages(messages: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    messages
        .into_iter()
        .map(|mut message| {
            if let Some(calls) = message
                .get_mut("tool_calls")
                .and_then(|calls| calls.as_array_mut())
            {
                for call in calls {
                    if let Some(arguments) = call
                        .get_mut("function")
                        .and_then(|function| function.get_mut("arguments"))
                    {
                        if !arguments.is_string() {
                            *arguments = serde_json::Value::String(arguments.to_string());
                        }
                    }
                }
            }
            message
        })
        .collect()
}

// ── Anthropic helpers ──

fn anthropic_push(
    turns: &mut Vec<(String, Vec<serde_json::Value>)>,
    role: &str,
    blocks: Vec<serde_json::Value>,
) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = turns.last_mut() {
        if last.0 == role {
            last.1.extend(blocks);
            return;
        }
    }
    turns.push((role.to_string(), blocks));
}

fn anthropic_messages(messages: Vec<serde_json::Value>) -> (String, Vec<serde_json::Value>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut turns: Vec<(String, Vec<serde_json::Value>)> = Vec::new();
    for message in &messages {
        let role = message
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("user");
        match role {
            "system" => {
                let text = text_from_message(message);
                if !text.trim().is_empty() {
                    system_parts.push(text);
                }
            }
            "tool" => {
                let id = message
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let block = serde_json::json!({ "type": "tool_result", "tool_use_id": id, "content": text_from_message(message) });
                anthropic_push(&mut turns, "user", vec![block]);
            }
            "assistant" => {
                let mut blocks = Vec::new();
                let text = text_from_message(message);
                if !text.trim().is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": text }));
                }
                if let Some(calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
                    for call in calls {
                        let id = call.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                        let function = call.get("function");
                        let name = function
                            .and_then(|f| f.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let input = match function.and_then(|f| f.get("arguments")) {
                            Some(serde_json::Value::String(s)) => {
                                serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({}))
                            }
                            Some(other) => other.clone(),
                            None => serde_json::json!({}),
                        };
                        blocks.push(serde_json::json!({ "type": "tool_use", "id": id, "name": name, "input": input }));
                    }
                }
                anthropic_push(&mut turns, "assistant", blocks);
            }
            _ => {
                let text = text_from_message(message);
                if !text.trim().is_empty() {
                    anthropic_push(
                        &mut turns,
                        "user",
                        vec![serde_json::json!({ "type": "text", "text": text })],
                    );
                }
            }
        }
    }
    let out = turns
        .into_iter()
        .map(|(role, blocks)| serde_json::json!({ "role": role, "content": blocks }))
        .collect();
    (system_parts.join("\n\n"), out)
}

fn anthropic_tools(tools: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    tools
        .into_iter()
        .filter_map(|t| {
            let function = t.get("function")?;
            let name = function.get("name")?.as_str()?;
            let mut tool = serde_json::json!({ "name": name });
            if let Some(desc) = function.get("description") {
                tool["description"] = desc.clone();
            }
            tool["input_schema"] = function
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
            Some(tool)
        })
        .collect()
}

// ── Anthropic adapter ──

#[derive(Default)]
struct AnthropicToolAcc {
    id: String,
    name: String,
    args: String,
}

struct AnthropicAdapter {
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    key: String,
}

impl StreamingProvider for AnthropicAdapter {
    type ToolAccumulator = Vec<AnthropicToolAcc>;

    fn name(&self) -> &str {
        "Anthropic"
    }

    fn build_request(&self, client: &reqwest::Client) -> Result<reqwest::RequestBuilder, String> {
        let (system, msgs) = anthropic_messages(self.messages.clone());
        let mut body = serde_json::json!({
            "model": self.model,
            "max_tokens": 4096,
            "stream": true,
            "messages": msgs,
        });
        if !system.trim().is_empty() {
            body["system"] = serde_json::Value::String(system);
        }
        if let Some(tools) = &self.tools {
            let converted = anthropic_tools(tools.clone());
            if !converted.is_empty() {
                body["tools"] = serde_json::Value::Array(converted);
                body["tool_choice"] = serde_json::json!({ "type": "auto" });
            }
        }
        Ok(client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body))
    }

    fn parse_line(
        &mut self,
        line: &str,
        content: &mut String,
        _thinking: &mut String,
        tools: &mut Self::ToolAccumulator,
        on_chunk: &dyn Fn(StreamChunk),
    ) -> Result<(), String> {
        let Some(data) = line.trim().strip_prefix("data:") else {
            return Ok(());
        };
        let data = data.trim();
        if data.is_empty() {
            return Ok(());
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return Ok(());
        };
        match value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
        {
            // Anthropic delivers mid-stream failures as `error` events over
            // HTTP 200 — they must fail the request, not vanish.
            "error" => {
                let message = value
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("stream error");
                return Err(format!("Anthropic error: {message}"));
            }
            "content_block_start" => {
                let index = value.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                while tools.len() <= index {
                    tools.push(AnthropicToolAcc::default());
                }
                if let Some(cb) = value.get("content_block") {
                    if cb.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        let acc = &mut tools[index];
                        acc.id = cb
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        acc.name = cb
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                    }
                }
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                while tools.len() <= index {
                    tools.push(AnthropicToolAcc::default());
                }
                let Some(delta) = value.get("delta") else {
                    return Ok(());
                };
                match delta.get("type").and_then(|v| v.as_str()) {
                    Some("text_delta") => {
                        if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                content.push_str(t);
                                on_chunk(StreamChunk {
                                    content: t.to_string(),
                                    thinking: String::new(),
                                });
                            }
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(p) = delta.get("partial_json").and_then(|v| v.as_str()) {
                            tools[index].args.push_str(p);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn finalize_response(
        content: String,
        _thinking: String,
        tools: Self::ToolAccumulator,
    ) -> AiChatResponse {
        let tool_calls: Vec<serde_json::Value> = tools
            .into_iter()
            .filter(|b| !b.name.is_empty())
            .map(|b| {
                serde_json::json!({
                    "id": b.id, "type": "function",
                    "function": {
                        "name": b.name,
                        "arguments": if b.args.is_empty() { "{}".to_string() } else { b.args },
                    },
                })
            })
            .collect();
        AiChatResponse {
            content,
            thinking: None,
            tool_calls,
        }
    }
}

async fn anthropic_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let key = provider_key("anthropic")?.ok_or_else(|| "Missing API key".to_string())?;
    let adapter = AnthropicAdapter {
        model,
        messages,
        tools,
        key,
    };
    stream_provider(adapter, on_chunk).await
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FsEntry>, String> {
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
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Unable to read file: {e}"))
}

/// Guard for explorer file operations: the entry's parent directory must
/// resolve inside the opened workspace. Canonicalizing both sides defeats
/// `..` segments and symlink tricks.
fn assert_in_workspace(workspace_root: &str, path: &std::path::Path) -> Result<(), String> {
    let root = std::fs::canonicalize(workspace_root)
        .map_err(|e| format!("Invalid workspace root: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "Path has no parent folder".to_string())?;
    let parent = std::fs::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;
    if parent.starts_with(&root) {
        Ok(())
    } else {
        Err("Path is outside the open workspace".to_string())
    }
}

#[tauri::command]
fn create_entry(workspace_root: String, path: String, is_directory: bool) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    assert_in_workspace(&workspace_root, &target)?;
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
    let from_path = std::path::PathBuf::from(&from);
    let to_path = std::path::PathBuf::from(&to);
    assert_in_workspace(&workspace_root, &from_path)?;
    assert_in_workspace(&workspace_root, &to_path)?;
    if to_path.exists() {
        return Err("An entry with that name already exists".to_string());
    }
    std::fs::rename(&from_path, &to_path).map_err(|e| format!("Unable to rename: {e}"))
}

#[tauri::command]
fn delete_entry(workspace_root: String, path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    assert_in_workspace(&workspace_root, &target)?;
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

fn run_git(workspace_root: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn git_output(workspace_root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn count_diff_lines(diff: &str) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;

    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }

    (additions, deletions)
}

#[tauri::command]
fn git_status(workspace_root: String) -> Result<GitStatus, String> {
    let output = Command::new("git")
        .args(["-C", &workspace_root, "status", "--short", "--branch"])
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branch = "unknown".to_string();
    let mut files = Vec::new();

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest.split("...").next().unwrap_or(rest).trim().to_string();
            continue;
        }

        if line.len() < 4 {
            continue;
        }

        let staged = &line[0..1] != " " && &line[0..1] != "?";
        let status = line[0..2].trim().to_string();
        let path = line[3..].trim().to_string();
        files.push(GitFile {
            path,
            status,
            staged,
        });
    }

    Ok(GitStatus { branch, files })
}

#[tauri::command]
fn git_stage(workspace_root: String, path: String) -> Result<(), String> {
    run_git(&workspace_root, &["add", "--", &path])
}

#[tauri::command]
fn git_unstage(workspace_root: String, path: String) -> Result<(), String> {
    run_git(&workspace_root, &["restore", "--staged", "--", &path])
}

#[tauri::command]
fn git_commit(workspace_root: String, message: String) -> Result<(), String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    run_git(&workspace_root, &["commit", "-m", trimmed])
}

#[tauri::command]
fn create_pr(
    workspace_root: String,
    title: String,
    body: Option<String>,
) -> Result<String, String> {
    // Create a branch from the current changes. Cap the name at 50 chars —
    // truncate() takes a BYTE index and panics mid-char on non-ASCII titles
    // (is_alphanumeric keeps accented/Unicode letters), so count chars instead.
    let branch: String = format!(
        "klide/{}",
        title
            .to_lowercase()
            .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
            .trim_matches('-')
    )
    .chars()
    .take(50)
    .collect();

    // Check if gh CLI is available
    let gh_check = Command::new("gh").arg("--version").output();
    if gh_check.is_err() || !gh_check.unwrap().status.success() {
        return Err(
            "GitHub CLI (gh) is not installed. Install it with: brew install gh".to_string(),
        );
    }

    // Stage all changes
    run_git(&workspace_root, &["add", "-A"])?;

    // Check if there's anything to commit
    let status = Command::new("git")
        .args(["-C", &workspace_root, "diff", "--cached", "--quiet"])
        .status()
        .map_err(|e| format!("Failed to check git status: {e}"))?;
    if status.success() {
        return Err("No changes to commit".to_string());
    }

    // Create and switch to new branch
    run_git(&workspace_root, &["checkout", "-b", &branch])?;

    // Commit the staged changes before pushing; otherwise the PR branch has no
    // new commits for GitHub to compare against the base branch.
    run_git(&workspace_root, &["commit", "-m", title.trim()])?;

    let push = Command::new("git")
        .args([
            "-C",
            &workspace_root,
            "push",
            "-u",
            "origin",
            branch.as_str(),
        ])
        .output()
        .map_err(|e| format!("Failed to push: {e}"))?;
    if !push.status.success() {
        let err = String::from_utf8_lossy(&push.stderr);
        let _ = Command::new("git")
            .args(["-C", &workspace_root, "checkout", "-"])
            .status();
        let _ = Command::new("git")
            .args(["-C", &workspace_root, "branch", "-D", branch.as_str()])
            .status();
        return Err(format!("Push failed: {}", err.trim()));
    }

    let mut gh_args = vec!["pr", "create", "--title", &title, "--head", branch.as_str()];
    let body_str;
    if let Some(b) = &body {
        body_str = b.clone();
        gh_args.push("--body");
        gh_args.push(&body_str);
    }

    let pr = Command::new("gh")
        .args(gh_args)
        .current_dir(&workspace_root)
        .output()
        .map_err(|e| format!("Failed to create PR: {e}"))?;

    if pr.status.success() {
        let url = String::from_utf8_lossy(&pr.stdout).trim().to_string();
        Ok(if url.is_empty() {
            format!("PR created on branch '{branch}'")
        } else {
            url
        })
    } else {
        let err = String::from_utf8_lossy(&pr.stderr);
        Err(format!("PR creation failed: {}", err.trim()))
    }
}

#[tauri::command]
fn create_worktree(workspace_root: String, name: String) -> Result<String, String> {
    let safe = name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let branch = format!("feature/{safe}");
    let worktree_path = format!("{}-{}", workspace_root.trim_end_matches('/'), safe);

    run_git(&workspace_root, &["checkout", "-b", &branch])?;
    let output = Command::new("git")
        .args([
            "-C",
            &workspace_root,
            "worktree",
            "add",
            worktree_path.as_str(),
            &branch,
        ])
        .output()
        .map_err(|e| format!("Failed to create worktree: {e}"))?;

    if !output.status.success() {
        let _ = run_git(&workspace_root, &["checkout", "-"]);
        let _ = run_git(&workspace_root, &["branch", "-D", &branch]);
        return Err(format!(
            "Worktree creation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(worktree_path)
}

#[tauri::command]
fn git_diff(workspace_root: String, path: String, staged: bool) -> Result<GitDiff, String> {
    let diff = if staged {
        git_output(&workspace_root, &["diff", "--cached", "--", &path])?
    } else {
        git_output(&workspace_root, &["diff", "--", &path])?
    };

    let diff = if diff.trim().is_empty() && !staged {
        let untracked = git_output(
            &workspace_root,
            &["ls-files", "--others", "--exclude-standard", "--", &path],
        )?;
        if untracked.lines().any(|line| line == path) {
            let full_path = std::path::Path::new(&workspace_root).join(&path);
            let content = std::fs::read_to_string(&full_path)
                .map_err(|e| format!("Unable to read untracked file: {e}"))?;
            let mut out = format!(
                "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
            );
            for line in content.lines() {
                out.push('+');
                out.push_str(line);
                out.push('\n');
            }
            if content.ends_with('\n') {
                // content.lines() omits the final empty segment; no extra line is needed.
            }
            out
        } else {
            diff
        }
    } else {
        diff
    };

    let (additions, deletions) = count_diff_lines(&diff);
    Ok(GitDiff {
        path,
        diff,
        additions,
        deletions,
    })
}

// -----------------------------------------------------------------------------
// Git Review — full-window view: history, branches, sync, stash, PRs.
// -----------------------------------------------------------------------------

fn parse_porcelain_timestamp(s: &str) -> i64 {
    // `git log --format=%ct` returns a unix timestamp in seconds.
    s.trim().parse::<i64>().unwrap_or(0)
}

fn resolve_git_log(workspace_root: &str, limit: usize) -> Result<GitLog, String> {
    // Branches — current, local, remote. We grab them with `for-each-ref` so
    // we can pull ahead/behind and the subject of the tip commit in one shot.
    let branch_out = git_output(
        workspace_root,
        &[
            "for-each-ref",
            "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(ahead:integer)/%(behind:integer)%00%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut branches: Vec<GitBranch> = Vec::new();
    for line in branch_out.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 5 {
            continue;
        }
        let is_current = parts[0] == "*";
        let name = parts[1].to_string();
        // Skip the HEAD remote pointer (e.g. "origin/main" pointing to where
        // origin/main currently is on the remote); the user wants real refs.
        let is_remote = name.contains('/');
        let (ahead, behind) = if parts[3] == "-" {
            (0, 0)
        } else {
            let mut split = parts[3].split('/');
            (
                split.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                split.next().and_then(|n| n.parse().ok()).unwrap_or(0),
            )
        };
        branches.push(GitBranch {
            name,
            is_current,
            is_remote,
            ahead,
            behind,
            last_subject: parts[4].to_string(),
        });
    }
    // Local branches first, then remotes — but keep the current branch pinned
    // at the very top of the local group.
    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_remote.cmp(&b.is_remote))
            .then(a.name.cmp(&b.name))
    });

    // Commits — use a custom format so we can pull refs (tags, branch tips) in
    // the same pass.
    let log_out = git_output(
        workspace_root,
        &[
            "log",
            &format!("-n{limit}"),
            "--date=unix",
            "--decorate=short",
            "--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%ct%x00%d",
        ],
    )?;
    let mut commits: Vec<GitCommit> = Vec::new();
    for line in log_out.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 7 {
            continue;
        }
        // The decorate field looks like " (HEAD -> main, origin/main, tag: v1)"
        // — strip the parens and the leading "HEAD ->" marker, then split on
        // commas and trim. Filter to refs that are real names.
        let refs: Vec<String> = parts[6]
            .trim()
            .trim_matches('(')
            .trim_matches(')')
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "HEAD")
            .collect();
        commits.push(GitCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            author_email: parts[4].to_string(),
            timestamp: parse_porcelain_timestamp(parts[5]),
            refs,
        });
    }

    // Current branch + upstream.
    let branch = git_output(workspace_root, &["branch", "--show-current"])?;
    let branch = branch.trim().to_string();
    let branch = if branch.is_empty() {
        "HEAD".to_string()
    } else {
        branch
    };
    let upstream = git_output(
        workspace_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok();
    let upstream = upstream
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // ahead/behind relative to upstream.
    let (ahead, behind) = match &upstream {
        Some(up) => {
            let ab = git_output(
                workspace_root,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("{up}...HEAD"),
                ],
            )
            .unwrap_or_default();
            let mut it = ab.split_whitespace();
            (
                it.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                it.next().and_then(|n| n.parse().ok()).unwrap_or(0),
            )
        }
        None => (0, 0),
    };

    // Last fetch — use the mtime of .git/FETCH_HEAD. We never write that
    // ourselves; it only ever gets touched by `git fetch`.
    let last_fetch_ms = std::path::Path::new(workspace_root)
        .join(".git")
        .join("FETCH_HEAD")
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);

    Ok(GitLog {
        branch,
        upstream,
        ahead,
        behind,
        last_fetch_ms,
        commits,
        branches,
    })
}

#[tauri::command]
fn git_log(workspace_root: String, limit: Option<usize>) -> Result<GitLog, String> {
    let limit = limit.unwrap_or(60).clamp(5, 500);
    resolve_git_log(&workspace_root, limit)
}

#[tauri::command]
fn git_checkout_branch(workspace_root: String, branch: String) -> Result<(), String> {
    if branch.is_empty() {
        return Err("Branch name is required".to_string());
    }
    run_git(&workspace_root, &["checkout", &branch])
}

#[tauri::command]
fn git_fetch(workspace_root: String, remote: Option<String>) -> Result<String, String> {
    let remote = remote.unwrap_or_else(|| "--all".to_string());
    run_git(&workspace_root, &["fetch", &remote])?;
    Ok(format!("Fetched {remote}"))
}

#[tauri::command]
fn git_pull(workspace_root: String) -> Result<String, String> {
    run_git(&workspace_root, &["pull", "--ff-only"])?;
    Ok("Pulled (fast-forward)".to_string())
}

#[tauri::command]
fn git_push(workspace_root: String) -> Result<String, String> {
    // `git push` follows the upstream if configured; if not, this errors and
    // the UI surfaces a clear message. The user can set upstream via
    // `git push -u origin <branch>` if needed.
    run_git(&workspace_root, &["push"])?;
    Ok("Pushed".to_string())
}

#[tauri::command]
fn git_discard(workspace_root: String, path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("Path is required".to_string());
    }
    // `git checkout -- <path>` restores the working tree to the index. For
    // untracked files we just remove them.
    if path == "." {
        run_git(&workspace_root, &["checkout", "--", "."])?;
        run_git(&workspace_root, &["clean", "-fd"])?;
    } else {
        run_git(&workspace_root, &["checkout", "--", &path])?;
    }
    Ok(())
}

#[tauri::command]
fn git_stash(
    workspace_root: String,
    action: String,
    message: Option<String>,
) -> Result<String, String> {
    match action.as_str() {
        "push" => {
            let msg = message.unwrap_or_else(|| "WIP".to_string());
            run_git(&workspace_root, &["stash", "push", "-m", &msg])?;
            Ok(format!("Stashed as '{msg}'"))
        }
        "pop" => {
            run_git(&workspace_root, &["stash", "pop"])?;
            Ok("Stash popped".to_string())
        }
        "apply" => {
            run_git(&workspace_root, &["stash", "apply"])?;
            Ok("Stash applied".to_string())
        }
        "drop" => {
            run_git(&workspace_root, &["stash", "drop"])?;
            Ok("Stash dropped".to_string())
        }
        "list" => git_output(&workspace_root, &["stash", "list"]),
        _ => Err(format!("Unknown stash action: {action}")),
    }
}

#[tauri::command]
fn git_stash_list(workspace_root: String) -> Result<Vec<GitStash>, String> {
    // Format: "stash@{0}|branch|message" — but messages can contain pipes, so
    // we use a 0x1f separator (unit separator) which is never in a commit
    // subject.
    let out = git_output(&workspace_root, &["stash", "list", "--format=%gd|%s|%ct"])?;
    let mut stashes: Vec<GitStash> = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '|');
        let ref_name = parts.next().unwrap_or("").to_string();
        let subject = parts.next().unwrap_or("").to_string();
        let ts = parts.next().unwrap_or("0");
        let index = ref_name
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse::<u32>()
            .unwrap_or(0);
        // The "branch" half is everything before the first ":" in the
        // default stash subject ("WIP on main: abc1234 subject").
        let branch = subject
            .split(':')
            .next()
            .unwrap_or("")
            .replace("WIP on ", "")
            .replace("On ", "")
            .trim()
            .to_string();
        stashes.push(GitStash {
            index,
            branch,
            message: subject,
            timestamp: ts.parse().unwrap_or(0),
        });
    }
    Ok(stashes)
}

#[tauri::command]
fn git_pr_list(workspace_root: String) -> Result<Vec<PullRequest>, String> {
    let json = git_output(
        &workspace_root,
        &[
            "pr",
            "list",
            "--json",
            "number,title,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,updatedAt",
        ],
    )?;
    let raw: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Could not parse `gh pr list` output: {e}"))?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    let current_branch = git_output(&workspace_root, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut prs: Vec<PullRequest> = Vec::with_capacity(arr.len());
    for v in arr {
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let number = obj.get("number").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let title = obj
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let state = obj
            .get("state")
            .and_then(|x| x.as_str())
            .unwrap_or("OPEN")
            .to_string();
        let is_draft = obj
            .get("isDraft")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let author = obj
            .get("author")
            .and_then(|x| x.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();
        let head_ref = obj
            .get("headRefName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let base_ref = obj
            .get("baseRefName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let url = obj
            .get("url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let additions = obj.get("additions").and_then(|x| x.as_i64()).unwrap_or(0);
        let deletions = obj.get("deletions").and_then(|x| x.as_i64()).unwrap_or(0);
        let changed_files = obj
            .get("changedFiles")
            .and_then(|x| x.as_i64())
            .unwrap_or(0) as i32;
        let updated_at_ms = obj
            .get("updatedAt")
            .and_then(|x| x.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0);
        let badge = if is_draft {
            "draft".to_string()
        } else {
            state.to_lowercase()
        };
        prs.push(PullRequest {
            number,
            title,
            state,
            is_draft,
            author,
            head_ref: head_ref.clone(),
            base_ref,
            url,
            additions,
            deletions,
            changed_files,
            updated_at_ms,
            badge,
            is_current_branch: !current_branch.is_empty() && head_ref == current_branch,
        });
    }
    Ok(prs)
}

#[tauri::command]
fn git_pr_view(workspace_root: String, number: u32) -> Result<PullRequestDetails, String> {
    let json = git_output(
        &workspace_root,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "number,title,body,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,mergeable,createdAt,updatedAt",
        ],
    )?;
    let obj: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Could not parse `gh pr view` output: {e}"))?;
    let obj = match obj.as_object() {
        Some(o) => o,
        None => return Err(format!("PR #{number} not found")),
    };
    let state = obj
        .get("state")
        .and_then(|x| x.as_str())
        .unwrap_or("OPEN")
        .to_string();
    let is_draft = obj
        .get("isDraft")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let badge = if is_draft {
        "draft".to_string()
    } else {
        state.to_lowercase()
    };
    Ok(PullRequestDetails {
        number: obj.get("number").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        title: obj
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        body: obj
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        state,
        is_draft,
        author: obj
            .get("author")
            .and_then(|x| x.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
        head_ref: obj
            .get("headRefName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        base_ref: obj
            .get("baseRefName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        url: obj
            .get("url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        additions: obj.get("additions").and_then(|x| x.as_i64()).unwrap_or(0),
        deletions: obj.get("deletions").and_then(|x| x.as_i64()).unwrap_or(0),
        changed_files: obj
            .get("changedFiles")
            .and_then(|x| x.as_i64())
            .unwrap_or(0) as i32,
        badge,
        mergeable: obj
            .get("mergeable")
            .and_then(|x| x.as_str())
            .unwrap_or("UNKNOWN")
            .to_string(),
        created_at_ms: obj
            .get("createdAt")
            .and_then(|x| x.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0),
        updated_at_ms: obj
            .get("updatedAt")
            .and_then(|x| x.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0),
    })
}

#[tauri::command]
fn git_pr_checkout(workspace_root: String, number: u32) -> Result<String, String> {
    let out = git_output(&workspace_root, &["pr", "checkout", &number.to_string()])?;
    Ok(out.trim().to_string())
}

#[tauri::command]
fn git_pr_merge(
    workspace_root: String,
    number: u32,
    method: Option<String>,
) -> Result<String, String> {
    let method = method.unwrap_or_else(|| "merge".to_string());
    let flag = match method.as_str() {
        "merge" => "--merge",
        "squash" => "--squash",
        "rebase" => "--rebase",
        other => return Err(format!("Unknown merge method: {other}")),
    };
    let out = git_output(
        &workspace_root,
        &["pr", "merge", &number.to_string(), flag, "--delete-branch"],
    )?;
    Ok(out.trim().to_string())
}

#[tauri::command]
fn git_pr_open(workspace_root: String, number: u32) -> Result<String, String> {
    // `gh pr view --web` opens the PR in the default browser; we return the
    // resolved URL so the UI can show a toast.
    let url = git_output(
        &workspace_root,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "url",
            "-q",
            ".url",
        ],
    )?;
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(format!("PR #{number} has no URL"));
    }
    Command::new("open")
        .arg(&url)
        .output()
        .or_else(|_| Command::new("xdg-open").arg(&url).output())
        .map_err(|e| format!("Failed to open browser: {e}"))?;
    Ok(url)
}

#[tauri::command]
fn git_pr_merged(workspace_root: String, number: u32) -> Result<bool, String> {
    // `gh pr view <n> --json merged -q .merged` is the cheapest signal.
    let raw = git_output(
        &workspace_root,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "merged",
            "-q",
            ".merged",
        ],
    )?;
    Ok(raw.trim().eq_ignore_ascii_case("true"))
}

// ── Agent runs aggregation ──────────────────────────────────────────────
// Mission Control reads the local session logs that other agentic CLIs leave
// on disk, so KIDE can show your real recent runs across tools in one board:
//   • Claude Code → ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
//   • Codex       → ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//                   (+ ~/.codex/session_index.jsonl for human thread names)
// Read-only: we never write to those files.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRun {
    id: String,
    path: String,   // absolute path to the session log, for reading its transcript
    source: String, // "claude-code" | "codex"
    title: String,
    model: Option<String>,
    cwd: Option<String>,
    project: Option<String>, // last path segment of cwd
    git_branch: Option<String>,
    created_ms: i64, // 0 if unknown (external tools may not store creation time)
    updated_ms: i64,
    message_count: u32,
    // Real token usage summed from the session log (0 when the source doesn't
    // record usage). Input excludes cache reads — they'd dwarf everything else.
    input_tokens: i64,
    output_tokens: i64,
    status: String, // "running" (touched <2min ago) | "done"
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>, // set when we can infer parent from spawn mapping
}

// ── OpenCode session discovery ──────────────────────────────────────────
// OpenCode stores its full history in SQLite (opencode.db) with three tables
// we care about: `session` (one row per run), `message` (user/assistant turns),
// and `part` (text/tool fragments per message). The CLI's `opencode session
// list` only emits a text table with no timestamps, so we read the DB
// directly. We open it SQLITE_OPEN_READ_ONLY — never write to it.
//
// On macOS opencode 1.15 stores its DB at ~/.local/share/opencode/opencode.db
// (XDG-style). Older installs on Apple use ~/Library/Application Support.
// We try the XDG path first, then fall back to the Apple path so both work.

fn opencode_db_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let candidates = [
        std::path::Path::new(&home).join(".local/share/opencode/opencode.db"),
        std::path::Path::new(&home).join("Library/Application Support/opencode/opencode.db"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn opencode_connect() -> Option<rusqlite::Connection> {
    let path = opencode_db_path()?;
    rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

// The `model` column on `session` is JSON: {"id":"minimax-m3","providerID":"opencode-go"}.
// Flatten to "opencode-go/minimax-m3" so the user can tell the paid `opencode-go/*`
// models apart from the free `opencode/*` ones on the board.
fn opencode_model_label(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let id = value.get("id").and_then(|v| v.as_str())?;
    let provider = value.get("providerID").and_then(|v| v.as_str());
    match provider {
        Some(p) if !p.is_empty() => Some(format!("{p}/{id}")),
        _ => Some(id.to_string()),
    }
}

// One round-trip per row: pull everything the board needs, including the
// message count via subquery so we don't fan out one extra query per session.
fn parse_opencode_run(conn: &rusqlite::Connection, session_id: &str) -> Option<AgentRun> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.directory, s.model, s.time_updated, \
                    (SELECT COUNT(*) FROM message WHERE session_id = s.id) AS message_count, \
                    s.parent_id, s.time_created, \
                    (SELECT COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) \
                       FROM message WHERE session_id = s.id) AS input_tokens, \
                    (SELECT COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) \
                       FROM message WHERE session_id = s.id) AS output_tokens \
             FROM session s WHERE s.id = ?1",
        )
        .ok()?;
    let mut rows = stmt.query([session_id]).ok()?;
    let row = match rows.next() {
        Ok(Some(r)) => r,
        _ => return None,
    };
    let id: String = row.get(0).ok()?;
    let title: String = row.get(1).ok()?;
    let cwd: Option<String> = row.get(2).ok()?;
    let model_raw: Option<String> = row.get(3).ok()?;
    let time_updated: i64 = row.get(4).ok()?;
    let message_count: i64 = row.get(5).ok()?;
    // Sub-agent sessions ("(@explore subagent)" etc.) carry the spawning
    // session's id in parent_id — the board nests them under that run.
    let parent_id: Option<String> = row.get(6).ok().flatten();
    let time_created: i64 = row.get(7).unwrap_or(time_updated);
    let input_tokens: i64 = row.get(8).unwrap_or(0);
    let output_tokens: i64 = row.get(9).unwrap_or(0);

    // Status is determined by the *role of the latest message*, not the
    // recency of the session row. The opencode TUI/server touches the
    // session row in the background (auto-save, etc.), so time_updated is
    // a heartbeat signal that says nothing about whether the user is
    // actively engaged. The latest message is what tells us:
    //   • role == "user"      → user is waiting on the agent → "running"
    //   • role == "assistant" → agent has finished its last turn → "done"
    //   • no messages at all   → fresh/unused session → "done"
    let status = {
        let latest_role: Option<String> = (|| -> Option<String> {
            let mut stmt = conn
                .prepare(
                    "SELECT data FROM message WHERE session_id = ?1 \
                     ORDER BY time_created DESC LIMIT 1",
                )
                .ok()?;
            let mut rows = stmt
                .query_map([session_id], |row| {
                    let raw: String = row.get(0)?;
                    let value: serde_json::Value =
                        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
                    Ok(value
                        .get("role")
                        .and_then(|r| r.as_str())
                        .unwrap_or("")
                        .to_string())
                })
                .ok()?;
            rows.next().and_then(|r| r.ok())
        })();
        match latest_role.as_deref() {
            Some("user") => "running".to_string(),
            _ => "done".to_string(),
        }
    };

    // Compute the branch inline (the helper that does this in `agent::mod`
    // is private, and the opencode read path is the only caller here).
    let branch: Option<String> = cwd
        .as_deref()
        .and_then(|cwd| {
            std::process::Command::new("git")
                .args(["-C", cwd, "branch", "--show-current"])
                .output()
                .ok()
        })
        .and_then(|out| {
            if !out.status.success() {
                return None;
            }
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });
    let project = cwd.as_deref().and_then(project_name);

    Some(AgentRun {
        status,
        project,
        id,
        // The session id is the only "path" an opencode run has — it's what
        // the user types after `opencode export` to read the full transcript.
        path: session_id.to_string(),
        source: "opencode".to_string(),
        title: {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                "Untitled session".to_string()
            } else {
                clean_title(trimmed)
            }
        },
        model: model_raw.as_deref().and_then(opencode_model_label),
        cwd,
        git_branch: branch,
        created_ms: time_created,
        updated_ms: time_updated,
        message_count: message_count as u32,
        input_tokens,
        output_tokens,
        parent_id,
    })
}

// Walk a message's parts into a single readable string. Mirrors
// `claude_message_text` and `codex_message_text`: text parts concatenate, tool
// parts collapse to a one-line "[tool: <name>]". Step/reasoning/control parts
// are dropped — they're noise in a résumé view.
fn opencode_message_text(parts: &[serde_json::Value]) -> Option<String> {
    let mut buf = String::new();
    for part in parts {
        match part.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        if !buf.is_empty() {
                            buf.push('\n');
                        }
                        buf.push_str(t);
                    }
                }
            }
            Some("tool") => {
                let name = part.get("tool").and_then(|n| n.as_str()).unwrap_or("tool");
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(&format!("[tool: {name}]"));
            }
            _ => {}
        }
    }
    let t = buf.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[tauri::command]
fn read_opencode_run(session_id: String) -> Result<Vec<RunMessage>, String> {
    let conn =
        opencode_connect().ok_or_else(|| "OpenCode session database is unavailable".to_string())?;

    let mut msg_stmt = conn
        .prepare(
            "SELECT id, data FROM message WHERE session_id = ?1 \
             ORDER BY time_created ASC, id ASC",
        )
        .map_err(|e| format!("Unable to query opencode messages: {e}"))?;
    let messages: Vec<(String, serde_json::Value)> = msg_stmt
        .query_map([&session_id], |row| {
            let id: String = row.get(0)?;
            let raw: String = row.get(1)?;
            let data: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
            Ok((id, data))
        })
        .map_err(|e| format!("Unable to read opencode messages: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut part_stmt = conn
        .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ?1 \
             ORDER BY time_created ASC, id ASC",
        )
        .map_err(|e| format!("Unable to query opencode parts: {e}"))?;
    let part_iter = part_stmt
        .query_map([&session_id], |row| {
            let msg_id: String = row.get(0)?;
            let raw: String = row.get(1)?;
            let data: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
            Ok((msg_id, data))
        })
        .map_err(|e| format!("Unable to read opencode parts: {e}"))?
        .filter_map(|r| r.ok());
    let mut parts_by_message: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    for (msg_id, data) in part_iter {
        parts_by_message.entry(msg_id).or_default().push(data);
    }

    let mut msgs: Vec<RunMessage> = Vec::new();
    for (msg_id, data) in messages {
        let role = data.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let parts = parts_by_message.get(&msg_id);
        if let Some(text) = opencode_message_text(parts.map(|v| v.as_slice()).unwrap_or(&[])) {
            if role == "user" && text.starts_with('<') {
                continue;
            }
            msgs.push(RunMessage {
                role: role.to_string(),
                text,
            });
        }
    }

    for m in msgs.iter_mut() {
        if m.text.chars().count() > 4000 {
            m.text = m.text.chars().take(4000).collect::<String>() + "…";
        }
    }
    let len = msgs.len();
    if len > 80 {
        msgs.drain(0..len - 80);
    }
    Ok(msgs)
}

fn mtime_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn project_name(cwd: &str) -> Option<String> {
    std::path::Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
}

fn clean_title(s: &str) -> String {
    let one = s.split('\n').next().unwrap_or(s).trim();
    one.chars().take(120).collect()
}

fn recency_status(updated_ms: i64) -> String {
    if now_ms() - updated_ms < 120_000 {
        "running".to_string()
    } else {
        "done".to_string()
    }
}

// The first genuine user prompt becomes the run's title. Skips system/tool
// wrappers (content that begins with "<", e.g. "<command-name>…").
fn extract_user_text(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if !t.is_empty() && !t.starts_with('<') {
            Some(t.to_string())
        } else {
            None
        };
    }
    if let Some(arr) = content.as_array() {
        for part in arr {
            if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() && !t.starts_with('<') {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    None
}

fn parse_claude_run(path: &std::path::Path) -> Option<AgentRun> {
    let content = std::fs::read_to_string(path).ok()?;
    let id = path.file_stem()?.to_string_lossy().to_string();
    let (mut title, mut model, mut cwd, mut branch) = (None, None, None, None);
    let mut count: u32 = 0;
    let mut created_ms: i64 = 0;
    let (mut input_tokens, mut output_tokens): (i64, i64) = (0, 0);
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Capture first timestamp as creation time
        if created_ms == 0 {
            if let Some(ts) = v.get("ts").and_then(|t| t.as_i64()) {
                created_ms = ts;
            }
        }
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(|c| c.as_str()).map(str::to_string);
        }
        if branch.is_none() {
            if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
                if !b.is_empty() {
                    branch = Some(b.to_string());
                }
            }
        }
        match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => {
                count += 1;
                if title.is_none() {
                    if let Some(t) = v.get("message").and_then(extract_user_text) {
                        title = Some(clean_title(&t));
                    }
                }
            }
            Some("assistant") => {
                count += 1;
                if model.is_none() {
                    model = v
                        .get("message")
                        .and_then(|m| m.get("model"))
                        .and_then(|m| m.as_str())
                        .map(str::to_string);
                }
                // Each assistant line carries that turn's usage. Cache *reads*
                // are excluded (re-reads of the same prefix); cache *creation*
                // is genuine new input so it counts.
                if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                    let n = |key: &str| u.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
                    input_tokens += n("input_tokens") + n("cache_creation_input_tokens");
                    output_tokens += n("output_tokens");
                }
            }
            _ => {}
        }
    }
    let updated_ms = mtime_ms(path);
    if created_ms == 0 {
        created_ms = updated_ms;
    }
    Some(AgentRun {
        status: recency_status(updated_ms),
        project: cwd.as_deref().and_then(project_name),
        id,
        path: path.to_string_lossy().to_string(),
        source: "claude-code".to_string(),
        title: title.unwrap_or_else(|| "Untitled session".to_string()),
        model,
        cwd,
        git_branch: branch,
        created_ms,
        updated_ms,
        message_count: count,
        input_tokens,
        output_tokens,
        parent_id: None,
    })
}

fn parse_codex_run(
    path: &std::path::Path,
    index: &std::collections::HashMap<String, String>,
) -> Option<AgentRun> {
    use std::io::BufRead;
    // Codex rollout files can be hundreds of MB — tool outputs are written
    // inline, one giant JSON object per line. Building a serde_json::Value tree
    // for every line is what made the Stats panel freeze the machine on large
    // histories. Stream the file and skip JSON-parsing oversized lines: those
    // are always tool-output `response_item` records, which we only need to
    // count, never inspect. The metadata and token-usage lines we do read are
    // always small.
    const MAX_PARSE_LINE: usize = 32 * 1024;
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let (mut id, mut cwd, mut branch, mut model) = (None, None, None, None);
    let mut count: u32 = 0;
    let (mut input_tokens, mut output_tokens): (i64, i64) = (0, 0);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.len() > MAX_PARSE_LINE {
            count += 1; // oversized line = a tool-output response_item
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = v.get("payload");
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session_meta") => {
                if let Some(p) = payload {
                    if id.is_none() {
                        id = p.get("id").and_then(|x| x.as_str()).map(str::to_string);
                    }
                    if cwd.is_none() {
                        cwd = p.get("cwd").and_then(|x| x.as_str()).map(str::to_string);
                    }
                    if branch.is_none() {
                        branch = p
                            .get("git")
                            .and_then(|g| g.get("branch"))
                            .and_then(|b| b.as_str())
                            .map(str::to_string);
                    }
                }
            }
            Some("turn_context") => {
                if model.is_none() {
                    if let Some(m) = payload
                        .and_then(|p| p.get("model"))
                        .and_then(|m| m.as_str())
                    {
                        if !m.is_empty() {
                            model = Some(m.to_string());
                        }
                    }
                }
            }
            Some("response_item") => count += 1,
            Some("event_msg") => {
                // `token_count` events carry a *cumulative* total for the
                // session — keep overwriting so the last one wins. Cached
                // input is subtracted to mirror the Claude parser.
                if let Some(total) = payload
                    .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("token_count"))
                    .and_then(|p| p.get("info"))
                    .and_then(|i| i.get("total_token_usage"))
                {
                    let n = |key: &str| total.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
                    input_tokens = (n("input_tokens") - n("cached_input_tokens")).max(0);
                    output_tokens = n("output_tokens");
                }
            }
            _ => {}
        }
    }
    let id = id.unwrap_or_else(|| {
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    let updated_ms = mtime_ms(path);
    Some(AgentRun {
        status: recency_status(updated_ms),
        title: index
            .get(&id)
            .cloned()
            .unwrap_or_else(|| "Codex session".to_string()),
        project: cwd.as_deref().and_then(project_name),
        id,
        path: path.to_string_lossy().to_string(),
        source: "codex".to_string(),
        model,
        cwd,
        git_branch: branch,
        created_ms: updated_ms, // fallback to mtime
        updated_ms,
        message_count: count,
        input_tokens,
        output_tokens,
        parent_id: None,
    })
}

fn load_codex_index(home: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let path = std::path::Path::new(home).join(".codex/session_index.jsonl");
    if let Ok(content) = std::fs::read_to_string(&path) {
        for line in content.lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let (Some(id), Some(name)) = (
                    v.get("id").and_then(|x| x.as_str()),
                    v.get("thread_name").and_then(|x| x.as_str()),
                ) {
                    map.insert(id.to_string(), name.to_string());
                }
            }
        }
    }
    map
}

fn collect_codex_rollouts(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_codex_rollouts(&p, out);
            } else if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                    out.push(p);
                }
            }
        }
    }
}

#[tauri::command]
fn list_agent_runs(
    app: tauri::AppHandle,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<AgentRun>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let cap = limit.unwrap_or(10);
    let off = offset.unwrap_or(0);

    // Load delegate session → parent mappings (both by Klide's ID and external ID)
    let (by_delegate, by_external) = crate::pty::read_delegate_sessions_by_id(&app);

    // (path, source, mtime) for every candidate session, newest first.
    let mut candidates: Vec<(std::path::PathBuf, &'static str, i64)> = Vec::new();

    let claude_root = std::path::Path::new(&home).join(".claude/projects");
    if let Ok(projects) = std::fs::read_dir(&claude_root) {
        for proj in projects.flatten() {
            if !proj.path().is_dir() {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(proj.path()) {
                for f in files.flatten() {
                    let p = f.path();
                    if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                        let m = mtime_ms(&p);
                        candidates.push((p, "claude-code", m));
                    }
                }
            }
        }
    }

    let codex_root = std::path::Path::new(&home).join(".codex/sessions");
    let mut codex_files = Vec::new();
    collect_codex_rollouts(&codex_root, &mut codex_files);
    for p in codex_files {
        let m = mtime_ms(&p);
        candidates.push((p, "codex", m));
    }

    // OpenCode: one candidate per session, mtime is the session's own
    // `time_updated` (not the DB file's mtime — they diverge while the WAL
    // is being flushed). The path slot holds the session id, not a real file
    // path; parse_opencode_run reads it back as an id and looks the row up
    // in the SQLite DB.
    if let Some(conn) = opencode_connect() {
        if let Ok(mut stmt) = conn.prepare("SELECT id, time_updated FROM session") {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            }) {
                for row in rows.flatten() {
                    candidates.push((std::path::PathBuf::from(row.0), "opencode", row.1));
                }
            }
        }
    }

    // Stat-and-sort is cheap; parse only the requested page (offset..offset+cap)
    // so big histories stay fast and the UI can lazily page in older runs.
    candidates.sort_by(|a, b| b.2.cmp(&a.2));

    // Open the opencode DB once for the page's parse step — opening a SQLite
    // file for every candidate would dominate the page time.
    let opencode_conn = opencode_connect();
    let codex_index = load_codex_index(&home);
    let mut runs: Vec<AgentRun> = candidates
        .into_iter()
        .skip(off)
        .take(cap)
        .filter_map(|(path, source, _)| {
            let mut run = match source {
                "claude-code" => parse_claude_run(&path)?,
                "codex" => parse_codex_run(&path, &codex_index)?,
                "opencode" => opencode_conn
                    .as_ref()
                    .and_then(|c| parse_opencode_run(c, path.to_str().unwrap_or("")))?,
                _ => return None,
            };
            // Inject parent_id from spawn mapping if available.
            // Try by Klide's internal ID first, then by external session ID
            // (for cases where OpenCode created its own session ID different
            // from the session_id we passed to delegate_pty_spawn).
            if run.parent_id.is_none() {
                let parent = by_delegate
                    .get(&run.id)
                    .or_else(|| by_external.get(&run.id));
                if let Some(mapping) = parent {
                    run.parent_id = Some(mapping.parent_id.clone());
                }
            }
            Some(run)
        })
        .collect();
    runs.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    Ok(runs)
}

// One readable line of a run's conversation, for the Mission Control detail
// pane. We strip system/context wrappers and tool plumbing so what shows is the
// actual back-and-forth (a "résumé" of the session).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunMessage {
    role: String, // "user" | "assistant"
    text: String,
}

fn claude_message_text(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if t.is_empty() || t.starts_with('<') {
            None
        } else {
            Some(t.to_string())
        };
    }
    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        for part in arr {
            match part.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                        let t = t.trim();
                        if !t.is_empty() {
                            if !buf.is_empty() {
                                buf.push('\n');
                            }
                            buf.push_str(t);
                        }
                    }
                }
                Some("tool_use") => {
                    let name = part.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&format!("[tool: {name}]"));
                }
                _ => {} // skip thinking / tool_result noise
            }
        }
        let t = buf.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

fn codex_message_text(payload: &serde_json::Value) -> Option<String> {
    let content = payload.get("content")?;
    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        for part in arr {
            if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                let t = t.trim();
                if !t.is_empty() {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(t);
                }
            }
        }
        let t = buf.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    } else if let Some(s) = content.as_str() {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

#[tauri::command]
fn read_agent_run(path: String, source: String) -> Result<Vec<RunMessage>, String> {
    // Sandbox: only ever read the two agent-log directories.
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let p = std::path::Path::new(&path);
    let claude = std::path::Path::new(&home).join(".claude");
    let codex = std::path::Path::new(&home).join(".codex");
    if !(p.starts_with(&claude) || p.starts_with(&codex)) {
        return Err("Path is outside the agent log directories".to_string());
    }
    let content = std::fs::read_to_string(p).map_err(|e| e.to_string())?;

    let mut msgs: Vec<RunMessage> = Vec::new();
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if source == "codex" {
            if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
                continue;
            }
            let payload = match v.get("payload") {
                Some(p) if p.get("type").and_then(|t| t.as_str()) == Some("message") => p,
                _ => continue,
            };
            let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue; // skip developer/system noise
            }
            if let Some(text) = codex_message_text(payload) {
                if role == "user" && text.starts_with('<') {
                    continue; // environment / permissions context wrappers
                }
                msgs.push(RunMessage {
                    role: role.to_string(),
                    text,
                });
            }
        } else {
            let role = match v.get("type").and_then(|t| t.as_str()) {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };
            if let Some(text) = v.get("message").and_then(claude_message_text) {
                msgs.push(RunMessage {
                    role: role.to_string(),
                    text,
                });
            }
        }
    }

    // Bound payload: trim long messages, keep the most recent ~80.
    for m in msgs.iter_mut() {
        if m.text.chars().count() > 4000 {
            m.text = m.text.chars().take(4000).collect::<String>() + "…";
        }
    }
    let len = msgs.len();
    if len > 80 {
        msgs.drain(0..len - 80);
    }
    Ok(msgs)
}

// ── Local server management (Ollama, MLX) ───────────────────────────────

#[derive(Default)]
struct LocalServerState {
    processes: Mutex<HashMap<String, std::process::Child>>,
}

fn is_local_server_provider(provider: &str) -> bool {
    matches!(provider, "ollama" | "mlx")
}

fn local_server_command(provider: &str, model: &str) -> Result<(String, Vec<String>), String> {
    match provider {
        "ollama" => Ok(("ollama".to_string(), vec!["serve".to_string()])),
        "mlx" => {
            let model = canonical_mlx_model(model);
            if let Ok(server) = resolve_command("mlx_lm.server") {
                return Ok((server, vec!["--model".to_string(), model]));
            }
            let python = if std::env::consts::OS == "macos" {
                "python3"
            } else {
                "python"
            };
            Ok((
                python.to_string(),
                vec![
                    "-m".to_string(),
                    "mlx_lm.server".to_string(),
                    "--model".to_string(),
                    model,
                ],
            ))
        }
        _ => Err(format!("{provider} is not a local server provider")),
    }
}

fn canonical_mlx_model(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty()
        || trimmed.contains(':')
        || (!trimmed.contains('/') && !trimmed.starts_with('.'))
    {
        MLX_DEFAULT_MODEL.to_string()
    } else {
        trimmed.to_string()
    }
}

fn home_dir_path() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        return Some(PathBuf::from(home));
    }
    if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        None
    }
}

fn hf_hub_cache_dir() -> Option<PathBuf> {
    std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .or_else(|| home_dir_path().map(|home| home.join(".cache").join("huggingface").join("hub")))
}

fn ensure_mlx_cache_dir() -> Result<Option<PathBuf>, String> {
    let Some(cache_dir) = hf_hub_cache_dir() else {
        return Ok(None);
    };
    std::fs::create_dir_all(&cache_dir).map_err(|e| {
        format!(
            "Failed to create Hugging Face cache dir {}: {e}",
            cache_dir.display()
        )
    })?;
    Ok(Some(cache_dir))
}

fn local_server_stderr_path(provider: &str) -> PathBuf {
    if cfg!(unix) {
        PathBuf::from(format!("/tmp/klide-{provider}-stderr.log"))
    } else {
        std::env::temp_dir().join(format!("klide-{provider}-stderr.log"))
    }
}

async fn mlx_server_ready() -> bool {
    tokio::net::TcpStream::connect("127.0.0.1:8080")
        .await
        .is_ok()
}

async fn local_server_ready(provider: &str) -> bool {
    match provider {
        "ollama" => reqwest::get(format!("{OLLAMA_URL}/api/tags"))
            .await
            .map(|res| res.status().is_success())
            .unwrap_or(false),
        "mlx" => mlx_server_ready().await,
        _ => false,
    }
}

fn local_server_start_attempts(provider: &str) -> usize {
    match provider {
        // First MLX run can include Hugging Face download + Metal model load.
        "mlx" => 360,
        _ => 40,
    }
}

#[tauri::command]
async fn ai_local_server_start(
    provider: String,
    model: String,
    state: tauri::State<'_, LocalServerState>,
) -> Result<bool, String> {
    if !is_local_server_provider(&provider) {
        return Err(format!("{provider} is not a local server provider"));
    }

    // Already running externally or previously started
    if local_server_ready(&provider).await {
        return Ok(true);
    }

    {
        let procs = state.processes.lock().map_err(|e| e.to_string())?;
        if procs.contains_key(&provider) {
            return Ok(true);
        }
    }

    let (cmd, args) = local_server_command(&provider, &model)?;

    let hf_cache_dir = if provider == "mlx" {
        ensure_mlx_cache_dir()?
    } else {
        None
    };

    let stderr_path = local_server_stderr_path(&provider);
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|e| format!("Failed to create stderr log: {e}"))?;

    let mut command = Command::new(&cmd);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file));
    if let Some(cache_dir) = hf_cache_dir {
        command.env("HF_HUB_CACHE", cache_dir);
    }

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("Command not found: {cmd}. Make sure {provider} is installed.")
        } else {
            format!("Failed to start {provider}: {e}")
        }
    })?;

    // Quick check for immediate exit (wrong args, missing module, etc.)
    tokio::time::sleep(Duration::from_millis(300)).await;
    if let Ok(Some(status)) = child.try_wait() {
        let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
        let msg = if stderr.trim().is_empty() {
            format!("{provider} exited immediately with {status}")
        } else {
            format!("{provider} exited immediately: {stderr}")
        };
        return Err(msg);
    }

    // MLX first run can take minutes if it has to download and compile/load
    // the model; Ollama usually answers quickly.
    for _ in 0..local_server_start_attempts(&provider) {
        tokio::time::sleep(Duration::from_millis(500)).await;

        match child.try_wait() {
            Ok(Some(_)) => {
                let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
                let msg = if stderr.trim().is_empty() {
                    format!("{provider} process exited before the HTTP port came up")
                } else {
                    format!("{provider} process exited: {stderr}")
                };
                return Err(msg);
            }
            Ok(None) => {}
            Err(e) => return Err(format!("Failed to check {provider} status: {e}")),
        }

        if local_server_ready(&provider).await {
            let mut procs = state.processes.lock().map_err(|e| e.to_string())?;
            procs.insert(provider, child);
            return Ok(true);
        }
    }

    // Timeout — clean up and show last stderr lines
    let _ = child.kill();
    let _ = child.wait();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    if stderr.trim().is_empty() {
        Ok(false)
    } else {
        Err(format!(
            "{provider} timed out starting. Last stderr:\n{stderr}"
        ))
    }
}

#[tauri::command]
fn ai_local_server_stop(
    provider: String,
    state: tauri::State<'_, LocalServerState>,
) -> Result<bool, String> {
    if !is_local_server_provider(&provider) {
        return Err(format!("{provider} is not a local server provider"));
    }

    let child = {
        let mut procs = state.processes.lock().map_err(|e| e.to_string())?;
        procs.remove(&provider)
    };

    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }

    Ok(false)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillCommandResult {
    ok: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// One skill discovered on disk. Mirrors the shape the frontend builds
/// locally so the UI can drop these into the same Skill[] list.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSystemSkill {
    id: String,
    name: String,
    description: String,
    instructions: String,
    /// Path to the SKILL.md, absolute. Display-only — the frontend
    /// hands it back to `uninstall_skill` by folder name.
    from_file: String,
    /// "workspace-agents" | "workspace-klide" | "home-agents" | "home-claude"
    source: String,
    /// Human-readable provenance label for grouping in the modal — e.g.
    /// "Vercel", "Matt Pocock", "Personal", "Workspace".
    group: String,
}

fn parse_skill_md(raw: &str, folder: &str) -> (String, String, String) {
    // Returns (name, description, instructions).
    let mut name = folder.to_string();
    let mut description = String::new();
    let mut instructions = raw.to_string();
    if let Some(stripped) = raw.strip_prefix("---\n") {
        if let Some(end) = stripped.find("\n---\n") {
            let frontmatter = &stripped[..end];
            for line in frontmatter.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let key = k.trim();
                    let value = v.trim();
                    if key == "name" {
                        name = value.to_string();
                    }
                    if key == "description" {
                        description = value.to_string();
                    }
                }
            }
            instructions = stripped[end + 5..].trim().to_string();
        }
    }
    (name, description, instructions)
}

/// Extract provenance metadata from a SKILL.md frontmatter. Returns
/// (author, repository) — both are best-effort and may be empty. We
/// support the flat `metadata:` block that `npx skills` packages use:
///
///     metadata:
///       author: vercel
///       version: "1.0.0"
fn parse_skill_provenance(raw: &str) -> (String, String) {
    let Some(stripped) = raw.strip_prefix("---\n") else {
        return (String::new(), String::new());
    };
    let Some(end) = stripped.find("\n---\n") else {
        return (String::new(), String::new());
    };
    let frontmatter = &stripped[..end];
    let mut in_metadata = false;
    let mut author = String::new();
    let mut repository = String::new();
    for line in frontmatter.lines() {
        if line.starts_with("metadata:") {
            in_metadata = true;
            continue;
        }
        if in_metadata {
            // End of the metadata block when we hit a non-indented line.
            if !line.starts_with(' ') && !line.starts_with('\t') && !line.trim().is_empty() {
                in_metadata = false;
            } else if let Some((k, v)) = line.trim().split_once(':') {
                let key = k.trim();
                let value = v.trim().trim_matches('"');
                if key == "author" {
                    author = value.to_string();
                }
                if key == "repository" {
                    repository = value.to_string();
                }
            }
        }
    }
    (author, repository)
}

/// Map (source, author, repository) to a display group label for the
/// modal. The grouping is "where did this come from" — so install
/// paths, publisher, and self-authored all show up distinctly.
fn skill_group_label(source: &str, author: &str, repository: &str) -> String {
    // Workspace folders always show as their own group, regardless of author.
    if source == "workspace-agents" {
        return "Workspace".to_string();
    }
    if source == "workspace-klide" {
        return "Workspace (auto-generated)".to_string();
    }

    // Author takes precedence — it's the most reliable signal.
    let a = author.to_lowercase();
    if !a.is_empty() {
        match a.as_str() {
            "vercel" => return "Vercel".to_string(),
            "anthropic" | "anthropics" => return "Anthropic".to_string(),
            "mattpocock" | "matt pocock" => return "Matt Pocock".to_string(),
            _ => {
                // Unknown author: title-case it for display.
                let mut chars = a.chars();
                let titled = match chars.next() {
                    Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                };
                return titled;
            }
        }
    }

    // Fall back to the GitHub repo's owner if we have it.
    if !repository.is_empty() {
        // e.g. "https://github.com/vercel-labs/agent-skills" -> "Vercel"
        let path = repository.trim_end_matches('/');
        let lower = path.to_lowercase();
        if let Some(rest) = lower
            .strip_prefix("https://github.com/")
            .or_else(|| lower.strip_prefix("github.com/"))
        {
            let owner = rest.split('/').next().unwrap_or("");
            let clean = owner.trim_start_matches('@');
            match clean {
                "vercel-labs" | "vercel" => return "Vercel".to_string(),
                "anthropics" | "anthropic" => return "Anthropic".to_string(),
                "mattpocock" => return "Matt Pocock".to_string(),
                _ => {
                    if !clean.is_empty() {
                        // Title-case the owner for display.
                        let mut chars = clean.chars();
                        return match chars.next() {
                            Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                            None => String::new(),
                        };
                    }
                }
            }
        }
    }

    // No author and no repository — distinguish home vs. personal.
    if source == "home-agents" {
        return "Personal".to_string();
    }
    "Personal".to_string()
}

/// Walk the four well-known skill locations and return everything we
/// can find on disk. The Rust side runs unsandboxed, so it can read
/// the user's home directory without a Tauri fs scope entry.
#[tauri::command]
fn list_filesystem_skills(workspace_root: Option<String>) -> Result<Vec<FileSystemSkill>, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "Could not resolve home directory.".to_string())?;
    let home = home.to_string_lossy().to_string();

    let sources: [(&str, std::path::PathBuf); 4] = [
        (
            "workspace-agents",
            std::path::PathBuf::from(format!(
                "{}/.agents/skills",
                workspace_root.clone().unwrap_or_default()
            )),
        ),
        (
            "workspace-klide",
            std::path::PathBuf::from(format!(
                "{}/.klide/skills",
                workspace_root.clone().unwrap_or_default()
            )),
        ),
        (
            "home-agents",
            std::path::PathBuf::from(format!("{home}/.agents/skills")),
        ),
        (
            "home-claude",
            std::path::PathBuf::from(format!("{home}/.claude/skills")),
        ),
    ];

    let mut out: Vec<FileSystemSkill> = Vec::new();
    for (source, dir) in sources.iter() {
        // Skip the two workspace paths when no workspace is open — the
        // `format!` above produced an empty workspace_root, which would
        // otherwise resolve to a stray `/.agents/skills` on macOS.
        if source.starts_with("workspace-") && workspace_root.is_none() {
            continue;
        }
        let Ok(read) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in read.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let folder = match entry.file_name().into_string() {
                Ok(s) => s,
                Err(_) => continue,
            };
            let skill_file = entry.path().join("SKILL.md");
            if !skill_file.exists() {
                continue;
            }
            let raw = match std::fs::read_to_string(&skill_file) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let (name, description, instructions) = parse_skill_md(&raw, &folder);
            let (author, repository) = parse_skill_provenance(&raw);
            let group = skill_group_label(source, &author, &repository);
            let id = format!("file-{source}-{folder}");
            out.push(FileSystemSkill {
                id,
                name: if name.is_empty() {
                    folder.clone()
                } else {
                    name
                },
                description: if description.is_empty() {
                    format!("Skill from {}", skill_file.display())
                } else {
                    description
                },
                instructions,
                from_file: skill_file.to_string_lossy().to_string(),
                source: (*source).to_string(),
                group,
            });
        }
    }
    Ok(out)
}

/// Install a skill from a GitHub-style package spec (e.g. `anthropics/skills`,
/// `anthropics/skills/frontend-design`) into `~/.claude/skills/` via the
/// `npx skills add` CLI. Returns the captured output so the UI can surface it.
#[tauri::command]
async fn install_skill(package: String) -> Result<SkillCommandResult, String> {
    let trimmed = package.trim().to_string();
    if trimmed.is_empty() {
        return Err("Package is required.".into());
    }
    // No shell — we pass the package as a single argv entry.
    let output = TokioCommand::new("npx")
        .arg("--yes")
        .arg("skills")
        .arg("add")
        .arg(&trimmed)
        .arg("-g") // global: ~/.claude/skills
        .arg("-y") // non-interactive
        .output()
        .await
        .map_err(|e| format!("Failed to run `npx skills add`: {e}"))?;
    Ok(SkillCommandResult {
        ok: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Remove a globally-installed skill by its folder name. Removes the
/// `~/.claude/skills/<name>` directory if it exists.
#[tauri::command]
async fn uninstall_skill(name: String) -> Result<SkillCommandResult, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Skill name is required.".into());
    }
    let trimmed_skill_name = trimmed.clone();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "Could not resolve home directory.".to_string())?;
    let target = home
        .join(".claude")
        .join("skills")
        .join(&trimmed_skill_name);
    if !target.exists() {
        return Ok(SkillCommandResult {
            ok: true,
            exit_code: Some(0),
            stdout: format!(
                "Skill `{}` was not installed; nothing to do.",
                trimmed_skill_name
            ),
            stderr: String::new(),
        });
    }
    std::fs::remove_dir_all(&target)
        .map_err(|e| format!("Failed to remove {}: {e}", target.display()))?;
    Ok(SkillCommandResult {
        ok: true,
        exit_code: Some(0),
        stdout: format!("Removed {}.", target.display()),
        stderr: String::new(),
    })
}

#[tauri::command]
async fn ai_local_server_status(provider: String) -> Result<bool, String> {
    if !is_local_server_provider(&provider) {
        return Ok(false);
    }
    Ok(local_server_ready(&provider).await)
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
        .manage(LocalServerState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

            let handle = app.handle();

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
            list_dir,
            read_text_file,
            create_entry,
            rename_entry,
            delete_entry,
            reveal_entry,
            git_status,
            git_stage,
            git_unstage,
            git_commit,
            git_diff,
            list_agent_runs,
            read_agent_run,
            read_opencode_run,
            ai_provider_models,
            ai_subscription_status,
            app_user_info,
            ai_context_window,
            ai_model_supports_tools,
            ai_list_tools,
            search_in_files,
            ai_provider_key_status,
            ai_set_provider_key,
            ai_clear_provider_key,
            ai_chat,
            ai_local_server_start,
            ai_local_server_stop,
            ai_local_server_status,
            agent::agent_start_run,
            agent::agent_submit_user_turn,
            agent::agent_resolve_permission,
            agent::agent_resolve_diff,
            agent::agent_abort_run,
            agent::agent_list_runs,
            agent::agent_read_run,
            agent::agent_list_checkpoints,
            agent::agent_revert_checkpoint,
            install_skill,
            uninstall_skill,
            list_filesystem_skills,
            memory_write,
            memory_list,
            memory_read,
            create_pr,
            create_worktree,
            git_log,
            git_checkout_branch,
            git_fetch,
            git_pull,
            git_push,
            git_discard,
            git_stash,
            git_stash_list,
            git_pr_list,
            git_pr_view,
            git_pr_checkout,
            git_pr_merge,
            git_pr_open,
            git_pr_merged
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    //! Unit tests for the streaming adapter parsers.
    //!
    //! Each provider's `parse_line` is the choke point that turns raw
    //! `data: …` lines into typed deltas — a regression here silently
    //! corrupts every chat completion. These tests pin the contract using
    //! fixture strings recorded from real provider responses, so we don't
    //! need network access to lock the behaviour in.
    use super::*;
    use std::cell::RefCell;

    /// A chunk sink the test can introspect. Mirrors what
    /// `tauri::ipc::Channel::send` would deliver to the frontend.
    #[derive(Default)]
    struct Recorder {
        chunks: RefCell<Vec<StreamChunk>>,
    }
    impl Recorder {
        fn record(&self) -> Vec<StreamChunk> {
            self.chunks.borrow().iter().cloned().collect()
        }
        fn as_sink(&self) -> impl Fn(StreamChunk) + '_ {
            |c| self.chunks.borrow_mut().push(c)
        }
    }

    fn run_ollama(lines: &[&str]) -> (String, String, Vec<serde_json::Value>, Vec<StreamChunk>) {
        let mut adapter = OllamaAdapter {
            model: "test".to_string(),
            messages: vec![],
            tools: None,
        };
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tools: Vec<serde_json::Value> = Vec::new();
        let rec = Recorder::default();
        for line in lines {
            adapter
                .parse_line(
                    line,
                    &mut content,
                    &mut thinking,
                    &mut tools,
                    &rec.as_sink(),
                )
                .unwrap();
        }
        (content, thinking, tools, rec.record())
    }

    #[test]
    fn ollama_accumulates_content_thinking_and_tool_calls() {
        let lines = [
            r#"{"message":{"content":"Hello","thinking":""},"done":false}"#,
            r#"{"message":{"content":" world","thinking":"hmm"},"done":false}"#,
            r#"{"message":{"content":"","tool_calls":[{"function":{"name":"read_file","arguments":{"path":"a.rs"}}}]},"done":false}"#,
            r#"{"done":true}"#,
        ];
        let (content, thinking, tools, chunks) = run_ollama(&lines);
        assert_eq!(content, "Hello world");
        assert_eq!(thinking, "hmm");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "read_file");
        // StreamChunk should carry only the latest deltas, not accumulated state.
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].content, "Hello");
        assert_eq!(chunks[1].content, " world");
        assert_eq!(chunks[1].thinking, "hmm");
    }

    #[test]
    fn ollama_skips_empty_and_non_json_lines() {
        let (content, _, tools, chunks) = run_ollama(&["", "not json", "   \n"]);
        assert!(content.is_empty());
        assert!(tools.is_empty());
        assert!(chunks.is_empty());
    }

    #[test]
    fn ollama_surfaces_mid_stream_error() {
        let mut adapter = OllamaAdapter {
            model: "test".to_string(),
            messages: vec![],
            tools: None,
        };
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tools: Vec<serde_json::Value> = Vec::new();
        let rec = Recorder::default();
        let err = adapter
            .parse_line(
                r#"{"error":"model not found"}"#,
                &mut content,
                &mut thinking,
                &mut tools,
                &rec.as_sink(),
            )
            .unwrap_err();
        assert!(err.contains("model not found"), "got: {err}");
    }

    fn run_openai(
        lines: &[&str],
    ) -> (
        String,
        Option<String>,
        Vec<serde_json::Value>,
        Vec<StreamChunk>,
    ) {
        let mut adapter = OpenAiAdapter {
            provider: "openai".to_string(),
            model: "gpt-4.1".to_string(),
            messages: vec![],
            tools: None,
            key: Some("sk-test".to_string()),
        };
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tools: Vec<OpenAiToolAcc> = Vec::new();
        let rec = Recorder::default();
        for line in lines {
            adapter
                .parse_line(
                    line,
                    &mut content,
                    &mut thinking,
                    &mut tools,
                    &rec.as_sink(),
                )
                .unwrap();
        }
        let response = OpenAiAdapter::finalize_response(content, thinking, tools);
        (
            response.content,
            response.thinking,
            response.tool_calls,
            rec.record(),
        )
    }

    #[tokio::test]
    async fn mlx_does_not_advertise_tool_support() {
        let supports = ai_model_supports_tools(
            "mlx".to_string(),
            "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit".to_string(),
        )
        .await
        .unwrap();
        assert!(!supports);
    }

    #[test]
    fn mlx_model_canonicalization_rejects_ollama_style_tags() {
        assert_eq!(canonical_mlx_model("gemma4:12b-mlx"), MLX_DEFAULT_MODEL);
        assert_eq!(canonical_mlx_model("gemma-4-4b-it"), MLX_DEFAULT_MODEL);
        assert_eq!(
            canonical_mlx_model("mlx-community/Meta-Llama-3.1-8B-Instruct-4bit"),
            "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit"
        );
    }

    #[test]
    fn mlx_request_body_omits_tools_even_if_supplied() {
        let tools = vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": { "type": "object", "properties": {} },
            },
        })];
        let body = openai_chat_body(
            "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit",
            vec![serde_json::json!({ "role": "user", "content": "hi" })],
            Some(tools),
            false,
        );
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn openai_request_body_includes_tools_when_supported() {
        let tools = vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": { "type": "object", "properties": {} },
            },
        })];
        let body = openai_chat_body(
            "gpt-4.1",
            vec![serde_json::json!({ "role": "user", "content": "hi" })],
            Some(tools),
            true,
        );
        assert!(body.get("tools").is_some());
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn openai_accumulates_content_across_chunks() {
        let lines = [
            r#"data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"content":"lo "}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"content":"there"}}]}"#,
            r#"data: [DONE]"#,
        ];
        let (content, thinking, tools, chunks) = run_openai(&lines);
        assert_eq!(content, "Hello there");
        assert!(thinking.is_none());
        assert!(tools.is_empty());
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].content, "Hel");
    }

    #[test]
    fn openai_splits_think_tags_into_thinking() {
        let lines = [
            r#"data: {"choices":[{"index":0,"delta":{"content":"<think>checking MLX</think>\nAnswer"}}]}"#,
            r#"data: [DONE]"#,
        ];
        let (content, thinking, tools, _chunks) = run_openai(&lines);
        assert_eq!(content, "Answer");
        assert_eq!(thinking.as_deref(), Some("checking MLX"));
        assert!(tools.is_empty());
    }

    #[test]
    fn openai_stitches_streamed_tool_call_args() {
        // Mimics what the OpenAI Chat Completions API sends when streaming
        // a tool call: `index` ties the deltas together, `arguments` arrives
        // as a sequence of JSON fragments that have to be concatenated
        // before they're valid JSON.
        let lines = [
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\"pa"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x.rs\"}"}}]}}]}"#,
            r#"data: [DONE]"#,
        ];
        let (content, thinking, tools, chunks) = run_openai(&lines);
        assert!(content.is_empty());
        assert!(thinking.is_none());
        assert!(chunks.is_empty());
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["id"], "call_1");
        assert_eq!(tools[0]["function"]["name"], "read");
        let args: serde_json::Value =
            serde_json::from_str(tools[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["path"], "x.rs");
    }

    #[test]
    fn openai_ignores_prefixless_and_done_lines() {
        let (content, thinking, tools, chunks) =
            run_openai(&["event: ping", ":heartbeat", "data: [DONE]", ""]);
        assert!(content.is_empty());
        assert!(thinking.is_none());
        assert!(tools.is_empty());
        assert!(chunks.is_empty());
    }

    #[test]
    fn openai_surfaces_mid_stream_error() {
        let mut adapter = OpenAiAdapter {
            provider: "mistral".to_string(),
            model: "mistral-large".to_string(),
            messages: vec![],
            tools: None,
            key: Some("k".to_string()),
        };
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tools: Vec<OpenAiToolAcc> = Vec::new();
        let rec = Recorder::default();
        let err = adapter
            .parse_line(
                r#"data: {"error":{"message":"rate limited"}}"#,
                &mut content,
                &mut thinking,
                &mut tools,
                &rec.as_sink(),
            )
            .unwrap_err();
        assert!(err.contains("mistral"), "provider tag missing: {err}");
        assert!(err.contains("rate limited"), "got: {err}");
    }

    fn run_anthropic(lines: &[&str]) -> (String, Vec<serde_json::Value>, Vec<StreamChunk>) {
        let mut adapter = AnthropicAdapter {
            model: "claude-sonnet-4-6".to_string(),
            messages: vec![],
            tools: None,
            key: "sk-ant-test".to_string(),
        };
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tools: Vec<AnthropicToolAcc> = Vec::new();
        let rec = Recorder::default();
        for line in lines {
            adapter
                .parse_line(
                    line,
                    &mut content,
                    &mut thinking,
                    &mut tools,
                    &rec.as_sink(),
                )
                .unwrap();
        }
        let response = AnthropicAdapter::finalize_response(content, thinking, tools);
        (response.content, response.tool_calls, rec.record())
    }

    #[test]
    fn anthropic_text_stream_round_trip() {
        let lines = [
            r#"data: {"type":"message_start","message":{"id":"m_1"}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_stop"}"#,
        ];
        let (content, tools, chunks) = run_anthropic(&lines);
        assert_eq!(content, "Hello there");
        assert!(tools.is_empty());
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].content, "Hello");
        assert_eq!(chunks[1].content, " there");
    }

    #[test]
    fn anthropic_tool_use_args_assembled_from_partial_json() {
        let lines = [
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_file"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"a.rs\","}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"old_str\":"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"null}"}}"#,
        ];
        let (content, tools, chunks) = run_anthropic(&lines);
        assert!(content.is_empty());
        assert!(chunks.is_empty());
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["id"], "toolu_1");
        assert_eq!(tools[0]["function"]["name"], "write_file");
        let args: serde_json::Value =
            serde_json::from_str(tools[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["path"], "a.rs");
        assert!(args.get("old_str").is_some());
    }

    #[test]
    fn anthropic_surfaces_mid_stream_error_event() {
        let mut adapter = AnthropicAdapter {
            model: "claude-sonnet-4-6".to_string(),
            messages: vec![],
            tools: None,
            key: "k".to_string(),
        };
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tools: Vec<AnthropicToolAcc> = Vec::new();
        let rec = Recorder::default();
        let err = adapter
            .parse_line(
                r#"data: {"type":"error","error":{"type":"overloaded_error","message":"server is overloaded"}}"#,
                &mut content,
                &mut thinking,
                &mut tools,
                &rec.as_sink(),
            )
            .unwrap_err();
        assert!(err.contains("Anthropic"), "got: {err}");
        assert!(err.contains("overloaded"), "got: {err}");
    }

    #[test]
    fn anthropic_finalize_skips_empty_tool_blocks() {
        // A text-only response must not surface a phantom tool call.
        let content = String::new();
        let thinking = String::new();
        let tools: Vec<AnthropicToolAcc> = vec![AnthropicToolAcc::default()];
        let response = AnthropicAdapter::finalize_response(content, thinking, tools);
        assert!(response.tool_calls.is_empty());
    }
}
