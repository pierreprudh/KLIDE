mod agent;
mod pty;
use pty::{
    delegate_pty_resize, delegate_pty_spawn, delegate_pty_stop, delegate_pty_write, pty_spawn,
    pty_write, DelegatePtyState, PtyState,
};
use std::process::Command;
use std::process::Stdio;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

const OLLAMA_URL: &str = "http://localhost:11434";

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
struct ProjectGraphGroup {
    name: String,
    file_count: usize,
    changed_count: usize,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
struct ProjectGraphChange {
    path: String,
    status: String,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
struct ProjectGraphFile {
    path: String,
    status: String,
    changed: bool,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
struct ProjectGraph {
    root_name: String,
    branch: String,
    total_files: usize,
    changed_files: usize,
    additions: usize,
    deletions: usize,
    groups: Vec<ProjectGraphGroup>,
    changes: Vec<ProjectGraphChange>,
    files: Vec<ProjectGraphFile>,
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
        "mlx" => Ok("http://localhost:8080/v1/chat/completions"),
        "openrouter" => Ok("https://openrouter.ai/api/v1/chat/completions"),
        _ => Err(format!("Provider \"{provider}\" has no chat-completions endpoint")),
    }
}

fn provider_models_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "openai" => Ok("https://api.openai.com/v1/models"),
        "mistral" => Ok("https://api.mistral.ai/v1/models"),
        "xai" => Ok("https://api.x.ai/v1/models"),
        "mlx" => Ok("http://localhost:8080/v1/models"),
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
        let res = reqwest::get(format!("{OLLAMA_URL}/api/tags"))
            .await
            .map_err(|e| format!("Unable to reach Ollama: {e}"))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(response_error("Ollama", status, &body));
        }
        let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let names = value
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
        let res = reqwest::get("http://localhost:8080/v1/models")
            .await
            .map_err(|e| format!("Unable to reach MLX: {e}"))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(response_error("MLX", status, &body));
        }
        let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        return Ok(normalize_model_ids(&value));
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
        "opencode" => opencode_cached_models()
            .unwrap_or_else(|| vec!["opencode".to_string()]),
        _ => return Err(format!("Provider \"{provider}\" is not a subscription CLI")),
    };
    Ok(models)
}

