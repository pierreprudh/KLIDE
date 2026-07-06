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

/// Per-model metadata harvested from an OpenAI-wire `/models` listing.
/// Aggregators like OpenRouter report the real context window and the
/// per-model parameter list; plain OpenAI does not. All fields optional —
/// `None` means "the endpoint didn't say", so callers keep their heuristic.
#[derive(Clone, Debug, Default)]
struct ModelMeta {
    context_length: Option<usize>,
    /// `Some(true/false)` when the endpoint advertises `supported_parameters`;
    /// `None` when it doesn't (caller falls back to its optimistic default).
    supports_tools: Option<bool>,
    /// Prompt / completion price in USD per *million* tokens, when the
    /// listing reports it (OpenRouter). `None` for endpoints that don't.
    input_per_million: Option<f64>,
    output_per_million: Option<f64>,
}

/// Cached `/models` metadata, keyed by provider id. OpenRouter's listing is
/// 339 models, so we fetch it at most once per `MODEL_META_TTL` and serve the
/// rest from memory — model switching shouldn't re-hit the network.
static OPENAI_MODEL_META_CACHE: LazyLock<
    Mutex<HashMap<String, (Instant, HashMap<String, ModelMeta>)>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));

const MODEL_META_TTL: Duration = Duration::from_secs(300);

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
        if let Some(cli) = crate::custom_cli::get(&provider) {
            return Ok(cli.model_list());
        }
        let cp = crate::custom_providers::get(&provider)
            .ok_or_else(|| format!("Provider \"{provider}\" is not wired yet"))?;
        let key = providers::custom_token(&cp.id);
        return fetch_openai_compatible_models(&cp.id, &cp.models_url(), key).await;
    };

    if let Some(spec) = entry.subscription {
        // Blocking work (login-shell PATH resolution, transcript scans) must
        // not run on the async runtime — a slow scan here stalls every other
        // pending invoke() and the whole app feels frozen.
        return tokio::task::spawn_blocking(move || subscription_models(&spec))
            .await
            .map_err(|e| format!("Model listing task failed: {e}"))?;
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

/// A provider's prepaid balance, in USD. All fields optional: a provider may
/// report usage without a cap, and most hosted providers don't expose a
/// balance at all (then the command returns `Ok(None)`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredits {
    /// Credits/limit granted, USD. `None` when the key has no cap.
    pub total: Option<f64>,
    /// Spent so far, USD.
    pub used: Option<f64>,
    /// `total - used` when both are known; `None` for uncapped keys.
    pub remaining: Option<f64>,
}

/// Live prepaid balance for a provider. Only providers with a public balance
/// endpoint return `Some` — today that's OpenRouter (`/api/v1/credits`).
/// Anthropic, OpenAI, Mistral and xAI don't expose a key balance over the
/// API, so they return `Ok(None)` and the UI omits the gauge for them.
#[tauri::command]
pub(crate) async fn ai_provider_credits(
    provider: String,
) -> Result<Option<ProviderCredits>, String> {
    match provider.as_str() {
        "openrouter" => fetch_openrouter_credits().await.map(Some),
        _ => Ok(None),
    }
}

