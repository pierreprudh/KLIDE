mod pty;
use pty::{
    delegate_pty_resize, delegate_pty_spawn, delegate_pty_stop, delegate_pty_write, pty_spawn, pty_write,
    DelegatePtyState, PtyState,
};
use std::process::Command;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
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
struct AiChatResponse {
    content: String,
    thinking: Option<String>,
    tool_calls: Vec<serde_json::Value>,
}

// One streamed delta pushed to the frontend through the per-request Channel.
// `content`/`thinking` are incremental fragments — the UI appends them for the
// live typing effect, then reconciles against ai_chat's authoritative return.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamChunk {
    content: String,
    thinking: String,
}

// Accumulates one OpenAI streamed tool call. The API splits a single call
// across many deltas: `id`/`name` arrive once, `arguments` as JSON fragments
// that must be concatenated before parsing.
#[derive(Default)]
struct ToolAcc {
    id: String,
    name: String,
    args: String,
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
        "ollama" => Ok(None),
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
    matches!(provider, "claude-code" | "codex" | "opencode" | "gemini-cli")
}

fn subscription_command(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude-code" => Ok("claude"),
        "codex" => Ok("codex"),
        "opencode" => Ok("opencode"),
        "gemini-cli" => Ok("gemini"),
        _ => Err(format!("Provider \"{provider}\" is not a subscription CLI")),
    }
}

fn provider_chat_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "openai" => Ok("https://api.openai.com/v1/chat/completions"),
        "mistral" => Ok("https://api.mistral.ai/v1/chat/completions"),
        "xai" => Ok("https://api.x.ai/v1/chat/completions"),
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
        "opencode" => vec!["opencode".to_string()],
        "gemini-cli" => vec!["gemini-2.5-pro".to_string(), "gemini-2.5-flash".to_string()],
        _ => return Err(format!("Provider \"{provider}\" is not a subscription CLI")),
    };
    Ok(models)
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
        "gemini-cli" => vec!["gemini auth login".to_string()],
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
        "gemini-cli" => (
            false,
            "Gemini CLI status check is not wired yet".to_string(),
        ),
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
        return Ok(false);
    }

    if provider != "ollama" {
        return Ok(matches!(provider.as_str(), "openai" | "mistral" | "xai"));
    }

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
    Ok(value
        .get("capabilities")
        .and_then(|caps| caps.as_array())
        .is_some_and(|caps| caps.iter().any(|cap| cap.as_str() == Some("tools"))))
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
        "gemini" => vec![format!("{home}/.local/bin/gemini")],
        "opencode" => vec![format!("{home}/.local/bin/opencode")],
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
        Ok::<_, String>((status, stdout_text.trim().to_string(), stderr_text.trim().to_string()))
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
        "gemini-cli" => {
            ensure_command_available("gemini")?;
            return Err("Gemini CLI command shape is not wired yet".to_string());
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

async fn ollama_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true
    });
    if let Some(tools) = tools {
        body["tools"] = serde_json::Value::Array(tools);
    }

    let mut res = reqwest::Client::new()
        .post(format!("{OLLAMA_URL}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Unable to reach Ollama: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(response_error("Ollama", status, &text));
    }

    let mut content = String::new();
    let mut thinking = String::new();
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    let mut buf = String::new();

    // Ollama streams one JSON object per line. Parse each completed line as it
    // arrives, emit any content/thinking delta, and stash tool calls for the
    // final return.
    let mut handle_line = |line: &str, content: &mut String, thinking: &mut String| {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        let Some(message) = value.get("message") else {
            return;
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
            let _ = on_chunk.send(StreamChunk {
                content: c.to_string(),
                thinking: t.to_string(),
            });
        }
        if let Some(calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
            tool_calls.extend(calls.iter().cloned());
        }
    };

    while let Some(bytes) = res.chunk().await.map_err(|e| e.to_string())? {
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            handle_line(&line, &mut content, &mut thinking);
        }
    }
    if !buf.trim().is_empty() {
        let line = std::mem::take(&mut buf);
        handle_line(&line, &mut content, &mut thinking);
    }

    Ok(AiChatResponse {
        content,
        thinking: if thinking.is_empty() {
            None
        } else {
            Some(thinking)
        },
        tool_calls,
    })
}