fn opencode_cached_models() -> Option<Vec<String>> {
    let cli = resolve_command("opencode").ok()?;
    let output = std::process::Command::new(cli).arg("models").output().ok()?;
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
        let family = details.and_then(|d| d.get("family")).and_then(|v| v.as_str());
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
        return Ok(true);
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
            if s.starts_with('*') { &s[1..] } else { s }
        })
        .map(|s| s.to_lowercase());

    let mut pending: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if matches.len() >= CAP { capped = true; break; }
            let path = entry.path();
            let ft = match entry.file_type() { Ok(t) => t, Err(_) => continue };
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if ft.is_dir() {
                if !matches!(
                    name.as_str(),
                    ".git" | "node_modules" | "target" | "dist" | ".next" | ".cache" | ".venv" | "__pycache__"
                ) {
                    pending.push(path);
                }
                continue;
            }
            if ft.is_file() {
                if let Some(ref filter) = include_filter {
                    if !name.ends_with(filter) { continue; }
                }
                if path.metadata().map(|m| m.len() > 500_000).unwrap_or(true) { continue; }
                let content = match std::fs::read_to_string(&path) { Ok(c) => c, Err(_) => continue };
                let rel = path.strip_prefix(root).ok().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string_lossy().to_string());
                let mut found_in_file = false;
                for (idx, line) in content.lines().enumerate() {
                    if matches.len() >= CAP { capped = true; break; }
                    if let Some(col) = line.find(&pattern) {
                        if !found_in_file { file_count += 1; found_in_file = true; }
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
        if capped { break; }
    }

    Ok(SearchResult { matches, file_count: file_count as usize, capped })
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

    fn build_request(
        &self,
        client: &reqwest::Client,
    ) -> Result<reqwest::RequestBuilder, String>;

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
    let client = reqwest::Client::new();
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

    fn name(&self) -> &str { "Ollama" }

    fn build_request(&self, client: &reqwest::Client) -> Result<reqwest::RequestBuilder, String> {
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": self.messages,
            "stream": true,
        });
        if let Some(tools) = &self.tools {
            body["tools"] = serde_json::Value::Array(tools.clone());
        }
        Ok(client
            .post(format!("{OLLAMA_URL}/api/chat"))
            .json(&body))
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
        if line.is_empty() { return Ok(()); }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { return Ok(()); };
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            return Err(format!("Ollama error: {error}"));
        }
        let Some(message) = value.get("message") else { return Ok(()); };
        let c = message.get("content").and_then(|v| v.as_str()).unwrap_or_default();
        let t = message.get("thinking").and_then(|v| v.as_str()).unwrap_or_default();
        if !c.is_empty() || !t.is_empty() {
            content.push_str(c);
            thinking.push_str(t);
            on_chunk(StreamChunk { content: c.to_string(), thinking: t.to_string() });
        }
        if let Some(calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
            tools.extend(calls.iter().cloned());
        }
        Ok(())
    }

    fn finalize_response(content: String, thinking: String, tools: Self::ToolAccumulator) -> AiChatResponse {
        AiChatResponse {
            content,
            thinking: if thinking.is_empty() { None } else { Some(thinking) },
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
    let adapter = OllamaAdapter { model, messages, tools };
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

    fn name(&self) -> &str { &self.provider }

    fn build_request(&self, client: &reqwest::Client) -> Result<reqwest::RequestBuilder, String> {
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": normalize_openai_messages(self.messages.clone()),
            "stream": true,
        });
        if let Some(tools) = &self.tools {
            body["tools"] = serde_json::Value::Array(tools.clone());
            body["tool_choice"] = serde_json::json!("auto");
        }
        let mut req = client
            .post(provider_chat_url(&self.provider)?)
            .json(&body);
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
        let Some(data) = line.trim().strip_prefix("data:") else { return Ok(()); };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" { return Ok(()); }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else { return Ok(()); };
        if let Some(error) = value.get("error") {
            let message = error.get("message").and_then(|v| v.as_str()).unwrap_or("stream error");
            return Err(format!("{} error: {message}", self.provider));
        }
        let Some(delta) = value
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .and_then(|c| c.get("delta"))
        else { return Ok(()); };
        if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
            if !c.is_empty() {
                content.push_str(c);
                on_chunk(StreamChunk { content: c.to_string(), thinking: String::new() });
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for call in calls {
                let index = call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                while tools.len() <= index { tools.push(OpenAiToolAcc::default()); }
                let acc = &mut tools[index];
                if let Some(id) = call.get("id").and_then(|v| v.as_str()) { acc.id = id.to_string(); }
                if let Some(function) = call.get("function") {
                    if let Some(name) = function.get("name").and_then(|v| v.as_str()) { acc.name.push_str(name); }
                    if let Some(args) = function.get("arguments").and_then(|v| v.as_str()) { acc.args.push_str(args); }
                }
            }
        }
        Ok(())
    }

    fn finalize_response(content: String, _thinking: String, tools: Self::ToolAccumulator) -> AiChatResponse {
        let tool_calls: Vec<serde_json::Value> = tools
            .into_iter()
            .filter(|t| !t.name.is_empty())
            .map(|t| serde_json::json!({
                "id": t.id, "type": "function",
                "function": { "name": t.name, "arguments": t.args },
            }))
            .collect();
        AiChatResponse { content, thinking: None, tool_calls }
    }
}

async fn openai_compatible_chat(
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let key = provider_key(&provider)?.ok_or_else(|| "Missing API key".to_string())?;
    let adapter = OpenAiAdapter { provider, model, messages, tools, key: Some(key) };
    stream_provider(adapter, on_chunk).await
}