/// `GET https://openrouter.ai/api/v1/credits` →
/// `{ "data": { "total_credits": f64, "total_usage": f64 } }`.
async fn fetch_openrouter_credits() -> Result<ProviderCredits, String> {
    let key = provider_key("openrouter")?.ok_or_else(|| "Missing API key".to_string())?;
    let res = reqwest::Client::new()
        .get("https://openrouter.ai/api/v1/credits")
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("Unable to reach OpenRouter: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(response_error("OpenRouter", status, &body));
    }
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let data = value.get("data").unwrap_or(&value);
    let total = data.get("total_credits").and_then(|v| v.as_f64());
    let used = data.get("total_usage").and_then(|v| v.as_f64());
    let remaining = match (total, used) {
        (Some(t), Some(u)) => Some(t - u),
        _ => None,
    };
    Ok(ProviderCredits {
        total,
        used,
        remaining,
    })
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

/// Pull per-model metadata out of an OpenAI-wire `/models` response.
/// OpenRouter shape: `data: [{ id, context_length, top_provider:
/// { context_length }, supported_parameters: ["tools", …] }]`. Models the
/// endpoint doesn't describe simply don't appear in the map.
fn parse_openai_models_meta(value: &serde_json::Value) -> HashMap<String, ModelMeta> {
    let mut out = HashMap::new();
    let Some(arr) = value.get("data").and_then(|d| d.as_array()) else {
        return out;
    };
    for m in arr {
        let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        // Top-level `context_length` is the model's window; `top_provider`
        // can carry a (sometimes smaller) per-route value. Prefer top-level.
        let context_length = m
            .get("context_length")
            .and_then(|v| v.as_u64())
            .or_else(|| {
                m.get("top_provider")
                    .and_then(|tp| tp.get("context_length"))
                    .and_then(|v| v.as_u64())
            })
            .map(|n| n as usize);
        // The model supports tool calling iff `supported_parameters` lists
        // "tools". Absent array → `None` (unknown), not `false`.
        let supports_tools = m
            .get("supported_parameters")
            .and_then(|v| v.as_array())
            .map(|params| params.iter().any(|p| p.as_str() == Some("tools")));
        // OpenRouter prices are USD *per token*, encoded as strings
        // (e.g. "0.000001") — sometimes numbers. Accept both, scale to
        // per-million to match the local pricing table's units.
        let price = |key: &str| -> Option<f64> {
            m.get("pricing")
                .and_then(|p| p.get(key))
                .and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                })
                .map(|per_token| per_token * 1_000_000.0)
        };
        out.insert(
            id.to_string(),
            ModelMeta {
                context_length,
                supports_tools,
                input_per_million: price("prompt"),
                output_per_million: price("completion"),
            },
        );
    }
    out
}

/// Fetch (and cache) `/models` metadata for an OpenAI-wire provider.
/// Best-effort: returns an empty map for non-OpenAI-wire providers, when no
/// key is configured, or on any network/parse failure — callers then fall
/// back to their heuristics. Never errors.
async fn openai_model_meta(provider: &str) -> HashMap<String, ModelMeta> {
    {
        let cache = OPENAI_MODEL_META_CACHE.lock().unwrap();
        if let Some((ts, meta)) = cache.get(provider) {
            if ts.elapsed() < MODEL_META_TTL {
                return meta.clone();
            }
        }
    }
    let Some(entry) = providers::lookup(provider) else {
        return HashMap::new();
    };
    let url = match entry.wire {
        providers::WireFormat::OpenAi(cfg) => cfg.models_url,
        _ => return HashMap::new(),
    };
    // No key (or an unresolved reference) → skip auth; OpenRouter's listing
    // is public, but a key keeps it consistent with the chat path.
    let key = provider_key(entry.id).ok().flatten();
    let mut req = reqwest::Client::new().get(url);
    if let Some(key) = key {
        req = req.bearer_auth(key);
    }
    let Ok(res) = req.send().await else {
        return HashMap::new();
    };
    if !res.status().is_success() {
        return HashMap::new();
    }
    let Ok(body) = res.text().await else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else {
        return HashMap::new();
    };
    let meta = parse_openai_models_meta(&value);
    OPENAI_MODEL_META_CACHE
        .lock()
        .unwrap()
        .insert(provider.to_string(), (Instant::now(), meta.clone()));
    meta
}

/// One model's metadata, flattened for the frontend model picker so it can
/// show context window / tool support / price badges per row.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelMetaWire {
    pub id: String,
    pub context_length: Option<usize>,
    pub supports_tools: Option<bool>,
    pub input_per_million: Option<f64>,
    pub output_per_million: Option<f64>,
}

