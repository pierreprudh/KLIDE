// Model discovery — what models each provider offers, how big their
// context window is, and whether they support tools. Ollama and OpenAI-style
// endpoints get queried live (with a short cache for Ollama tags);
// subscription CLIs read their on-disk model caches with static fallbacks;
// MLX serves its presets. All read-only metadata, no chat traffic.

use crate::providers;
use crate::{
    ensure_command_available, is_subscription_provider, provider_key, resolve_command,
    response_error,
};
use crate::{ANTHROPIC_VERSION, OLLAMA_URL};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use std::time::Instant;

static OLLAMA_MODELS_CACHE: LazyLock<Mutex<Option<(Instant, Vec<String>)>>> =
    LazyLock::new(|| Mutex::new(None));

/// Cached results of the active Ollama reflection probe. Keyed by
/// `"ollama:<model>"`. Lives for the Tauri process so we don't burn a
/// chat inference on every model switch.
pub struct ReflectionProbeCache {
    pub cache: Mutex<HashMap<String, bool>>,
}

impl Default for ReflectionProbeCache {
    fn default() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
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
pub(crate) async fn ai_provider_models(provider: String) -> Result<Vec<String>, String> {
    // A registry miss falls through to the custom (self-hosted) store —
    // those endpoints expose the OpenAI `/v1/models` listing, queried
    // with their (optional) keychain token.
    let Some(entry) = providers::lookup(&provider) else {
        let cp = crate::custom_providers::get(&provider)
            .ok_or_else(|| format!("Provider \"{provider}\" is not wired yet"))?;
        let key = providers::custom_token(&cp.id);
        return fetch_openai_compatible_models(&cp.id, &cp.models_url(), key).await;
    };

    if let Some(spec) = entry.subscription {
        return subscription_models(&spec);
    }

    match entry.models {
        providers::ModelsHandler::Subscription => {
            // Defensive: subscription rows should be caught above.
            unreachable!("subscription rows are handled before the models match")
        }
        providers::ModelsHandler::OllamaTags => fetch_ollama_tags().await,
        providers::ModelsHandler::AnthropicModels => fetch_anthropic_models().await,
        providers::ModelsHandler::OpenAiModels => {
            let openai = match entry.wire {
                providers::WireFormat::OpenAi(cfg) => cfg,
                _ => {
                    return Err(format!(
                        "Provider \"{}\" declares OpenAi models but a non-OpenAI wire",
                        provider
                    ))
                }
            };
            // Hosted providers require a key (errors when missing); local
            // OpenAI-wire ones (LM Studio) return Ok(None) → no auth header.
            let key = provider_key(entry.id)?;
            fetch_openai_compatible_models(entry.id, openai.models_url, key).await
        }
        providers::ModelsHandler::StaticPresets(presets) => {
            Ok(presets.iter().map(|m| (*m).to_string()).collect())
        }
    }
}

/// `GET {OLLAMA_URL}/api/tags` with a 10-second in-process cache.
async fn fetch_ollama_tags() -> Result<Vec<String>, String> {
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
    Ok(names)
}

async fn fetch_anthropic_models() -> Result<Vec<String>, String> {
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
    Ok(normalize_model_ids(&value))
}

async fn fetch_openai_compatible_models(
    provider: &str,
    url: &str,
    key: Option<String>,
) -> Result<Vec<String>, String> {
    let mut req = reqwest::Client::new().get(url);
    if let Some(key) = key {
        req = req.bearer_auth(key);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("Unable to reach {provider}: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(response_error(provider, status, &body));
    }
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(normalize_model_ids(&value))
}

fn subscription_models(spec: &providers::SubscriptionSpec) -> Result<Vec<String>, String> {
    // Confirm the CLI is reachable before returning any model list.
    // Without this guard, a "Check the Claude Code install" UI
    // (or the AiPanel's provider chip) would happily display a stale
    // cache from a Claude install that's been moved or uninstalled.
    ensure_command_available(spec.cmd)?;
    let cached = (spec.cached_models)();
    Ok(cached.unwrap_or_else(|| {
        spec.default_models
            .iter()
            .map(|m| (*m).to_string())
            .collect()
    }))
}

pub(crate) fn opencode_cached_models() -> Option<Vec<String>> {
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

pub(crate) fn claude_cached_models() -> Option<Vec<String>> {
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

pub(crate) fn codex_cached_models() -> Option<Vec<String>> {
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
            ] {
                if let Some(window) = map.get(key).and_then(find_context_window) {
                    return Some(window);
                }
            }
            // GGUF reports the window under an architecture-prefixed key, e.g.
            // "llama.context_length", "gemma.context_length",
            // "lfm2moe.context_length". Match the suffix so we don't have to
            // enumerate every model family.
            for (key, child) in map {
                if key.ends_with(".context_length") {
                    if let Some(window) = find_context_window(child) {
                        return Some(window);
                    }
                }
            }
            // Last resort: recurse, but only accept a plausible window. Without
            // the ceiling a stray field like "general.parameter_count"
            // (8.4 billion) gets mistaken for the window, and Ollama is then
            // asked to size an absurd KV cache — which silently kills the run.
            for child in map.values() {
                if let Some(window) = find_context_window(child) {
                    if (1024..=10_000_000).contains(&window) {
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
pub(crate) async fn ai_context_window(provider: String, model: String) -> Result<usize, String> {
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
pub(crate) async fn ai_model_supports_tools(
    provider: String,
    model: String,
) -> Result<bool, String> {
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
        // Ollama reports capabilities as a top-level array of strings, e.g.
        // ["tools", "thinking", "completion"]. The model supports tool calling
        // iff that array contains "tools". (Older code looked for a nested
        // `details.capabilities.tools` bool, which never existed — so every
        // tool-capable model except the hard-coded qwen2/deepseek families was
        // wrongly treated as tool-less and run in degraded chat mode.)
        if let Some(caps) = value.get("capabilities").and_then(|v| v.as_array()) {
            let has_tools = caps.iter().any(|c| c.as_str() == Some("tools"));
            return Ok(has_tools);
        }
        // Fallback for Ollama versions old enough not to report capabilities:
        // trust the known tool-capable families.
        let family = value
            .get("details")
            .and_then(|d| d.get("family"))
            .and_then(|v| v.as_str());
        return Ok(matches!(family, Some("deepseek") | Some("qwen2")));
    }

    if provider == "mlx" {
        return Ok(false);
    }

    Ok(true)
}

#[tauri::command]
pub(crate) async fn ai_model_supports_reflection(
    state: tauri::State<'_, ReflectionProbeCache>,
    provider: String,
    model: String,
) -> Result<bool, String> {
    resolve_reflection_support(&state, &provider, &model).await
}

async fn resolve_reflection_support(
    state: &ReflectionProbeCache,
    provider: &str,
    model: &str,
) -> Result<bool, String> {
    if provider == "anthropic" {
        return Ok(true);
    }

    if let Some(entry) = providers::lookup(provider) {
        if let providers::WireFormat::OpenAi(cfg) = entry.wire {
            return Ok(cfg.supports_reasoning_effort && openai_wire_model_supports_reasoning(model));
        }
    }

    if provider != "ollama" {
        return Ok(false);
    }

    // Fast path: trust Ollama's modelfile capability list.
    if ollama_advertises_thinking(model).await.unwrap_or(false) {
        return Ok(true);
    }

    // Slow path: some local models (e.g. LFM 2.5 8B) accept the `think` param
    // even when the modelfile forgets to advertise the capability. Probe once
    // with a tiny non-streaming chat and cache the verdict for the session.
    let cache_key = format!("ollama:{model}");
    if let Some(cached) = state
        .cache
        .lock()
        .expect("reflection probe cache poisoned")
        .get(&cache_key)
        .copied()
    {
        return Ok(cached);
    }
    let probed = probe_ollama_thinking_support(model).await;
    state
        .cache
        .lock()
        .expect("reflection probe cache poisoned")
        .insert(cache_key, probed);
    Ok(probed)
}

fn openai_wire_model_supports_reasoning(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    let model = lower.rsplit('/').next().unwrap_or(lower.as_str());

    model.starts_with("gpt-5")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
        || model.starts_with("o5")
}

async fn ollama_advertises_thinking(model: &str) -> Result<bool, String> {
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
    Ok(value
        .get("capabilities")
        .and_then(|v| v.as_array())
        .map(|caps| caps.iter().any(|c| c.as_str() == Some("thinking")))
        .unwrap_or(false))
}

/// Sends a one-shot non-streaming chat with `think: true` and decides
/// whether the model actually exposed a thinking channel in the response.
/// Conservative on ambiguity: a missing or empty field means "not supported".
async fn probe_ollama_thinking_support(model: &str) -> bool {
    let req = reqwest::Client::new()
        .post(format!("{OLLAMA_URL}/api/chat"))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "think": true,
            "stream": false,
        }))
        .timeout(Duration::from_secs(15));
    let Ok(res) = req.send().await else { return false; };
    if !res.status().is_success() {
        return false;
    }
    let Ok(body) = res.text().await else { return false; };
    ollama_probe_response_has_thinking(&body)
}

fn ollama_probe_response_has_thinking(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").cloned())
        .and_then(|m| m.get("thinking").cloned())
        .and_then(|t| t.as_str().map(str::to_string))
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_model_id_accepts_the_modern_naming_only() {
        // Modern: claude-<family>-<num>-<num>.
        assert!(is_claude_model_id("claude-sonnet-4-6"));
        assert!(is_claude_model_id("claude-opus-4-6"));
        assert!(is_claude_model_id("claude-haiku-4-5"));
        // Old date-style / 3.x naming and non-Claude ids are rejected.
        assert!(!is_claude_model_id("claude-3-5-sonnet")); // family slot is "3"
        assert!(!is_claude_model_id("gpt-5")); // no claude- prefix
        assert!(!is_claude_model_id("claude-sonnet-4")); // needs two numeric parts
        assert!(!is_claude_model_id("claude-sonnet-latest")); // non-numeric tail
        assert!(!is_claude_model_id("claude-sonnet-4-x"));
    }

    #[test]
    fn claude_rank_orders_sonnet_opus_haiku() {
        assert_eq!(claude_model_rank("claude-sonnet-4-6"), 0);
        assert_eq!(claude_model_rank("claude-opus-4-6"), 1);
        assert_eq!(claude_model_rank("claude-haiku-4-5"), 2);
        assert_eq!(claude_model_rank("claude-mystery-9"), 3);
    }

    #[test]
    fn fallback_context_window_covers_each_family() {
        assert_eq!(fallback_context_window("claude-code", "anything"), 200_000);
        assert_eq!(fallback_context_window("x", "claude-3-opus"), 200_000);
        assert_eq!(fallback_context_window("codex", "anything"), 272_000);
        assert_eq!(fallback_context_window("x", "gpt-5-mini"), 272_000);
        assert_eq!(fallback_context_window("x", "gpt-4.1"), 1_000_000);
        assert_eq!(fallback_context_window("x", "gemini-2.5-pro"), 1_000_000);
        assert_eq!(fallback_context_window("x", "mistral-large-latest"), 128_000);
        assert_eq!(fallback_context_window("x", "grok-3"), 256_000);
        assert_eq!(fallback_context_window("mlx", "anything"), 128_000);
        assert_eq!(fallback_context_window("x", "gemma-2-9b"), 128_000);
        assert_eq!(fallback_context_window("x", "totally-unknown"), 128_000);
    }

    #[test]
    fn find_context_window_walks_known_keys_and_nests() {
        // A bare number is taken as-is (no floor).
        assert_eq!(
            find_context_window(&serde_json::json!({ "context_length": 512 })),
            Some(512)
        );
        // Direct key on the top object.
        assert_eq!(
            find_context_window(&serde_json::json!({ "context_window": 200_000 })),
            Some(200_000)
        );
        // Nested under an unknown key — recursion finds n_ctx (≥1024 floor met).
        assert_eq!(
            find_context_window(&serde_json::json!({ "details": { "n_ctx": 8192 } })),
            Some(8192)
        );
        // A small stray number nested under unknown keys is below the 1024
        // floor for the recursive branch, so it's ignored rather than returned.
        assert_eq!(
            find_context_window(&serde_json::json!({ "foo": { "bar": 10 } })),
            None
        );
    }

    #[test]
    fn find_context_window_handles_gguf_prefix_and_ignores_param_count() {
        // Real shape of Ollama /api/show model_info for LFM2.5-8B-A1B: the
        // window lives under an architecture-prefixed key, and there is a far
        // larger "parameter_count" that must NOT be mistaken for the window.
        let value = serde_json::json!({
            "model_info": {
                "general.parameter_count": 8_467_856_832_u64,
                "lfm2moe.context_length": 128_000,
                "lfm2moe.vocab_size": 128_000,
            }
        });
        assert_eq!(find_context_window(&value), Some(128_000));
    }

    #[test]
    fn normalize_model_ids_pulls_string_ids_from_data() {
        let value = serde_json::json!({
            "data": [{ "id": "a" }, { "id": "b" }, { "noid": 1 }]
        });
        assert_eq!(normalize_model_ids(&value), vec!["a", "b"]);
        // No data array → empty, never panics.
        assert!(normalize_model_ids(&serde_json::json!({})).is_empty());
        assert!(normalize_model_ids(&serde_json::json!({ "data": "nope" })).is_empty());
    }

    #[tokio::test]
    async fn mlx_does_not_advertise_tool_support() {
        let supports = ai_model_supports_tools(
            "mlx".to_string(),
            "mlx-community/Llama-3.1-8B-Instruct-4bit".to_string(),
        )
        .await
        .unwrap();
        assert!(!supports);
    }

    #[tokio::test]
    async fn mlx_does_not_advertise_reflection_support() {
        let supports = resolve_reflection_support(
            &ReflectionProbeCache::default(),
            "mlx",
            "mlx-community/Llama-3.1-8B-Instruct-4bit",
        )
        .await
        .unwrap();
        assert!(!supports);
    }

    #[tokio::test]
    async fn hosted_reasoning_providers_advertise_reflection_support() {
        let cache = ReflectionProbeCache::default();
        assert!(resolve_reflection_support(&cache, "openai", "gpt-5").await.unwrap());
        assert!(resolve_reflection_support(&cache, "openai", "o4-mini").await.unwrap());
        assert!(resolve_reflection_support(&cache, "anthropic", "claude-sonnet-4-6")
            .await
            .unwrap());
        assert!(resolve_reflection_support(&cache, "openrouter", "openai/gpt-5")
            .await
            .unwrap());
        assert!(!resolve_reflection_support(&cache, "openai", "gpt-4.1-mini")
            .await
            .unwrap());
        assert!(!resolve_reflection_support(&cache, "openrouter", "openai/gpt-4.1-mini")
            .await
            .unwrap());
        assert!(!resolve_reflection_support(&cache, "mistral", "mistral-large")
            .await
            .unwrap());
    }

    #[test]
    fn ollama_probe_response_recognises_thinking_field() {
        // Thinking field present and non-empty → supported.
        assert!(ollama_probe_response_has_thinking(
            r#"{"message":{"thinking":"Let me think...","content":"hi"}}"#
        ));
        // Thinking field present but empty → not supported (be conservative).
        assert!(!ollama_probe_response_has_thinking(
            r#"{"message":{"thinking":"","content":"hi"}}"#
        ));
        // No thinking field → not supported.
        assert!(!ollama_probe_response_has_thinking(
            r#"{"message":{"content":"hi"}}"#
        ));
        // Garbage body → not supported.
        assert!(!ollama_probe_response_has_thinking("not json"));
    }

    #[tokio::test]
    async fn mlx_provider_models_returns_presets_without_polling_server() {
        let models = ai_provider_models("mlx".to_string()).await.unwrap();
        assert_eq!(
            models,
            vec![
                "mlx-community/Llama-3.1-8B-Instruct-4bit".to_string(),
                "Qwen/Qwen3-4B-MLX-4bit".to_string(),
                "mlx-community/gemma-2-9b-it-4bit".to_string(),
            ]
        );
    }
}