async fn mlx_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let adapter = OpenAiAdapter { provider: "mlx".to_string(), model, messages, tools, key: None };
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
    if blocks.is_empty() { return; }
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
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "system" => {
                let text = text_from_message(message);
                if !text.trim().is_empty() { system_parts.push(text); }
            }
            "tool" => {
                let id = message.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or_default();
                let block = serde_json::json!({ "type": "tool_result", "tool_use_id": id, "content": text_from_message(message) });
                anthropic_push(&mut turns, "user", vec![block]);
            }
            "assistant" => {
                let mut blocks = Vec::new();
                let text = text_from_message(message);
                if !text.trim().is_empty() { blocks.push(serde_json::json!({ "type": "text", "text": text })); }
                if let Some(calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
                    for call in calls {
                        let id = call.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                        let function = call.get("function");
                        let name = function.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or_default();
                        let input = match function.and_then(|f| f.get("arguments")) {
                            Some(serde_json::Value::String(s)) => serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({})),
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
                    anthropic_push(&mut turns, "user", vec![serde_json::json!({ "type": "text", "text": text })]);
                }
            }
        }
    }
    let out = turns.into_iter().map(|(role, blocks)| serde_json::json!({ "role": role, "content": blocks })).collect();
    (system_parts.join("\n\n"), out)
}