/// Per-model metadata for a provider's picker. Empty for providers whose
/// `/models` listing doesn't expose the richer fields (plain OpenAI), or when
/// no key is set — the picker simply renders no badges then.
#[tauri::command]
pub(crate) async fn ai_provider_model_meta(provider: String) -> Result<Vec<ModelMetaWire>, String> {
    let meta = openai_model_meta(&provider).await;
    Ok(meta
        .into_iter()
        .map(|(id, m)| ModelMetaWire {
            id,
            context_length: m.context_length,
            supports_tools: m.supports_tools,
            input_per_million: m.input_per_million,
            output_per_million: m.output_per_million,
        })
        .collect())
}

/// Resolve a model's context window, in priority order: an explicit override
/// (local `num_ctx`), the provider's advertised per-model window (OpenRouter
/// `/models`), then the name-based heuristic. Shared by the frontend gauge
/// command and the harness's compaction threshold so the two never disagree.
pub(crate) async fn resolve_context_window(provider: &str, model: &str) -> usize {
    if let Some(entry) = providers::lookup(provider) {
        if matches!(entry.models, providers::ModelsHandler::OpenAiModels) {
            if let Some(window) = openai_model_meta(provider)
                .await
                .get(model)
                .and_then(|m| m.context_length)
            {
                return window;
            }
        }
    }
    fallback_context_window(provider, model)
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

pub(crate) fn omp_cached_models() -> Option<Vec<String>> {
    let home = std::env::var("HOME").ok()?;
    let db = std::path::Path::new(&home).join(".omp/agent/models.db");
    if !db.exists() {
        return None;
    }
    let conn = rusqlite::Connection::open(&db).ok()?;
    // `authoritative = 1` marks providers whose model list omp actually
    // fetched live (its credentials worked). The static bundles it ships for
    // every other provider (google-vertex, llama.cpp, …) would flood the
    // picker with models the user can't reach, so they stay out.
    let mut stmt = conn
        .prepare("SELECT provider_id, models FROM model_cache WHERE authoritative = 1")
        .ok()?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?;
    // Local models first, then hosted APIs, aggregators last — mirrors the
    // Klide provider-group order so the top of the picker is the useful part.
    fn provider_rank(id: &str) -> u8 {
        match id {
            "ollama" => 0,
            "anthropic" => 1,
            "openai" => 2,
            "openrouter" => 4,
            _ => 3,
        }
    }
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for (provider, json) in rows.flatten() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
            continue;
        };
        let Some(arr) = value.as_array() else {
            continue;
        };
        // omp's `--model` accepts the qualified "provider/model" form, which
        // also keeps same-named models from colliding across providers.
        let ids: Vec<String> = arr
            .iter()
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
            .map(|id| format!("{provider}/{id}"))
            .collect();
        if !ids.is_empty() {
            groups.push((provider, ids));
        }
    }
    groups.sort_by_key(|(p, _)| provider_rank(p));
    let models: Vec<String> = groups.into_iter().flat_map(|(_, ids)| ids).collect();
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

/// How many of the most recent Claude Code transcripts to scan for model
/// ids, and how much of each. `~/.claude/projects` can run to hundreds of
/// megabytes — reading ALL of it (the old behaviour) blocked the runtime
/// for seconds every time the model list loaded.
const CLAUDE_RECENT_TRANSCRIPTS: usize = 12;
const CLAUDE_TRANSCRIPT_SCAN_BYTES: u64 = 256 * 1024;

pub(crate) fn claude_cached_models() -> Option<Vec<String>> {
    let home = std::env::var("HOME").ok()?;
    let claude_dir = std::path::Path::new(&home).join(".claude");
    let mut models = Vec::new();

    // Recent transcripts first — the models the user actually runs today.
    let mut transcripts: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    collect_jsonl_paths(&claude_dir.join("projects"), &mut transcripts, 0);
    transcripts.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime));
    for (_, path) in transcripts.into_iter().take(CLAUDE_RECENT_TRANSCRIPTS) {
        scan_for_claude_models(&path, &mut models);
    }

    // Then the stats cache — it can lag months behind, so it only fills in
    // models the recent transcripts didn't mention.
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

    // Dedup keeping first-seen order, so recency (not a hardcoded family
    // ranking) decides what tops the picker.
    let mut seen = std::collections::HashSet::new();
    models.retain(|m| seen.insert(m.clone()));
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