async fn openai_compatible_chat(
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let key = provider_key(&provider)?.ok_or_else(|| "Missing API key".to_string())?;
    let mut body = serde_json::json!({
        "model": model,
        "messages": normalize_openai_messages(messages),
        "stream": true,
    });
    if let Some(tools) = tools {
        body["tools"] = serde_json::Value::Array(tools);
        body["tool_choice"] = serde_json::json!("auto");
    }

    let mut res = reqwest::Client::new()
        .post(provider_chat_url(&provider)?)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Unable to reach {provider}: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(response_error(&provider, status, &text));
    }

    let mut content = String::new();
    let mut tool_acc: Vec<ToolAcc> = Vec::new();
    let mut buf = String::new();

    // OpenAI-compatible streams are Server-Sent Events: lines prefixed with
    // `data:`, terminated by a blank line, ending with `data: [DONE]`. Content
    // arrives as `delta.content`; tool calls as indexed `delta.tool_calls`
    // fragments we reassemble in `tool_acc`.
    let mut handle_line = |line: &str, content: &mut String| {
        let Some(data) = line.trim().strip_prefix("data:") else {
            return;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return;
        };
        let Some(delta) = value
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .and_then(|choice| choice.get("delta"))
        else {
            return;
        };
        if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
            if !c.is_empty() {
                content.push_str(c);
                let _ = on_chunk.send(StreamChunk {
                    content: c.to_string(),
                    thinking: String::new(),
                });
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for call in calls {
                let index = call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                while tool_acc.len() <= index {
                    tool_acc.push(ToolAcc::default());
                }
                let acc = &mut tool_acc[index];
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
    };

    while let Some(bytes) = res.chunk().await.map_err(|e| e.to_string())? {
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            handle_line(&line, &mut content);
        }
    }
    if !buf.trim().is_empty() {
        let line = std::mem::take(&mut buf);
        handle_line(&line, &mut content);
    }

    // Re-emit tool calls in the same shape the non-streaming path produced, so
    // the frontend parser and normalize_openai_messages stay unchanged.
    let tool_calls: Vec<serde_json::Value> = tool_acc
        .into_iter()
        .filter(|t| !t.name.is_empty())
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "type": "function",
                "function": { "name": t.name, "arguments": t.args },
            })
        })
        .collect();

    Ok(AiChatResponse {
        content,
        thinking: None,
        tool_calls,
    })
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

// Accumulates one Anthropic streamed content block, keyed by its `index`. Text
// blocks stream as `text_delta`; tool calls start with id+name then stream
// their arguments as `input_json_delta` fragments we concatenate.
#[derive(Default)]
struct AnthropicBlock {
    is_tool: bool,
    id: String,
    name: String,
    args: String,
}

// Append a turn's blocks, merging into the previous turn when the role matches.
// Anthropic requires strictly alternating user/assistant turns, so consecutive
// tool results (which we model as `user`) must collapse into one message.
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

// Convert OpenAI-shaped history into Anthropic's (system, messages) split.
// System prompts become a top-level string; tool results become `tool_result`
// blocks inside a user turn; assistant tool calls become `tool_use` blocks.
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
                let block = serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": text_from_message(message),
                });
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
                        // Arguments may be a JSON string (OpenAI shape) or already
                        // an object; Anthropic wants a parsed object in `input`.
                        let input = match function.and_then(|f| f.get("arguments")) {
                            Some(serde_json::Value::String(s)) => {
                                serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({}))
                            }
                            Some(other) => other.clone(),
                            None => serde_json::json!({}),
                        };
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input,
                        }));
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

// Convert OpenAI function-tool definitions into Anthropic's tool shape:
// `{name, description, input_schema}` where input_schema is the JSON Schema.
fn anthropic_tools(tools: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    tools
        .into_iter()
        .filter_map(|t| {
            let function = t.get("function")?;
            let name = function.get("name")?.as_str()?;
            let mut tool = serde_json::json!({ "name": name });
            if let Some(description) = function.get("description") {
                tool["description"] = description.clone();
            }
            tool["input_schema"] = function
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
            Some(tool)
        })
        .collect()
}