fn anthropic_tools(tools: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    tools.into_iter().filter_map(|t| {
        let function = t.get("function")?;
        let name = function.get("name")?.as_str()?;
        let mut tool = serde_json::json!({ "name": name });
        if let Some(desc) = function.get("description") { tool["description"] = desc.clone(); }
        tool["input_schema"] = function.get("parameters").cloned().unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
        Some(tool)
    }).collect()
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

    fn name(&self) -> &str { "Anthropic" }

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
        let Some(data) = line.trim().strip_prefix("data:") else { return Ok(()); };
        let data = data.trim();
        if data.is_empty() { return Ok(()); }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else { return Ok(()); };
        match value.get("type").and_then(|v| v.as_str()).unwrap_or_default() {
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
                while tools.len() <= index { tools.push(AnthropicToolAcc::default()); }
                if let Some(cb) = value.get("content_block") {
                    if cb.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        let acc = &mut tools[index];
                        acc.id = cb.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                        acc.name = cb.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    }
                }
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                while tools.len() <= index { tools.push(AnthropicToolAcc::default()); }
                let Some(delta) = value.get("delta") else { return Ok(()); };
                match delta.get("type").and_then(|v| v.as_str()) {
                    Some("text_delta") => {
                        if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                content.push_str(t);
                                on_chunk(StreamChunk { content: t.to_string(), thinking: String::new() });
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

    fn finalize_response(content: String, _thinking: String, tools: Self::ToolAccumulator) -> AiChatResponse {
        let tool_calls: Vec<serde_json::Value> = tools
            .into_iter()
            .filter(|b| !b.name.is_empty())
            .map(|b| serde_json::json!({
                "id": b.id, "type": "function",
                "function": {
                    "name": b.name,
                    "arguments": if b.args.is_empty() { "{}".to_string() } else { b.args },
                },
            }))
            .collect();
        AiChatResponse { content, thinking: None, tool_calls }
    }
}

async fn anthropic_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let key = provider_key("anthropic")?.ok_or_else(|| "Missing API key".to_string())?;
    let adapter = AnthropicAdapter { model, messages, tools, key };
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
fn create_pr(workspace_root: String, title: String, body: Option<String>) -> Result<String, String> {
    // Create a branch from the current changes. Cap the name at 50 chars —
    // truncate() takes a BYTE index and panics mid-char on non-ASCII titles
    // (is_alphanumeric keeps accented/Unicode letters), so count chars instead.
    let branch: String = format!("klide/{}", title.to_lowercase().replace(|c: char| !c.is_alphanumeric() && c != '-', "-").trim_matches('-'))
        .chars()
        .take(50)
        .collect();

    // Check if gh CLI is available
    let gh_check = Command::new("gh").arg("--version").output();
    if gh_check.is_err() || !gh_check.unwrap().status.success() {
        return Err("GitHub CLI (gh) is not installed. Install it with: brew install gh".to_string());
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
        .args(["-C", &workspace_root, "push", "-u", "origin", branch.as_str()])
        .output()
        .map_err(|e| format!("Failed to push: {e}"))?;
    if !push.status.success() {
        let err = String::from_utf8_lossy(&push.stderr);
        let _ = Command::new("git").args(["-C", &workspace_root, "checkout", "-"]).status();
        let _ = Command::new("git").args(["-C", &workspace_root, "branch", "-D", branch.as_str()]).status();
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
        Ok(if url.is_empty() { format!("PR created on branch '{branch}'") } else { url })
    } else {
        let err = String::from_utf8_lossy(&pr.stderr);
        Err(format!("PR creation failed: {}", err.trim()))
    }
}

#[tauri::command]
fn create_worktree(workspace_root: String, name: String) -> Result<String, String> {
    let safe = name.to_lowercase().replace(|c: char| !c.is_alphanumeric() && c != '-', "-").trim_matches('-').to_string();
    let branch = format!("feature/{safe}");
    let worktree_path = format!("{}-{}", workspace_root.trim_end_matches('/'), safe);

    run_git(&workspace_root, &["checkout", "-b", &branch])?;
    let output = Command::new("git")
        .args(["-C", &workspace_root, "worktree", "add", worktree_path.as_str(), &branch])
        .output()
        .map_err(|e| format!("Failed to create worktree: {e}"))?;

    if !output.status.success() {
        let _ = run_git(&workspace_root, &["checkout", "-"]);
        let _ = run_git(&workspace_root, &["branch", "-D", &branch]);
        return Err(format!("Worktree creation failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
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

fn graph_group_name(path: &str) -> String {
    let first = path.split('/').next().unwrap_or(path);
    match first {
        "src" => "Frontend".to_string(),
        "src-tauri" => "Tauri".to_string(),
        "public" => "Assets".to_string(),
        ".github" => "Automation".to_string(),
        _ if path.contains('/') => first.to_string(),
        _ => "Root".to_string(),
    }
}

#[tauri::command]
fn project_graph(workspace_root: String) -> Result<ProjectGraph, String> {
    use std::collections::BTreeMap;

    let branch = git_output(&workspace_root, &["branch", "--show-current"])?
        .trim()
        .to_string();
    let files_out = git_output(&workspace_root, &["ls-files"])?;
    let tracked_files: Vec<String> = files_out
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.to_string())
        .collect();

    let status = git_status(workspace_root.clone())?;
    let mut additions_by_path: BTreeMap<String, usize> = BTreeMap::new();
    let mut deletions_by_path: BTreeMap<String, usize> = BTreeMap::new();

    let numstat = git_output(&workspace_root, &["diff", "--numstat"])?;
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let adds = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let dels = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if let Some(path) = parts.next() {
            additions_by_path.insert(path.to_string(), adds);
            deletions_by_path.insert(path.to_string(), dels);
        }
    }

    let staged_numstat = git_output(&workspace_root, &["diff", "--cached", "--numstat"])?;
    for line in staged_numstat.lines() {
        let mut parts = line.split('\t');
        let adds = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let dels = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if let Some(path) = parts.next() {
            *additions_by_path.entry(path.to_string()).or_default() += adds;
            *deletions_by_path.entry(path.to_string()).or_default() += dels;
        }
    }

    for file in &status.files {
        if file.status == "??" {
            let full_path = std::path::Path::new(&workspace_root).join(&file.path);
            let line_count = std::fs::read_to_string(full_path)
                .map(|content| content.lines().count().max(1))
                .unwrap_or(0);
            additions_by_path.insert(file.path.clone(), line_count);
            deletions_by_path.insert(file.path.clone(), 0);
        }
    }

    let mut groups: BTreeMap<String, ProjectGraphGroup> = BTreeMap::new();
    let status_by_path: BTreeMap<String, String> = status
        .files
        .iter()
        .map(|file| (file.path.clone(), file.status.clone()))
        .collect();

    for path in &tracked_files {
        let name = graph_group_name(path);
        let entry = groups.entry(name.clone()).or_insert(ProjectGraphGroup {
            name,
            file_count: 0,
            changed_count: 0,
            additions: 0,
            deletions: 0,
        });
        entry.file_count += 1;
    }

    let mut changes = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;
    for file in &status.files {
        let adds = additions_by_path.get(&file.path).copied().unwrap_or(0);
        let dels = deletions_by_path.get(&file.path).copied().unwrap_or(0);
        additions += adds;
        deletions += dels;

        let name = graph_group_name(&file.path);
        let entry = groups.entry(name.clone()).or_insert(ProjectGraphGroup {
            name,
            file_count: 0,
            changed_count: 0,
            additions: 0,
            deletions: 0,
        });
        entry.changed_count += 1;
        entry.additions += adds;
        entry.deletions += dels;

        changes.push(ProjectGraphChange {
            path: file.path.clone(),
            status: file.status.clone(),
            additions: adds,
            deletions: dels,
        });
    }

    let mut graph_files: Vec<ProjectGraphFile> = tracked_files
        .iter()
        .map(|path| {
            let status = status_by_path.get(path).cloned().unwrap_or_default();
            ProjectGraphFile {
                path: path.clone(),
                changed: !status.is_empty(),
                additions: additions_by_path.get(path).copied().unwrap_or(0),
                deletions: deletions_by_path.get(path).copied().unwrap_or(0),
                status,
            }
        })
        .collect();

    for file in &status.files {
        if file.status == "??" && !graph_files.iter().any(|tracked| tracked.path == file.path) {
            graph_files.push(ProjectGraphFile {
                path: file.path.clone(),
                status: file.status.clone(),
                changed: true,
                additions: additions_by_path.get(&file.path).copied().unwrap_or(0),
                deletions: deletions_by_path.get(&file.path).copied().unwrap_or(0),
            });
        }
    }

    graph_files.sort_by(|a, b| a.path.cmp(&b.path));

    let root_name = std::path::Path::new(&workspace_root)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| workspace_root.clone());

    Ok(ProjectGraph {
        root_name,
        branch: if branch.is_empty() {
            "unknown".to_string()
        } else {
            branch
        },
        total_files: tracked_files.len(),
        changed_files: status.files.len(),
        additions,
        deletions,
        groups: groups.into_values().collect(),
        changes,
        files: graph_files,
    })
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
fn parse_opencode_run(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Option<AgentRun> {
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
            if s.is_empty() { None } else { Some(s) }
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
    let conn = opencode_connect()
        .ok_or_else(|| "OpenCode session database is unavailable".to_string())?;

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
        if let Some(text) =
            opencode_message_text(parts.map(|v| v.as_slice()).unwrap_or(&[]))
        {
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
        created_ms: updated_ms, // fallback to mtime
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
    let content = std::fs::read_to_string(path).ok()?;
    let (mut id, mut cwd, mut branch, mut model) = (None, None, None, None);
    let mut count: u32 = 0;
    let (mut input_tokens, mut output_tokens): (i64, i64) = (0, 0);
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
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
        created_ms,
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
fn list_agent_runs(app: tauri::AppHandle, limit: Option<usize>, offset: Option<usize>) -> Result<Vec<AgentRun>, String> {
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
                "opencode" => opencode_conn.as_ref().and_then(|c| parse_opencode_run(c, path.to_str().unwrap_or("")))?,
                _ => return None,
            };
            // Inject parent_id from spawn mapping if available.
            // Try by Klide's internal ID first, then by external session ID
            // (for cases where OpenCode created its own session ID different
            // from the session_id we passed to delegate_pty_spawn).
            if run.parent_id.is_none() {
                let parent = by_delegate.get(&run.id)
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
            let python = if std::env::consts::OS == "macos" {
                "python3"
            } else {
                "python"
            };
            Ok((python.to_string(), vec![
                "-m".to_string(),
                "mlx_lm.server".to_string(),
                "--model".to_string(),
                model.to_string(),
            ]))
        }
        _ => Err(format!("{provider} is not a local server provider")),
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

    let url = match provider.as_str() {
        "ollama" => format!("{OLLAMA_URL}/api/tags"),
        "mlx" => "http://localhost:8080/v1/models".to_string(),
        _ => return Ok(false),
    };

    // Already running externally or previously started
    if let Ok(res) = reqwest::get(&url).await {
        if res.status().is_success() {
            return Ok(true);
        }
    }

    {
        let procs = state.processes.lock().map_err(|e| e.to_string())?;
        if procs.contains_key(&provider) {
            return Ok(true);
        }
    }

    let (cmd, args) = local_server_command(&provider, &model)?;

    let stderr_path = std::env::temp_dir().join(format!("klide-{provider}-stderr.log"));
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|e| format!("Failed to create stderr log: {e}"))?;

    let mut child = Command::new(&cmd)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| {
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

    // MLX model loading can take 10–20 s on first run; retry up to 20 s.
    for _ in 0..40 {
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

        if let Ok(res) = reqwest::get(&url).await {
            if res.status().is_success() {
                let mut procs = state.processes.lock().map_err(|e| e.to_string())?;
                procs.insert(provider, child);
                return Ok(true);
            }
        }
    }

    // Timeout — clean up and show last stderr lines
    let _ = child.kill();
    let _ = child.wait();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    if stderr.trim().is_empty() {
        Ok(false)
    } else {
        Err(format!("{provider} timed out starting. Last stderr:\n{stderr}"))
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

#[tauri::command]
async fn ai_local_server_status(provider: String) -> Result<bool, String> {
    if !is_local_server_provider(&provider) {
        return Ok(false);
    }
    let url = match provider.as_str() {
        "ollama" => format!("{OLLAMA_URL}/api/tags"),
        "mlx" => "http://localhost:8080/v1/models".to_string(),
        _ => return Ok(false),
    };
    match reqwest::get(&url).await {
        Ok(res) => Ok(res.status().is_success()),
        Err(_) => Ok(false),
    }
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
            use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem};

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
                .item(&SubmenuBuilder::new(handle, "Klide")
                    .item(&MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(handle)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(handle, None)?)
                    .item(&PredefinedMenuItem::hide_others(handle, None)?)
                    .item(&PredefinedMenuItem::show_all(handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(handle, None)?)
                    .build()?)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |_app_handle, event| {
                let id = event.id().as_ref();
                match id {
                    "command-palette" => { let _ = _app_handle.emit("menu:command-palette", ()); }
                    "find-in-files" => { let _ = _app_handle.emit("menu:find-in-files", ()); }
                    "toggle-terminal" => { let _ = _app_handle.emit("menu:toggle-terminal", ()); }
                    "toggle-search" => { let _ = _app_handle.emit("menu:toggle-search", ()); }
                    "settings" => { let _ = _app_handle.emit("menu:open-settings", ()); }
                    "close-tab" => { let _ = _app_handle.emit("menu:close-tab", ()); }
                    "close-window" => { let _ = _app_handle.emit("menu:close-window", ()); }
                    "open-folder" => { let _ = _app_handle.emit("menu:open-folder", ()); }
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
            project_graph,
            list_agent_runs,
            read_agent_run,
            read_opencode_run,
            ai_provider_models,
            ai_subscription_status,
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
            create_pr,
            create_worktree
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
                .parse_line(line, &mut content, &mut thinking, &mut tools, &rec.as_sink())
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

    fn run_openai(lines: &[&str]) -> (String, Vec<serde_json::Value>, Vec<StreamChunk>) {
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
                .parse_line(line, &mut content, &mut thinking, &mut tools, &rec.as_sink())
                .unwrap();
        }
        let response = OpenAiAdapter::finalize_response(content, thinking, tools);
        (response.content, response.tool_calls, rec.record())
    }

    #[test]
    fn openai_accumulates_content_across_chunks() {
        let lines = [
            r#"data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"content":"lo "}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"content":"there"}}]}"#,
            r#"data: [DONE]"#,
        ];
        let (content, tools, chunks) = run_openai(&lines);
        assert_eq!(content, "Hello there");
        assert!(tools.is_empty());
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].content, "Hel");
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
        let (content, tools, chunks) = run_openai(&lines);
        assert!(content.is_empty());
        assert!(chunks.is_empty());
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["id"], "call_1");
        assert_eq!(tools[0]["function"]["name"], "read");
        let args: serde_json::Value = serde_json::from_str(tools[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["path"], "x.rs");
    }

    #[test]
    fn openai_ignores_prefixless_and_done_lines() {
        let (content, tools, chunks) = run_openai(&[
            "event: ping",
            ":heartbeat",
            "data: [DONE]",
            "",
        ]);
        assert!(content.is_empty());
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
                .parse_line(line, &mut content, &mut thinking, &mut tools, &rec.as_sink())
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
        let args: serde_json::Value = serde_json::from_str(tools[0]["function"]["arguments"].as_str().unwrap()).unwrap();
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