fn collect_jsonl_paths(
    path: &std::path::Path,
    out: &mut Vec<(std::time::SystemTime, std::path::PathBuf)>,
    depth: usize,
) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_paths(&path, out, depth + 1);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        out.push((mtime, path));
    }
}

/// Scan the head of one transcript for Claude model ids. Model ids repeat on
/// every assistant message, so the first chunk is enough — never read whole
/// files here (transcripts can be tens of megabytes each).
fn scan_for_claude_models(path: &std::path::Path, models: &mut Vec<String>) {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    let mut buf = Vec::new();
    if file
        .take(CLAUDE_TRANSCRIPT_SCAN_BYTES)
        .read_to_end(&mut buf)
        .is_err()
    {
        return;
    }
    let text = String::from_utf8_lossy(&buf);
    for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')) {
        if is_claude_model_id(token) {
            models.push(token.to_string());
        }
    }
}

fn is_claude_model_id(model: &str) -> bool {
    let Some(rest) = model.strip_prefix("claude-") else {
        return false;
    };
    let family = rest.split('-').next().unwrap_or_default();
    // Fable/Mythos ids carry a single version digit ("claude-fable-5"), the
    // older families two ("claude-sonnet-4-6") — require at least one.
    if !matches!(family, "sonnet" | "opus" | "haiku" | "fable" | "mythos") {
        return false;
    }
    let parts: Vec<&str> = rest.split('-').skip(1).collect();
    if parts.is_empty() {
        return false;
    }
    parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
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

pub(crate) fn fallback_context_window(provider: &str, model: &str) -> usize {
    // A provider with a fixed window owns that fact on its registry row.
    if let Some(window) = providers::lookup(provider).and_then(|e| e.context_window) {
        return window;
    }
    // Otherwise guess from the model name — this is genuinely cross-provider
    // (an aggregator like OpenRouter serves claude-*/gemini/grok slugs under one
    // provider id), so it stays a name heuristic, not a provider fact.
    context_window_for_model_name(model)
}

/// Best-effort context window from a model name alone, for providers whose
/// window is model-dependent. Defaults to 128k for unknown models.
fn context_window_for_model_name(model: &str) -> usize {
    let lower = model.to_lowercase();
    if lower.starts_with("claude-") {
        200_000
    } else if lower.starts_with("gpt-5") {
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
        // gemma and everything unknown
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

    // OpenAI-wire aggregators (OpenRouter) advertise the real per-model
    // window in their `/models` listing; everything else falls back to the
    // name-based heuristic inside `resolve_context_window`.
    Ok(resolve_context_window(&provider, &model).await)
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

    // mlx_lm.server parses tool calls for models with a tool template (Qwen3,
    // Llama-3.1, …) and returns OpenAI-format `tool_calls`. The curated MLX
    // presets are all tool-capable instruct models, so advertise support.
    if provider == "mlx" {
        return Ok(true);
    }

    // OpenAI-wire aggregators (OpenRouter) advertise per-model tool support
    // via `supported_parameters`. Trust it when present so agent/goal mode
    // doesn't silently send `tools` to a chat-only model; if the endpoint
    // doesn't say (plain OpenAI), keep the optimistic default.
    if let Some(entry) = providers::lookup(&provider) {
        if matches!(entry.models, providers::ModelsHandler::OpenAiModels) {
            if let Some(supports) = openai_model_meta(&provider)
                .await
                .get(&model)
                .and_then(|m| m.supports_tools)
            {
                return Ok(supports);
            }
        }
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
    let Ok(res) = req.send().await else {
        return false;
    };
    if !res.status().is_success() {
        return false;
    }
    let Ok(body) = res.text().await else {
        return false;
    };
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

/// Exact token count for a single message's text under a specific model's own
/// tokenizer, where the provider exposes one; otherwise a clearly-marked
/// estimate. `exact: false` means the caller should render the number as
/// approximate (≈). This counts message *content* — the chat-template wrapper
/// (role tags, tool framing, special tokens) the model also sees is not
/// attributed here, so per-message counts won't sum to a full-prompt count.
#[derive(serde::Serialize)]
pub(crate) struct TokenCount {
    pub tokens: u64,
    pub exact: bool,
}

/// Mirror of the frontend `estimateTokens` heuristic (~3.7 chars/token) so the
/// fallback path agrees with the live context gauge.
fn estimate_tokens(text: &str) -> u64 {
    if text.trim().is_empty() {
        return 0;
    }
    (text.chars().count() as f64 / 3.7).ceil() as u64
}

#[tauri::command]
pub(crate) async fn ai_count_tokens(
    provider: String,
    model: String,
    text: String,
) -> Result<TokenCount, String> {
    if text.trim().is_empty() {
        return Ok(TokenCount {
            tokens: 0,
            exact: true,
        });
    }

    // Ollama exposes a local, free, instant tokenizer for the loaded model.
    if provider == "ollama" {
        let res = reqwest::Client::new()
            .post(format!("{OLLAMA_URL}/api/tokenize"))
            .json(&serde_json::json!({ "model": model, "text": text }))
            .send()
            .await;
        // Older Ollama builds lack /api/tokenize — degrade to the estimate
        // rather than erroring the whole call.
        if let Ok(res) = res {
            if res.status().is_success() {
                if let Ok(value) = res.json::<serde_json::Value>().await {
                    if let Some(tokens) = value.get("tokens").and_then(|t| t.as_array()) {
                        return Ok(TokenCount {
                            tokens: tokens.len() as u64,
                            exact: true,
                        });
                    }
                }
            }
        }
        return Ok(TokenCount {
            tokens: estimate_tokens(&text),
            exact: false,
        });
    }

    // Anthropic's count_tokens endpoint is exact for Claude.
    if provider == "anthropic" {
        if let Some(key) = provider_key("anthropic")? {
            let res = reqwest::Client::new()
                .post("https://api.anthropic.com/v1/messages/count_tokens")
                .header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .json(&serde_json::json!({
                    "model": model,
                    "messages": [{ "role": "user", "content": text }],
                }))
                .send()
                .await
                .map_err(|e| format!("Unable to reach Anthropic: {e}"))?;
            if res.status().is_success() {
                if let Ok(value) = res.json::<serde_json::Value>().await {
                    if let Some(n) = value.get("input_tokens").and_then(|v| v.as_u64()) {
                        return Ok(TokenCount {
                            tokens: n,
                            exact: true,
                        });
                    }
                }
            }
        }
        return Ok(TokenCount {
            tokens: estimate_tokens(&text),
            exact: false,
        });
    }

    // OpenAI-wire providers (openai/mistral/xai/mlx/self-hosted) expose no
    // count endpoint — exact counting would need a bundled per-model
    // tokenizer. Best-effort estimate, marked approximate.
    Ok(TokenCount {
        tokens: estimate_tokens(&text),
        exact: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_model_id_accepts_the_modern_naming_only() {
        // Modern: claude-<family>-<num>[-<num>…].
        assert!(is_claude_model_id("claude-sonnet-4-6"));
        assert!(is_claude_model_id("claude-opus-4-6"));
        assert!(is_claude_model_id("claude-haiku-4-5"));
        assert!(is_claude_model_id("claude-sonnet-4-6-20251114")); // dated build
        assert!(is_claude_model_id("claude-fable-5")); // single version digit
        assert!(is_claude_model_id("claude-mythos-5"));
        // Old date-style / 3.x naming and non-Claude ids are rejected.
        assert!(!is_claude_model_id("claude-3-5-sonnet")); // family slot is "3"
        assert!(!is_claude_model_id("gpt-5")); // no claude- prefix
        assert!(!is_claude_model_id("claude-fable")); // no version at all
        assert!(!is_claude_model_id("claude-sonnet-latest")); // non-numeric tail
        assert!(!is_claude_model_id("claude-sonnet-4-x"));
    }

    #[test]
    fn fallback_context_window_covers_each_family() {
        assert_eq!(fallback_context_window("claude-code", "anything"), 200_000);
        assert_eq!(fallback_context_window("x", "claude-3-opus"), 200_000);
        assert_eq!(fallback_context_window("codex", "anything"), 272_000);
        assert_eq!(fallback_context_window("x", "gpt-5-mini"), 272_000);
        assert_eq!(fallback_context_window("x", "gpt-4.1"), 1_000_000);
        assert_eq!(fallback_context_window("x", "gemini-2.5-pro"), 1_000_000);
        assert_eq!(
            fallback_context_window("x", "mistral-large-latest"),
            128_000
        );
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
    fn parse_openai_models_meta_reads_window_and_tool_support() {
        // OpenRouter `/models` shape: per-model context_length +
        // supported_parameters. Tool support is true iff "tools" is listed.
        let value = serde_json::json!({
            "data": [
                {
                    "id": "google/gemini-3.5-flash",
                    "context_length": 1_048_576,
                    "supported_parameters": ["tools", "tool_choice", "response_format"],
                    // OpenRouter encodes per-token prices as strings.
                    "pricing": { "prompt": "0.0000015", "completion": "0.000009" }
                },
                {
                    "id": "some/base-model",
                    "context_length": 8_192,
                    "supported_parameters": ["temperature", "top_p"]
                },
                {
                    // Window only under top_provider; no supported_parameters.
                    "id": "vendor/quiet",
                    "top_provider": { "context_length": 32_768 }
                },
                { "noid": 1 }
            ]
        });
        let meta = parse_openai_models_meta(&value);
        assert_eq!(
            meta["google/gemini-3.5-flash"].context_length,
            Some(1_048_576)
        );
        assert_eq!(meta["google/gemini-3.5-flash"].supports_tools, Some(true));
        // String prices scale per-token → per-million: 0.0000015 → 1.5.
        assert_eq!(meta["google/gemini-3.5-flash"].input_per_million, Some(1.5));
        assert_eq!(
            meta["google/gemini-3.5-flash"].output_per_million,
            Some(9.0)
        );
        // No pricing block → None, never 0.
        assert_eq!(meta["vendor/quiet"].input_per_million, None);
        assert_eq!(meta["some/base-model"].supports_tools, Some(false));
        // Falls back to top_provider.context_length; tool support unknown.
        assert_eq!(meta["vendor/quiet"].context_length, Some(32_768));
        assert_eq!(meta["vendor/quiet"].supports_tools, None);
        // Entry without an id is skipped, never panics.
        assert_eq!(meta.len(), 3);
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
    async fn mlx_advertises_tool_support() {
        // mlx_lm.server returns OpenAI-format tool_calls for the curated
        // presets, so MLX models run the full tool harness (not chat-only).
        let supports = ai_model_supports_tools(
            "mlx".to_string(),
            "mlx-community/Llama-3.1-8B-Instruct-4bit".to_string(),
        )
        .await
        .unwrap();
        assert!(supports);
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
        assert!(resolve_reflection_support(&cache, "openai", "gpt-5")
            .await
            .unwrap());
        assert!(resolve_reflection_support(&cache, "openai", "o4-mini")
            .await
            .unwrap());
        assert!(
            resolve_reflection_support(&cache, "anthropic", "claude-sonnet-4-6")
                .await
                .unwrap()
        );
        assert!(
            resolve_reflection_support(&cache, "openrouter", "openai/gpt-5")
                .await
                .unwrap()
        );
        assert!(
            !resolve_reflection_support(&cache, "openai", "gpt-4.1-mini")
                .await
                .unwrap()
        );
        assert!(
            !resolve_reflection_support(&cache, "openrouter", "openai/gpt-4.1-mini")
                .await
                .unwrap()
        );
        assert!(
            !resolve_reflection_support(&cache, "mistral", "mistral-large")
                .await
                .unwrap()
        );
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
        // Asserts against the live preset constant rather than a hardcoded
        // copy, so adding an MLX preset doesn't silently rot this test.
        let models = ai_provider_models("mlx".to_string()).await.unwrap();
        assert_eq!(models, crate::MLX_MODEL_PRESETS.to_vec());
    }
}