async fn anthropic_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let key = provider_key("anthropic")?.ok_or_else(|| "Missing API key".to_string())?;
    let (system, msgs) = anthropic_messages(messages);
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "stream": true,
        "messages": msgs,
    });
    if !system.trim().is_empty() {
        body["system"] = serde_json::Value::String(system);
    }
    if let Some(tools) = tools {
        let converted = anthropic_tools(tools);
        if !converted.is_empty() {
            body["tools"] = serde_json::Value::Array(converted);
            body["tool_choice"] = serde_json::json!({ "type": "auto" });
        }
    }

    let mut res = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Unable to reach Anthropic: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(response_error("Anthropic", status, &text));
    }

    let mut content = String::new();
    let mut blocks: Vec<AnthropicBlock> = Vec::new();
    let mut buf = String::new();

    // Anthropic streams SSE: each `data:` line is a typed event. We only need
    // content_block_start (to learn a block's kind/id/name) and
    // content_block_delta (text or tool-arg fragments); other events are noise.
    let mut handle_line = |line: &str, content: &mut String| {
        let Some(data) = line.trim().strip_prefix("data:") else {
            return;
        };
        let data = data.trim();
        if data.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return;
        };
        match value.get("type").and_then(|v| v.as_str()).unwrap_or_default() {
            "content_block_start" => {
                let index = value.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                while blocks.len() <= index {
                    blocks.push(AnthropicBlock::default());
                }
                if let Some(cb) = value.get("content_block") {
                    if cb.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        let acc = &mut blocks[index];
                        acc.is_tool = true;
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
                while blocks.len() <= index {
                    blocks.push(AnthropicBlock::default());
                }
                let Some(delta) = value.get("delta") else {
                    return;
                };
                match delta.get("type").and_then(|v| v.as_str()) {
                    Some("text_delta") => {
                        if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                content.push_str(t);
                                let _ = on_chunk.send(StreamChunk {
                                    content: t.to_string(),
                                    thinking: String::new(),
                                });
                            }
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(p) = delta.get("partial_json").and_then(|v| v.as_str()) {
                            blocks[index].args.push_str(p);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    };

    while let Some(bytes) = res.chunk().await.map_err(|e| e.to_string())? {
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            handle_line(&line, &mut content);
        }
    }
    if !buf.trim().is_empty() {
        let line = std::mem::take(&mut buf);
        handle_line(&line, &mut content);
    }

    // Re-emit tool calls in the OpenAI shape the frontend parser expects.
    let tool_calls: Vec<serde_json::Value> = blocks
        .into_iter()
        .filter(|b| b.is_tool && !b.name.is_empty())
        .map(|b| {
            serde_json::json!({
                "id": b.id,
                "type": "function",
                "function": {
                    "name": b.name,
                    "arguments": if b.args.is_empty() { "{}".to_string() } else { b.args },
                },
            })
        })
        .collect();

    Ok(AiChatResponse {
        content,
        thinking: None,
        tool_calls,
    })
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
    updated_ms: i64,
    message_count: u32,
    status: String, // "running" (touched <2min ago) | "done"
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
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
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
            }
            _ => {}
        }
    }
    let updated_ms = mtime_ms(path);
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
        updated_ms,
        message_count: count,
    })
}

fn parse_codex_run(
    path: &std::path::Path,
    index: &std::collections::HashMap<String, String>,
) -> Option<AgentRun> {
    let content = std::fs::read_to_string(path).ok()?;
    let (mut id, mut cwd, mut branch, mut model) = (None, None, None, None);
    let mut count: u32 = 0;
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
                    if let Some(m) = payload.and_then(|p| p.get("model")).and_then(|m| m.as_str()) {
                        if !m.is_empty() {
                            model = Some(m.to_string());
                        }
                    }
                }
            }
            Some("response_item") => count += 1,
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
        updated_ms,
        message_count: count,
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
fn list_agent_runs(limit: Option<usize>, offset: Option<usize>) -> Result<Vec<AgentRun>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let cap = limit.unwrap_or(10);
    let off = offset.unwrap_or(0);

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

    // Stat-and-sort is cheap; parse only the requested page (offset..offset+cap)
    // so big histories stay fast and the UI can lazily page in older runs.
    candidates.sort_by(|a, b| b.2.cmp(&a.2));

    let codex_index = load_codex_index(&home);
    let mut runs: Vec<AgentRun> = candidates
        .into_iter()
        .skip(off)
        .take(cap)
        .filter_map(|(path, source, _)| {
            if source == "claude-code" {
                parse_claude_run(&path)
            } else {
                parse_codex_run(&path, &codex_index)
            }
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            delegate_pty_spawn,
            delegate_pty_write,
            delegate_pty_resize,
            delegate_pty_stop,
            list_dir,
            read_text_file,
            git_status,
            git_stage,
            git_unstage,
            git_commit,
            git_diff,
            project_graph,
            list_agent_runs,
            read_agent_run,
            ai_provider_models,
            ai_subscription_status,
            ai_context_window,
            ai_model_supports_tools,
            ai_provider_key_status,
            ai_set_provider_key,
            ai_clear_provider_key,
            ai_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
