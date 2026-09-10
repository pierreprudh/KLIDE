//! Provider registry — one row per provider, every per-provider fact in
//! one place. Replaces the five+1 parallel `match provider { ... }`
//! statements that used to live in `lib.rs`.
//!
//! Adding a provider used to mean: edit `provider_key`, `provider_chat_url`,
//! `provider_models_url`, `is_subscription_provider`, `subscription_command`,
//! `ai_chat` dispatch, and `ai_provider_models` dispatch — by hand, with
//! the implicit "OpenAI-compatible" fallback as a tax for forgetting. Now
//! it means: add one row to `PROVIDERS`.
//!
//! The registry declares four per-provider facts:
//!
//! - `wire` — the streaming format (Ollama / Anthropic / OpenAI-family).
//!   Drives `ai_chat` dispatch. Subscription CLIs get a placeholder; the
//!   subscription branch in `ai_chat` returns first so the per-wire match
//!   is never reached for them.
//! - `key` — where the API key comes from (local / keychain-with-env-fallback).
//! - `models` — how `ai_provider_models` lists models. Ollama has its
//!   `/api/tags`, Anthropic has `/v1/models` with `x-api-key` +
//!   `anthropic-version`, OpenAI-family has `/v1/models` with bearer
//!   auth, MLX skips the server entirely and returns a static preset list.
//! - `subscription` — the CLI delegate spec, if any. Carries the
//!   per-CLI command builder and model cache as function pointers, since
//!   each CLI has its own argument shape.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// Streaming wire format the provider speaks. Drives `ai_chat` dispatch.
///
/// `OpenAi` is the catch-all "chat.completions" wire. Mistral, xAI,
/// OpenRouter, LM Studio, and MLX all speak it (with per-provider URL /
/// tool / usage flags in `OpenAiConfig`). The fact that they all share
/// the wire is what used to be implicit and is now explicit.
#[derive(Clone, Copy, Debug)]
pub enum WireFormat {
    /// Ollama's native /api/chat JSON-line stream (eval_count usage).
    Ollama,
    /// Anthropic's Messages API SSE (message_start/message_delta usage).
    Anthropic,
    /// OpenAI chat.completions SSE (prompt_tokens/completion_tokens usage).
    OpenAi(OpenAiConfig),
}

/// Per-provider config for the OpenAI wire. Each OpenAI-family provider
/// has slightly different policies around tools and the usage block;
/// those are the two knobs we expose.
#[derive(Clone, Copy, Debug)]
pub struct OpenAiConfig {
    /// Chat completions endpoint. Resolved at registry write time so the
    /// adapter never has to look it up by string.
    pub chat_url: &'static str,
    /// Models listing endpoint. Used by `ai_provider_models` when the
    /// entry's `models` is `OpenAiModels`.
    pub models_url: &'static str,
    /// Whether the provider accepts `tools` in the request body. MLX's
    /// local server doesn't honour them the same way; everyone else does.
    pub include_tools: bool,
    /// Whether to set `stream_options.include_usage` on the request. The
    /// hosted OpenAI family honours it; local proxies may reject the
    /// field, so leave it off there.
    pub include_usage_in_stream: bool,
    /// Whether this hosted OpenAI-wire provider accepts `reasoning_effort`.
    /// Local/custom OpenAI-compatible endpoints stay false unless explicitly
    /// proven compatible.
    pub supports_reasoning_effort: bool,
    /// Whether to request explicit cost accounting in the request body
    /// (`usage.include` + `stream_options.include_usage`). Aggregators like
    /// OpenRouter only return the real charged cost when asked; plain hosted
    /// APIs price from the table, so they leave this off. The single home for
    /// this quirk — the adapter reads the flag, never the provider id.
    pub include_cost_accounting: bool,
    /// Whether to send Klide app-attribution headers (`HTTP-Referer` /
    /// `X-Title`). OpenRouter surfaces these on its activity dashboard and
    /// public usage rankings; other endpoints ignore them, so we scope the
    /// headers to providers that use them rather than string-matching the id.
    pub send_attribution: bool,
}

/// How a provider's API key is sourced. Local providers don't have one.
#[derive(Clone, Copy, Debug)]
pub enum KeySource {
    /// No key — local provider (Ollama, MLX, LM Studio, subscription CLIs).
    Local,
    /// Hosted provider — key from the keychain, with optional env-var
    /// fallback. `env_legacy` is for xAI's `GROK_API_KEY` alias.
    Hosted {
        env: Option<&'static str>,
        env_legacy: Option<&'static str>,
    },
}

/// How a provider's models are listed. Mirrors the 4 cases the old
/// `ai_provider_models` carried in if-chains.
#[derive(Clone, Copy, Debug)]
pub enum ModelsHandler {
    /// `GET {OLLAMA_URL}/api/tags`.
    OllamaTags,
    /// `GET https://api.anthropic.com/v1/models` with `x-api-key` +
    /// `anthropic-version` headers.
    AnthropicModels,
    /// `GET {models_url}` with bearer auth.
    OpenAiModels,
    /// No HTTP call — return a hardcoded preset list (e.g. MLX).
    StaticPresets(&'static [&'static str]),
    /// Subscription CLI — handled by `subscription_models` (cache + fallback).
    Subscription,
}

/// Per-subscription-CLI spec: the models concern only (cache + fallback +
/// label). How the CLI is *invoked* — one-shot chat, PTY dispatch, resume —
/// is Delegate knowledge and lives behind the Delegate seam
/// (`src/delegate/`), one adapter per CLI.
#[derive(Clone, Copy)]
pub struct SubscriptionSpec {
    /// Binary name as resolved by `resolve_command` (PATH + common
    /// install locations).
    pub cmd: &'static str,
    /// Human-readable label for run output ("Claude Code", "Codex").
    pub label: &'static str,
    /// Static fallback list when the CLI's cache file is absent.
    pub default_models: &'static [&'static str],
    /// Read the CLI's on-disk model cache. Returns None if the file
    /// isn't there yet.
    pub cached_models: fn() -> Option<Vec<String>>,
}

/// One row of the registry. The whole provider lives here.
#[derive(Clone, Copy)]
pub struct ProviderEntry {
    /// The provider id used in Tauri commands and the frontend's
    /// `ProviderId`. Must be unique within `PROVIDERS`.
    pub id: &'static str,
    pub wire: WireFormat,
    pub key: KeySource,
    pub models: ModelsHandler,
    pub subscription: Option<SubscriptionSpec>,
    /// The provider's fixed context window, when every model it serves shares
    /// one (Claude Code = 200k, Codex = 272k, MLX = 128k). `None` when the
    /// window is model-dependent or discovered at runtime (hosted APIs,
    /// OpenRouter, local Ollama) — those fall back to the model-name heuristic
    /// in `models::fallback_context_window`. The single home for this fact.
    pub context_window: Option<usize>,
}

/// The registry. One row per provider. Order is "local first, then hosted
/// API, then subscription CLIs" — purely cosmetic, `lookup` scans.
pub const PROVIDERS: &[ProviderEntry] = &[
    // ── Local: no key, no subscription ──────────────────────────────────
    ProviderEntry {
        id: "ollama",
        wire: WireFormat::Ollama,
        key: KeySource::Local,
        models: ModelsHandler::OllamaTags,
        subscription: None,
        context_window: None,
    },
    ProviderEntry {
        id: "mlx",
        // MLX speaks the OpenAI wire (mlx_lm.server exposes
        // /v1/chat/completions). Modern mlx_lm.server parses tool calls for
        // models with a tool template (Qwen3, Llama-3.1) and returns proper
        // OpenAI `tool_calls`, so tools are on; its server still omits the
        // usage block, so that flag stays off.
        wire: WireFormat::OpenAi(OpenAiConfig {
            chat_url: "http://127.0.0.1:8080/v1/chat/completions",
            models_url: "http://127.0.0.1:8080/v1/models",
            include_tools: true,
            include_usage_in_stream: false,
            supports_reasoning_effort: false,
            include_cost_accounting: false,
            send_attribution: false,
        }),
        key: KeySource::Local,
        // mlx_lm.server's /v1/models is expensive/noisy and can interfere
        // with prompt processing. Klide treats MLX model selection as
        // an explicit configured value instead of polling the server.
        models: ModelsHandler::StaticPresets(MLX_MODEL_PRESETS),
        subscription: None,
        context_window: Some(128_000),
    },
    // LM Studio is a one-row affair now. Previously it would have meant
    // adding to four match statements + the frontend's PROVIDER_GROUPS
    // + the local-provider predicate. The wire is OpenAI; everything else
    // is inherited.
    ProviderEntry {
        id: "lmstudio",
        wire: WireFormat::OpenAi(OpenAiConfig {
            chat_url: "http://127.0.0.1:1234/v1/chat/completions",
            models_url: "http://127.0.0.1:1234/v1/models",
            include_tools: true,
            // LM Studio rejects `stream_options` — leave it off so local
            // model users don't get 400s on first request.
            include_usage_in_stream: false,
            supports_reasoning_effort: false,
            include_cost_accounting: false,
            send_attribution: false,
        }),
        key: KeySource::Local,
        models: ModelsHandler::OpenAiModels,
        subscription: None,
        context_window: None,
    },
    // ── Hosted APIs: key required ──────────────────────────────────────
    ProviderEntry {
        id: "anthropic",
        wire: WireFormat::Anthropic,
        key: KeySource::Hosted {
            env: Some("ANTHROPIC_API_KEY"),
            env_legacy: None,
        },
        models: ModelsHandler::AnthropicModels,
        subscription: None,
        context_window: None,
    },
    ProviderEntry {
        id: "openai",
        wire: WireFormat::OpenAi(OpenAiConfig {
            chat_url: "https://api.openai.com/v1/chat/completions",
            models_url: "https://api.openai.com/v1/models",
            include_tools: true,
            include_usage_in_stream: true,
            supports_reasoning_effort: true,
            include_cost_accounting: false,
            send_attribution: false,
        }),
        key: KeySource::Hosted {
            env: Some("OPENAI_API_KEY"),
            env_legacy: None,
        },
        models: ModelsHandler::OpenAiModels,
        subscription: None,
        context_window: None,
    },
    ProviderEntry {
        id: "mistral",
        // Mistral rides the OpenAI wire — was implicit before (it was
        // just "the openai-compatible fallback"). Now it's the explicit
        // wire format on this row, and a comment so the next reader
        // doesn't go looking for a mistral_chat function.
        wire: WireFormat::OpenAi(OpenAiConfig {
            chat_url: "https://api.mistral.ai/v1/chat/completions",
            models_url: "https://api.mistral.ai/v1/models",
            include_tools: true,
            // Mistral sends a usage block on the final chunk even
            // without `stream_options.include_usage`; asking for it is
            // harmless but unnecessary.
            include_usage_in_stream: false,
            supports_reasoning_effort: false,
            include_cost_accounting: false,
            send_attribution: false,
        }),
        key: KeySource::Hosted {
            env: Some("MISTRAL_API_KEY"),
            env_legacy: None,
        },
        models: ModelsHandler::OpenAiModels,
        subscription: None,
        context_window: None,
    },
    ProviderEntry {
        id: "xai",
        wire: WireFormat::OpenAi(OpenAiConfig {
            chat_url: "https://api.x.ai/v1/chat/completions",
            models_url: "https://api.x.ai/v1/models",
            include_tools: true,
            include_usage_in_stream: true,
            supports_reasoning_effort: false,
            include_cost_accounting: false,
            send_attribution: false,
        }),
        key: KeySource::Hosted {
            env: Some("XAI_API_KEY"),
            // Legacy alias — older setups used GROK_API_KEY.
            env_legacy: Some("GROK_API_KEY"),
        },
        models: ModelsHandler::OpenAiModels,
        subscription: None,
        context_window: None,
    },
    ProviderEntry {
        id: "deepseek",
        // DeepSeek's platform is OpenAI-wire (`/v1/chat/completions`, function
        // calling, `stream_options.include_usage`). `deepseek-reasoner` streams
        // its chain-of-thought in `reasoning_content`, which the shared OpenAI
        // adapter already routes to the thinking channel — no per-provider code.
        wire: WireFormat::OpenAi(OpenAiConfig {
            chat_url: "https://api.deepseek.com/v1/chat/completions",
            models_url: "https://api.deepseek.com/v1/models",
            include_tools: true,
            include_usage_in_stream: true,
            // The reasoner decides its own thinking budget; DeepSeek exposes no
            // `reasoning_effort` knob, so Klide never sends one.
            supports_reasoning_effort: false,
            include_cost_accounting: false,
            send_attribution: false,
        }),
        key: KeySource::Hosted {
            env: Some("DEEPSEEK_API_KEY"),
            env_legacy: None,
        },
        models: ModelsHandler::OpenAiModels,
        subscription: None,
        context_window: None,
    },
    ProviderEntry {
        id: "openrouter",
        wire: WireFormat::OpenAi(OpenAiConfig {
            chat_url: "https://openrouter.ai/api/v1/chat/completions",
            models_url: "https://openrouter.ai/api/v1/models",
            include_tools: true,
            // `include_cost_accounting` below already sets
            // `stream_options.include_usage`, so the generic flag stays off.
            include_usage_in_stream: false,
            supports_reasoning_effort: true,
            // OpenRouter only returns the real charged cost when usage
            // accounting is requested; and it surfaces app-attribution headers.
            include_cost_accounting: true,
            send_attribution: true,
        }),
        key: KeySource::Hosted {
            env: Some("OPENROUTER_API_KEY"),
            env_legacy: None,
        },
        models: ModelsHandler::OpenAiModels,
        subscription: None,
        context_window: None,
    },
    // ── Subscription CLIs: PTY / stdio delegates ──────────────────────
    //
    // `wire` is a placeholder; the subscription branch in `ai_chat`
    // returns before the wire match is reached. Subscription is the
    // only field that matters for these rows.
    ProviderEntry {
        id: "claude-code",
        wire: WireFormat::Ollama, // placeholder, never reached
        key: KeySource::Local,
        models: ModelsHandler::Subscription,
        subscription: Some(SubscriptionSpec {
            cmd: "claude",
            label: "Claude Code",
            default_models: &["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
            cached_models: crate::models::claude_cached_models,
        }),
        context_window: Some(200_000),
    },
    ProviderEntry {
        id: "codex",
        wire: WireFormat::Ollama, // placeholder, never reached
        key: KeySource::Local,
        models: ModelsHandler::Subscription,
        subscription: Some(SubscriptionSpec {
            cmd: "codex",
            label: "Codex",
            default_models: &["gpt-5", "gpt-5-mini", "gpt-5-nano", "o3", "o4-mini"],
            cached_models: crate::models::codex_cached_models,
        }),
        context_window: Some(272_000),
    },
    ProviderEntry {
        id: "opencode",
        wire: WireFormat::Ollama, // placeholder, never reached
        key: KeySource::Local,
        models: ModelsHandler::Subscription,
        subscription: Some(SubscriptionSpec {
            cmd: "opencode",
            label: "OpenCode",
            default_models: &["opencode"],
            cached_models: crate::models::opencode_cached_models,
        }),
        context_window: None,
    },
    // Oh My Pi routes to 40+ providers itself; keys come from the user's
    // shell environment, so "installed" is the whole auth story (OpenCode's
    // posture). Models come from its on-disk cache (`~/.omp/agent/models.db`),
    // with a fuzzy-matchable fallback list — omp resolves "claude-sonnet-4-6"
    // and "openai/gpt-5.2" alike.
    ProviderEntry {
        id: "omp",
        wire: WireFormat::Ollama, // placeholder, never reached
        key: KeySource::Local,
        models: ModelsHandler::Subscription,
        subscription: Some(SubscriptionSpec {
            cmd: "omp",
            label: "Oh My Pi",
            default_models: &[
                "claude-sonnet-4-6",
                "claude-opus-4-6",
                "gpt-5",
                "gpt-5-mini",
            ],
            cached_models: crate::models::omp_cached_models,
        }),
        context_window: None,
    },
];

/// Look up a provider by id. O(n) over a 10–20 row registry — the
/// simplicity is worth more than the few nanoseconds a `phf::Map` would
/// save. (If we ever cross 50 providers, swap in `phf`.)
pub fn lookup(id: &str) -> Option<&'static ProviderEntry> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// True for subscription CLI providers. The dispatch in `ai_chat` and
/// `ai_provider_models` checks this first; subscription rows don't need
/// a usable `wire` or `models` handler.
pub fn is_subscription(id: &str) -> bool {
    lookup(id)
        .map(|p| p.subscription.is_some())
        .unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub has_key: bool,
    /// "keychain" | "env" | "none"
    pub source: String,
}

/// Where the provider's env-var fallback lives. Returns None for local
/// providers, None when no env var is declared on a hosted entry, and
/// the env-var name otherwise. Used by `env_fallback` below.
fn env_fallback_names(entry: &ProviderEntry) -> (Option<&'static str>, Option<&'static str>) {
    match entry.key {
        KeySource::Hosted { env, env_legacy } => (env, env_legacy),
        KeySource::Local => (None, None),
    }
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Read the API key, in priority order: keychain → declared env →
/// legacy env. Returns Ok(None) for local providers (no key needed),
/// Ok(Some(key)) when one is found, Err when a hosted provider has
/// no key anywhere.
pub fn provider_key(id: &str) -> Result<Option<String>, String> {
    provider_key_in(id, None)
}

/// `provider_key`, but resolving `${VAR}` references against `scope`'s
/// `.env` before the folder the window has open. A Harness turn passes its
/// own run's workspace root, so a run in flight keeps reading its keys even
/// when the UI's active workspace is gone — closing the folder, switching
/// projects, or a plain window reload (which starts at "no folder open"
/// until the boot restore lands) would otherwise make a perfectly good
/// `.env` unreadable mid-run.
pub fn provider_key_in(
    id: &str,
    scope: Option<&std::path::Path>,
) -> Result<Option<String>, String> {
    let entry = lookup(id).ok_or_else(|| format!("Provider \"{id}\" is not wired yet"))?;
    match entry.key {
        KeySource::Local => Ok(None),
        KeySource::Hosted { .. } => {
            // Env-reference method (keychain-free) wins when configured — the
            // same mechanism self-hosted endpoints use, so a built-in key can
            // live in `.env` as `${OPENAI_API_KEY}` and never pop a keychain
            // prompt. Reading it must NOT touch the keychain.
            if let Some(reference) = builtin_token_reference(id) {
                return match resolve_reference(&reference, scope) {
                    Some(key) => Ok(Some(key)),
                    None => Err(format!(
                        "Env reference {reference} for {id} did not resolve — checked {}",
                        reference_search_summary(scope)
                    )),
                };
            }
            // Only read the Keychain when the user actually pasted a key here
            // (recorded by a marker on save). No marker → don't even look, so
            // we never pop the macOS prompt for a provider that's configured
            // via .env / a process env var / nothing yet. This is what keeps
            // browsing or model-listing a provider from triggering a prompt.
            let keychain = if has_keychain_marker(id) {
                cached_keyring_lookup(id)
            } else {
                None
            };
            let (env, env_legacy) = env_fallback_names(entry);
            let from_env = env
                .and_then(env_var)
                .or_else(|| env_legacy.and_then(env_var));
            match keychain.or(from_env) {
                Some(key) => Ok(Some(key)),
                None => Err(format!("No API key saved for {id}")),
            }
        }
    }
}

/// Public version of the key status — used by `ai_provider_key_status`
/// to report where the key came from without revealing the value.
pub fn key_status(id: &str) -> Result<ProviderKeyStatus, String> {
    let Some(entry) = lookup(id) else {
        // Custom (self-hosted) provider — not in the static registry. These
        // never use the keychain: their token comes from a `${VAR}` reference
        // or the `KLIDE_TOKEN_<SLUG>` env var, so the status never triggers a
        // keychain prompt.
        if let Some(reference) = custom_token_reference(id) {
            // `has_key` reflects whether the reference actually resolves, so
            // the UI can warn about a `${VAR}` with no matching `.env` entry.
            return Ok(ProviderKeyStatus {
                has_key: resolve_reference(&reference, None).is_some(),
                source: "reference".to_string(),
            });
        }
        if env_var(&custom_env_var_name(id)).is_some() {
            return Ok(ProviderKeyStatus {
                has_key: true,
                source: "env".to_string(),
            });
        }
        return Ok(ProviderKeyStatus {
            has_key: false,
            source: "none".to_string(),
        });
    };
    if let KeySource::Local = entry.key {
        return Ok(ProviderKeyStatus {
            has_key: false,
            source: "none".to_string(),
        });
    }
    // Reference method first — checking it before the keychain keeps the
    // status read keychain-prompt-free when the user opted for `.env`.
    if let Some(reference) = builtin_token_reference(id) {
        return Ok(ProviderKeyStatus {
            has_key: resolve_reference(&reference, None).is_some(),
            source: "reference".to_string(),
        });
    }
    // Marker check — NOT a Keychain read, so rendering the status never pops
    // the macOS access prompt. The secret itself is only touched at send time.
    if has_keychain_marker(id) {
        return Ok(ProviderKeyStatus {
            has_key: true,
            source: "keychain".to_string(),
        });
    }
    let (env, env_legacy) = env_fallback_names(entry);
    if env.and_then(env_var).is_some() || env_legacy.and_then(env_var).is_some() {
        return Ok(ProviderKeyStatus {
            has_key: true,
            source: "env".to_string(),
        });
    }
    Ok(ProviderKeyStatus {
        has_key: false,
        source: "none".to_string(),
    })
}

// ── Keychain plumbing (kept here so the registry is self-contained) ──

const KEYCHAIN_SERVICE: &str = "com.klide.app";

// Resolved-token cache, keyed by provider id. The keychain `get_password`
// call is what triggers macOS's "allow access" prompt, and `ai_chat` reads
// the token on every request — so we read each provider's keychain entry at
// most once per app launch and serve the rest from memory. `None` (no entry)
// is cached too, so a tokenless local endpoint doesn't re-prompt either.
// Invalidated whenever the entry is written or cleared. In-memory only —
// never persisted, never crosses into the webview.
static TOKEN_CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// The currently-open workspace root, so `${VAR}` token references can resolve
// from the project's own `.env`. Set by the frontend (`set_active_workspace`)
// whenever the open folder changes. `None` before any folder is opened.
static ACTIVE_WORKSPACE: LazyLock<Mutex<Option<std::path::PathBuf>>> =
    LazyLock::new(|| Mutex::new(None));

/// Record the open workspace root. `None`/empty clears it (no folder open).
pub fn set_active_workspace(root: Option<String>) {
    let next = root
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .map(std::path::PathBuf::from);
    *ACTIVE_WORKSPACE.lock().unwrap() = next;
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(|e| e.to_string())
}

fn keyring_lookup(provider: &str) -> Option<String> {
    keyring_entry(provider)
        .ok()?
        .get_password()
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Keychain read, memoised for the process lifetime (see `TOKEN_CACHE`).
fn cached_keyring_lookup(provider: &str) -> Option<String> {
    if let Some(hit) = TOKEN_CACHE.lock().unwrap().get(provider) {
        return hit.clone();
    }
    let value = keyring_lookup(provider);
    TOKEN_CACHE
        .lock()
        .unwrap()
        .insert(provider.to_string(), value.clone());
    value
}

/// Drop a provider's cached token so the next read re-hits the keychain.
fn invalidate_token_cache(provider: &str) {
    TOKEN_CACHE.lock().unwrap().remove(provider);
}

/// Env-var name holding a custom provider's bearer token:
/// `KLIDE_TOKEN_<SLUG>`, where SLUG is the id minus the `custom:` prefix,
/// uppercased, with each run of non-alphanumerics collapsed to one `_`.
/// So `custom:ontraak-prod` → `KLIDE_TOKEN_ONTRAAK_PROD`. Lets a token be
/// supplied without ever touching the keychain (handy in dev, where every
/// rebuild re-prompts for keychain access).
fn custom_env_var_name(id: &str) -> String {
    let slug = id
        .strip_prefix(crate::custom_providers::CUSTOM_ID_PREFIX)
        .unwrap_or(id);
    let mut out = String::from("KLIDE_TOKEN_");
    let mut pending_sep = false;
    for ch in slug.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_sep {
                out.push('_');
                pending_sep = false;
            }
            out.push(ch.to_ascii_uppercase());
        } else {
            pending_sep = !out.ends_with('_');
        }
    }
    out
}

/// Extract the variable name from a `${VAR}` / `$VAR` reference. Returns
/// `None` for anything that isn't a reference (e.g. a literal token), so a
/// caller can tell "this is a reference" from "this is a raw value".
fn reference_var_name(reference: &str) -> Option<&str> {
    let r = reference.trim();
    let inner = r
        .strip_prefix("${")
        .and_then(|s| s.strip_suffix('}'))
        .or_else(|| r.strip_prefix('$'))?;
    let name = inner.trim();
    (!name.is_empty()).then_some(name)
}

/// Read one key out of a `.env` file. A tiny `KEY=VALUE` parser — enough for
/// the dotenv convention (blank lines, `#` comments, optional `export` prefix,
/// surrounding quotes) without pulling in a crate.
fn dotenv_lookup_in(path: &std::path::Path, name: &str) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != name {
            continue;
        }
        let value = value.trim();
        // Strip one layer of matching surrounding quotes.
        let value = value
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
            .unwrap_or(value)
            .trim();
        return (!value.is_empty()).then(|| value.to_string());
    }
    None
}

/// Resolve `name` from a `.env`: the open project's `.env` first (so each
/// project supplies its own tokens), then `~/.klide/.env` as a global
/// fallback. The files are the user's own, gitignorable secret stores;
/// Klide only reads them.
fn dotenv_lookup(name: &str, scope: Option<&std::path::Path>) -> Option<String> {
    dotenv_roots(scope)
        .into_iter()
        .find_map(|root| dotenv_lookup_in(&root.join(".env"), name))
}

/// The directories whose `.env` a reference resolves from, most specific
/// first: the caller's own scope (a run's workspace), then the folder open
/// in the window, then `~/.klide` as the global store. Duplicates are
/// dropped so the same file is never read twice.
fn dotenv_roots(scope: Option<&std::path::Path>) -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    let mut push = |root: Option<std::path::PathBuf>| {
        if let Some(root) = root {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    };
    push(scope.map(|p| p.to_path_buf()));
    push(ACTIVE_WORKSPACE.lock().unwrap().clone());
    push(crate::cli::home_dir_path().map(|home| home.join(".klide")));
    roots
}

/// Human-readable list of everywhere a reference was looked for, so a
/// "did not resolve" error names the files to go check instead of saying
/// "check your .env" when no project was open to hold one.
fn reference_search_summary(scope: Option<&std::path::Path>) -> String {
    let files: Vec<String> = dotenv_roots(scope)
        .iter()
        .map(|root| root.join(".env").display().to_string())
        .collect();
    if files.is_empty() {
        "the process env (no project open, no home directory)".to_string()
    } else {
        format!("the process env, {}", files.join(", "))
    }
}

/// Resolve a `${VAR}` reference: process environment first, then a `.env`
/// file (project, then global). No path touches the keychain, so no prompt.
fn resolve_reference(reference: &str, scope: Option<&std::path::Path>) -> Option<String> {
    let name = reference_var_name(reference)?;
    env_var(name).or_else(|| dotenv_lookup(name, scope))
}

/// Resolve a custom (self-hosted) provider's token. Order:
/// 1. a `${VAR}` reference on the provider → env / project `.env` / `~/.klide/.env`,
/// 2. the `KLIDE_TOKEN_<SLUG>` convention env var.
/// Self-hosted endpoints never touch the keychain — their tokens live in the
/// environment or a `.env`, so reading one never pops a macOS prompt. The
/// token is optional (a no-auth local endpoint has none), so this returns
/// `Option`, not `Result`. `id` is a raw `custom:` id, not in the static
/// registry.
pub fn custom_token(id: &str, scope: Option<&std::path::Path>) -> Option<String> {
    if let Some(reference) = custom_token_reference(id) {
        return resolve_reference(&reference, scope);
    }
    env_var(&custom_env_var_name(id))
}

/// The `${VAR}` reference configured for a custom provider, if any.
fn custom_token_reference(id: &str) -> Option<String> {
    crate::custom_providers::get(id).and_then(|p| p.token_ref)
}

// ── Built-in provider env-references (the keychain-free "second method") ──
// A built-in hosted provider (Anthropic, OpenAI, …) can take its key by one
// of two methods: the classic pasted key (keychain), or — exactly like a
// self-hosted endpoint — a `${VAR}` reference resolved from the env / project
// `.env` / `~/.klide/.env`. The reference itself (never a literal key) is
// stored in plaintext at `~/.klide/provider_refs.json`, keyed by provider id.

fn provider_refs_path() -> Option<std::path::PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide").join("provider_refs.json"))
}

fn read_provider_refs() -> std::collections::HashMap<String, String> {
    let Some(path) = provider_refs_path() else {
        return std::collections::HashMap::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return std::collections::HashMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// The `${VAR}` reference configured for a built-in hosted provider, if any.
fn builtin_token_reference(id: &str) -> Option<String> {
    read_provider_refs().remove(id)
}

// ── Keychain presence markers ────────────────────────────────────────────
// Reading a Keychain entry (`get_password`) is what pops the macOS "allow
// access" prompt — and in dev every rebuild re-prompts. We don't want the
// status pill ("Saved") to cost a prompt, so whenever a key is written/cleared
// through the app we record *just the provider id* (never the secret) in
// `~/.klide/keychain_providers.json`. `key_status` reads that marker instead of
// the Keychain, so opening Settings never prompts. The real secret is still
// only read at send time, in `provider_key`.

fn keychain_markers_path() -> Option<std::path::PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide").join("keychain_providers.json"))
}

fn read_keychain_markers() -> std::collections::HashSet<String> {
    let Some(path) = keychain_markers_path() else {
        return std::collections::HashSet::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return std::collections::HashSet::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn has_keychain_marker(id: &str) -> bool {
    read_keychain_markers().contains(id)
}

/// Record (or remove) a provider's "has a pasted key" marker. Best-effort:
/// a write failure must never block saving the actual key.
fn mark_keychain(id: &str, present: bool) {
    let mut set = read_keychain_markers();
    let changed = if present {
        set.insert(id.to_string())
    } else {
        set.remove(id)
    };
    if !changed {
        return;
    }
    let Some(path) = keychain_markers_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(&set) {
        // Same store as the credentials it describes — same file mode. The
        // marker only carries provider ids, but a 0600 store shouldn't sit
        // next to a 0644 index of it.
        let _ = crate::durable::write_atomic_private(&path, &json);
    }
}

/// Set (or clear, with `None`/empty) a built-in provider's env reference.
/// Only genuine `${VAR}` / `$VAR` references are accepted, so a pasted literal
/// key can never end up sitting in this plaintext file by mistake — that path
/// belongs to the keychain. Clearing reverts the provider to the keychain
/// method.
pub fn set_provider_reference(id: &str, reference: Option<&str>) -> Result<(), String> {
    let mut refs = read_provider_refs();
    match reference.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => {
            if reference_var_name(r).is_none() {
                return Err(
                    "Expected an env reference like ${OPENAI_API_KEY}, not a literal key"
                        .to_string(),
                );
            }
            refs.insert(id.to_string(), r.to_string());
        }
        None => {
            refs.remove(id);
        }
    }
    let path =
        provider_refs_path().ok_or_else(|| "Could not resolve home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&refs).map_err(|e| e.to_string())?;
    // Atomic + 0600: the file only ever holds `${VAR}` references (literals are
    // rejected above), but it names the user's secret sources — private mode,
    // same as every other store under `~/.klide`.
    crate::durable::write_atomic_private(&path, &json)
        .map_err(|e| format!("Could not write {path:?}: {e}"))?;
    invalidate_token_cache(id);
    Ok(())
}

/// Set or clear the keychain entry for a provider. `set` writes (after
/// rejecting empty values); `clear` deletes. Both invalidate the in-memory
/// token cache so the change takes effect on the next read.
pub fn set_keychain_key(provider: &str, key: &str) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key is empty".to_string());
    }
    keyring_entry(provider)?
        .set_password(trimmed)
        .map_err(|e| e.to_string())?;
    mark_keychain(provider, true);
    invalidate_token_cache(provider);
    Ok(())
}

pub fn clear_keychain_key(provider: &str) -> Result<(), String> {
    let result = match keyring_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    mark_keychain(provider, false);
    invalidate_token_cache(provider);
    result
}

// ── Provider wire vocabulary + dispatch ────────────────────────────────
// The types every adapter speaks and the one entry point that routes a
// chat turn: custom (self-hosted) providers first, then subscription CLIs,
// then the per-wire streaming adapters. Moved out of lib.rs so the crate
// root stays thin Tauri glue and the routing is a testable plan.

pub(crate) const OLLAMA_URL: &str = "http://localhost:11434";
/// The Ollama model Klide reaches for first (mirrors the frontend catalog's
/// `defaultModel` for `ollama`). Auto routing leads the local tier with it.
pub(crate) const OLLAMA_DEFAULT_MODEL: &str = "llama3.1:8b";
pub(crate) const MLX_DEFAULT_MODEL: &str = "mlx-community/Llama-3.1-8B-Instruct-4bit";
pub(crate) const MLX_MODEL_PRESETS: &[&str] = &[
    MLX_DEFAULT_MODEL,
    "Qwen/Qwen3-4B-MLX-4bit",
    "mlx-community/gemma-2-9b-it-4bit",
    "mlx-community/gemma-4-E4B-it-qat-4bit",
    "mlx-community/gemma-4-12B-it-qat-4bit",
];

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
    pub(crate) fn is_empty(&self) -> bool {
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
#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamChunk {
    pub(crate) content: String,
    pub(crate) thinking: String,
    /// Tool work the *provider itself* performed and reported, rather than
    /// asked Klide to perform. Only the structured delegate-CLI path fills
    /// this; every wire adapter leaves it `None`, because a wire model asks for
    /// tools through `tool_calls` and Klide runs them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) observed: Option<ObservedToolActivity>,
}

impl StreamChunk {
    /// A plain text delta — the shape every wire adapter sends.
    pub(crate) fn text(content: impl Into<String>) -> Self {
        StreamChunk {
            content: content.into(),
            ..Default::default()
        }
    }
}

/// One piece of tool work a delegate CLI did on its own initiative, lifted out
/// of its structured output stream so the conversation can show it.
///
/// This is deliberately *not* modelled as a Klide tool call. Klide neither
/// chose nor gated these: they ran under the CLI's own permission mode, with no
/// capability, no permission prompt and no diff review behind them. Keeping
/// them a separate shape all the way to the UI is what stops a reader — human
/// or `summarize_validation` — from counting a delegate's `Bash` as a command
/// Klide verified.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub(crate) enum ObservedToolActivity {
    /// The CLI invoked a tool of its own. Carries its own `provider` and
    /// `summary` so the harness can forward the event without having to know
    /// anything about delegate tool vocabularies.
    Call {
        id: String,
        provider: String,
        name: String,
        input: serde_json::Value,
        summary: String,
    },
    /// …and this is what it got back.
    Result { id: String, ok: bool, content: String },
}

// Anthropic requires this header on every Messages API call; pinning a known
// version keeps the request/response shape stable as the API evolves.
pub(crate) const ANTHROPIC_VERSION: &str = "2023-06-01";

pub(crate) fn is_subscription_provider(provider: &str) -> bool {
    is_subscription(provider) || crate::custom_cli::get(provider).is_some()
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
        520..=523 => {
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

pub(crate) fn text_from_message(message: &serde_json::Value) -> String {
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

/// One provider chat turn, as the harness and the `ai_chat` command hand it
/// over. The stream channel rides separately so this stays a plain value.
pub(crate) struct ProviderTurn {
    pub provider: String,
    pub model: String,
    pub messages: Vec<serde_json::Value>,
    pub tools: Option<Vec<serde_json::Value>>,
    pub workspace_root: Option<String>,
    /// The Harness run this turn belongs to, when it has one. Only the
    /// subscription-CLI path reads it: a delegate keeps a session of its own
    /// per conversation, and the run id is what identifies the conversation.
    pub run_id: Option<String>,
    /// Commands this project has already approved in Klide. Only the
    /// subscription-CLI path reads them: a delegate runs its own permission
    /// layer, and a headless turn has no terminal to answer it in.
    pub allowed_commands: Vec<String>,
    /// Klide's MCP server for this conversation, when the Harness registered
    /// the Delegate as a coordination Run. Only the subscription-CLI path
    /// reads it; every other provider gets Klide's native Tools instead.
    pub mcp: Option<crate::delegate::McpWiring>,
    pub num_ctx: Option<usize>,
    pub num_predict: Option<usize>,
    pub reflection_level: Option<String>,
}

/// Where a turn routes, decided before any network call — the pure half of
/// `dispatch`, so precedence (custom store fallthrough, subscription CLIs
/// before the wire match) and per-wire flags are testable.
#[derive(Debug)]
pub(crate) enum DispatchPlan {
    /// Self-hosted OpenAI-wire endpoint from the custom store.
    CustomProvider { id: String, chat_url: String },
    /// A delegate CLI on a subscription; never reaches the wire match.
    SubscriptionCli { provider_id: &'static str, label: &'static str },
    Ollama,
    Anthropic,
    OpenAiWire { provider_id: &'static str, cfg: OpenAiConfig },
}

pub(crate) fn plan_dispatch(provider: &str) -> Result<DispatchPlan, String> {
    // Built-in providers resolve through the static registry. A miss falls
    // through to the custom (self-hosted) store — those ids (prefixed
    // `custom:`) can't live in the `const` registry because their URLs are
    // typed in at runtime.
    let Some(entry) = lookup(provider) else {
        let cp = crate::custom_providers::get(provider)
            .ok_or_else(|| format!("Provider \"{provider}\" is not wired yet"))?;
        return Ok(DispatchPlan::CustomProvider {
            id: cp.id.clone(),
            chat_url: cp.chat_url(),
        });
    };
    // Subscription CLIs route first — the `wire` field on subscription rows
    // is a placeholder that's never reached.
    if let Some(spec) = entry.subscription {
        return Ok(DispatchPlan::SubscriptionCli {
            provider_id: entry.id,
            label: spec.label,
        });
    }
    Ok(match entry.wire {
        WireFormat::Ollama => DispatchPlan::Ollama,
        WireFormat::Anthropic => DispatchPlan::Anthropic,
        WireFormat::OpenAi(cfg) => DispatchPlan::OpenAiWire {
            provider_id: entry.id,
            cfg,
        },
    })
}

/// Route one chat turn to its adapter. The seam the Harness's real
/// `AgentProviderCaller` calls — no `#[tauri::command]` indirection.
pub(crate) async fn dispatch(
    turn: ProviderTurn,
    on_chunk: &tauri::ipc::Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let ProviderTurn {
        provider,
        model,
        messages,
        tools,
        workspace_root,
        run_id,
        allowed_commands,
        mcp,
        num_ctx,
        num_predict,
        reflection_level,
    } = turn;
    // Keys resolve against *this turn's* workspace, not whatever folder the
    // window has open — a run must not lose its `.env` because the UI moved
    // on (closed the folder, switched projects, reloaded).
    let key_scope = workspace_root.as_deref().map(std::path::PathBuf::from);
    match plan_dispatch(&provider)? {
        DispatchPlan::CustomProvider { id, chat_url } => {
            // Custom providers always speak the OpenAI wire. The token is
            // optional (a no-auth local endpoint has none); tools are sent
            // and stream usage is left off, matching the safe local-proxy
            // posture (LM Studio rejects `stream_options`).
            crate::adapters::openai_compatible_chat(
                id.clone(),
                chat_url,
                true,
                false,
                false,
                false,
                custom_token(&id, key_scope.as_deref()),
                None,
                model,
                messages,
                tools,
                on_chunk,
            )
            .await
        }
        DispatchPlan::SubscriptionCli { provider_id, label } => {
            let adapter = crate::delegate::lookup(provider_id)
                .ok_or_else(|| format!("\"{provider_id}\" has no delegate adapter"))?;
            crate::delegate::run_subscription_chat(
                adapter,
                label,
                model,
                messages,
                workspace_root,
                run_id,
                allowed_commands,
                mcp,
                on_chunk,
            )
            .await
        }
        DispatchPlan::Ollama => {
            crate::adapters::ollama_chat(
                model,
                messages,
                tools,
                num_ctx,
                num_predict,
                reflection_level,
                on_chunk,
            )
            .await
        }
        DispatchPlan::Anthropic => {
            let key = provider_key_in("anthropic", key_scope.as_deref())?
                .ok_or_else(|| "Missing API key".to_string())?;
            crate::adapters::anthropic_chat(
                key,
                model,
                messages,
                tools,
                reflection_level,
                on_chunk,
            )
            .await
        }
        DispatchPlan::OpenAiWire { provider_id, cfg } => {
            // Hosted providers require a key (`provider_key` errors when
            // missing); local OpenAI-wire ones (MLX, LM Studio) return
            // Ok(None) and send no auth header.
            let key = provider_key_in(provider_id, key_scope.as_deref())?;
            crate::adapters::openai_compatible_chat(
                provider_id.to_string(),
                cfg.chat_url.to_string(),
                cfg.include_tools,
                cfg.include_usage_in_stream,
                cfg.include_cost_accounting,
                cfg.send_attribution,
                key,
                if cfg.supports_reasoning_effort {
                    crate::adapters::reflection_level_to_openai_effort(reflection_level.as_deref())
                } else {
                    None
                },
                model,
                messages,
                tools,
                on_chunk,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    //! Pin the registry contract. These are the regressions that would
    //! have caught every bug the audit flagged:
    //!
    //! - Adding a provider is a single row, not a hunt.
    //! - Mistral-rides-OpenAI is testable (not just inferred from
    //!   "openai-compatible fallback").
    //! - Local providers don't get phantom keys.
    //! - Subscription CLIs are a closed set.

    use super::*;

    #[test]
    fn dispatch_plan_routes_subscription_clis_before_the_wire_match() {
        // A subscription row's `wire` is a placeholder — the plan must pick
        // the CLI route first or a placeholder wire would be dialed.
        match plan_dispatch("claude-code").expect("claude-code is registered") {
            DispatchPlan::SubscriptionCli { provider_id, .. } => {
                assert_eq!(provider_id, "claude-code")
            }
            other => panic!("expected SubscriptionCli, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_plan_routes_each_wire_to_its_adapter() {
        assert!(matches!(
            plan_dispatch("ollama").unwrap(),
            DispatchPlan::Ollama
        ));
        assert!(matches!(
            plan_dispatch("anthropic").unwrap(),
            DispatchPlan::Anthropic
        ));
        match plan_dispatch("openrouter").unwrap() {
            DispatchPlan::OpenAiWire { provider_id, cfg } => {
                assert_eq!(provider_id, "openrouter");
                // OpenRouter reports real billed cost; the flag rides the plan.
                assert!(cfg.include_cost_accounting);
            }
            other => panic!("expected OpenAiWire, got {other:?}"),
        }
        match plan_dispatch("mlx").unwrap() {
            // MLX is local OpenAI-wire: no stream usage, tools off per its cfg.
            DispatchPlan::OpenAiWire { cfg, .. } => {
                assert!(!cfg.include_usage_in_stream);
            }
            other => panic!("expected OpenAiWire, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_plan_rejects_unknown_providers() {
        let err = plan_dispatch("definitely-not-wired").unwrap_err();
        assert!(err.contains("not wired"), "got: {err}");
    }

    #[test]
    fn lookup_finds_every_provider_we_advertise() {
        // Mirrors the frontend's ProviderId union. If you add a row
        // to PROVIDERS, add it here too — this test fails closed.
        let known = [
            "ollama",
            "mlx",
            "lmstudio",
            "anthropic",
            "openai",
            "mistral",
            "xai",
            "deepseek",
            "openrouter",
            "claude-code",
            "codex",
            "opencode",
            "omp",
        ];
        for id in known {
            assert!(lookup(id).is_some(), "missing registry row for {id}");
        }
    }

    #[test]
    fn lookup_returns_none_for_unknown_ids() {
        assert!(lookup("not-a-provider").is_none());
        assert!(lookup("").is_none());
    }

    #[test]
    fn registry_ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for entry in PROVIDERS {
            assert!(seen.insert(entry.id), "duplicate registry id: {}", entry.id);
        }
    }

    #[test]
    fn mistral_rides_the_openai_wire_explicitly() {
        // This is the bug the old code hid: Mistral was implicit
        // "the openai-compatible fallback". Now it's a registry fact.
        let entry = lookup("mistral").expect("mistral is registered");
        match entry.wire {
            WireFormat::OpenAi(cfg) => {
                assert_eq!(cfg.chat_url, "https://api.mistral.ai/v1/chat/completions");
                assert!(cfg.include_tools);
            }
            other => panic!("mistral must be OpenAI-wire, got {other:?}"),
        }
    }

    #[test]
    fn xai_and_openrouter_and_lmstudio_also_ride_openai() {
        // All three of these used to require edits in 4+ match
        // statements. Now they're rows — same shape, different urls.
        for id in ["xai", "openrouter", "lmstudio", "deepseek"] {
            let entry = lookup(id).expect(id);
            assert!(
                matches!(entry.wire, WireFormat::OpenAi(_)),
                "{id} should be OpenAI-wire, got {:?}",
                entry.wire
            );
        }
    }

    #[test]
    fn deepseek_is_openai_wire_without_a_reasoning_effort_knob() {
        // DeepSeek's platform is OpenAI-wire, so it lands as a row — but its
        // reasoner picks its own thinking budget. If a future edit flips
        // `supports_reasoning_effort` on, requests would carry a field DeepSeek
        // rejects, so pin it here.
        let entry = lookup("deepseek").expect("deepseek is registered");
        match entry.wire {
            WireFormat::OpenAi(cfg) => {
                assert_eq!(cfg.chat_url, "https://api.deepseek.com/v1/chat/completions");
                assert!(cfg.include_tools, "deepseek supports function calling");
                assert!(!cfg.supports_reasoning_effort);
                assert!(!cfg.include_cost_accounting, "priced from the table");
            }
            other => panic!("deepseek must be OpenAI-wire, got {other:?}"),
        }
        assert!(matches!(entry.models, ModelsHandler::OpenAiModels));
    }

    #[test]
    fn local_providers_have_no_key_source() {
        // ollama, mlx, lmstudio, and the subscription CLIs never
        // ask for a key — the old `provider_key` special-cased this
        // via a 2-arm match; the registry makes it a property.
        for id in [
            "ollama",
            "mlx",
            "lmstudio",
            "claude-code",
            "codex",
            "opencode",
            "omp",
        ] {
            let entry = lookup(id).expect(id);
            assert!(
                matches!(entry.key, KeySource::Local),
                "{id} should be KeySource::Local, got {:?}",
                entry.key
            );
        }
    }

    #[test]
    fn hosted_providers_carry_their_env_var() {
        // Each hosted entry declares its env. Mistral + xAI + the
        // rest no longer have to be remembered in `provider_env_name`.
        let expectations = [
            ("openai", Some("OPENAI_API_KEY"), None),
            ("anthropic", Some("ANTHROPIC_API_KEY"), None),
            ("mistral", Some("MISTRAL_API_KEY"), None),
            ("xai", Some("XAI_API_KEY"), Some("GROK_API_KEY")),
            ("deepseek", Some("DEEPSEEK_API_KEY"), None),
        ];
        for (id, env, env_legacy) in expectations {
            let entry = lookup(id).expect(id);
            match entry.key {
                KeySource::Hosted {
                    env: e,
                    env_legacy: l,
                } => {
                    assert_eq!(e, env, "{id} env mismatch");
                    assert_eq!(l, env_legacy, "{id} env_legacy mismatch");
                }
                other => panic!("{id} should be Hosted, got {other:?}"),
            }
        }
    }

    #[test]
    fn subscription_predicate_matches_known_set() {
        for id in ["claude-code", "codex", "opencode", "omp"] {
            assert!(is_subscription(id), "{id} should be subscription");
            assert!(
                lookup(id).unwrap().subscription.is_some(),
                "{id} missing subscription spec"
            );
        }
        for id in [
            "ollama",
            "mlx",
            "anthropic",
            "openai",
            "mistral",
            "xai",
            "deepseek",
            "openrouter",
            "lmstudio",
        ] {
            assert!(!is_subscription(id), "{id} must not be subscription");
        }
    }

    #[test]
    fn subscription_specs_have_cached_models_fn() {
        // `cached_models` is a fn pointer so it can run in a const
        // context (the entry is in a const slice). Catches a future
        // refactor that tries to inline the cache.
        for entry in PROVIDERS {
            if let Some(spec) = entry.subscription {
                // Calling the fn shouldn't panic — it just returns
                // None when no cache file exists, which is the
                // expected state in tests.
                let _ = (spec.cached_models)();
            }
        }
    }

    #[test]
    fn mlx_uses_static_preset_models_not_the_server() {
        // The old code had an in-line `if provider == "mlx"` carve-out
        // for static presets. It's now a property of the entry.
        let entry = lookup("mlx").expect("mlx");
        assert!(
            matches!(entry.models, ModelsHandler::StaticPresets(_)),
            "mlx models should be static presets, got {:?}",
            entry.models
        );
    }

    #[test]
    fn lmstudio_lands_as_a_row_not_a_hunt() {
        // The whole point of the registry: one row, no edits to
        // 5+1 match statements. This test pins that LM Studio is
        // present and well-formed — if a future refactor accidentally
        // demotes it to "not wired", this catches it.
        let entry = lookup("lmstudio").expect("lmstudio must be in the registry");
        match entry.wire {
            WireFormat::OpenAi(cfg) => {
                assert!(
                    cfg.chat_url.contains("1234"),
                    "LM Studio default port is 1234"
                );
                assert!(
                    !cfg.include_usage_in_stream,
                    "LM Studio rejects stream_options"
                );
            }
            other => panic!("lmstudio must be OpenAI-wire, got {other:?}"),
        }
        assert!(matches!(entry.key, KeySource::Local));
    }

    #[test]
    fn reference_var_name_extracts_the_name() {
        // Both `${VAR}` and `$VAR` forms, whitespace-tolerant.
        assert_eq!(reference_var_name("${DEV_TOKEN}"), Some("DEV_TOKEN"));
        assert_eq!(reference_var_name("$DEV_TOKEN"), Some("DEV_TOKEN"));
        assert_eq!(reference_var_name("  ${ DEV_TOKEN } "), Some("DEV_TOKEN"));
        // A literal token (or empty) is not a reference.
        assert_eq!(reference_var_name("sk-abc123"), None);
        assert_eq!(reference_var_name("$"), None);
        assert_eq!(reference_var_name("${}"), None);
    }

    #[test]
    fn custom_env_var_name_slugifies_the_id() {
        // The env-var name is a user-facing contract — they type it to
        // supply a token without the keychain — so pin the mapping.
        assert_eq!(
            custom_env_var_name("custom:ontraak-prod"),
            "KLIDE_TOKEN_ONTRAAK_PROD"
        );
        assert_eq!(
            custom_env_var_name("custom:my.gateway 2"),
            "KLIDE_TOKEN_MY_GATEWAY_2"
        );
        // No `custom:` prefix is tolerated; trailing separators don't dangle.
        assert_eq!(custom_env_var_name("plain"), "KLIDE_TOKEN_PLAIN");
        assert_eq!(
            custom_env_var_name("custom:trailing-"),
            "KLIDE_TOKEN_TRAILING"
        );
    }

    #[test]
    fn provider_key_for_local_is_none_not_an_error() {
        // ollama / mlx / lmstudio have no key — provider_key returns
        // Ok(None), not Err. The old code had a 2-arm match that did
        // this; the registry makes it a property of the row.
        for id in [
            "ollama",
            "mlx",
            "lmstudio",
            "claude-code",
            "codex",
            "opencode",
            "omp",
        ] {
            let key = provider_key(id).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert!(key.is_none(), "{id} should have no key, got {key:?}");
        }
    }

    #[test]
    fn provider_key_for_unknown_id_is_error() {
        let err = provider_key("nope").unwrap_err();
        assert!(err.contains("not wired"), "got: {err}");
    }

    #[test]
    fn key_status_for_local_is_none() {
        let status = key_status("ollama").expect("ollama is wired");
        assert!(!status.has_key);
        assert_eq!(status.source, "none");
    }

    #[test]
    fn key_status_for_custom_uses_env_var_only() {
        // Self-hosted endpoints never consult the keychain — status comes from
        // the `KLIDE_TOKEN_<SLUG>` env var (or a `${VAR}` reference), so no
        // keychain prompt is ever possible. Use a unique id per test to avoid
        // cross-test bleed under cargo's default parallel runner.
        let id = "custom:unit-test-env-only";
        let env_name = custom_env_var_name(id);
        std::env::remove_var(&env_name);

        let status = key_status(id).expect("custom ids always return a status");
        assert_eq!(status.source, "none");
        assert!(!status.has_key);

        std::env::set_var(&env_name, "test-token");
        let status = key_status(id).expect("custom ids always return a status");
        assert!(status.has_key);
        assert_eq!(status.source, "env");

        std::env::remove_var(&env_name);
    }

    #[test]
    fn custom_token_resolves_from_env_only() {
        // Self-hosted tokens come from the env (or a `${VAR}` reference),
        // never the keychain — so an unset env var yields `None` without any
        // keychain access, and a set one is returned verbatim.
        let id = "custom:unit-test-prefer-env";
        let env_name = custom_env_var_name(id);
        std::env::remove_var(&env_name);

        assert_eq!(custom_token(id, None), None);

        std::env::set_var(&env_name, "env-wins");
        assert_eq!(custom_token(id, None), Some("env-wins".to_string()));

        std::env::remove_var(&env_name);
    }

    #[test]
    fn a_reference_resolves_from_its_scope_with_no_folder_open() {
        // The regression: a key that lives only in the project's `.env` was
        // resolved through the UI-owned active workspace, so a run in flight
        // lost its key the moment the window had no folder open (a close, a
        // project switch, or the boot transient after a reload) and failed
        // with "did not resolve" while the `.env` sat there intact.
        let dir = std::env::temp_dir().join(format!(
            "klide-dotenv-scope-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join(".env"), "KLIDE_SCOPED_TEST_KEY=\"from-project\"\n")
            .expect("write .env");

        assert!(
            ACTIVE_WORKSPACE.lock().unwrap().is_none(),
            "a test process has no folder open"
        );
        assert_eq!(resolve_reference("${KLIDE_SCOPED_TEST_KEY}", None), None);
        assert_eq!(
            resolve_reference("${KLIDE_SCOPED_TEST_KEY}", Some(dir.as_path())),
            Some("from-project".to_string()),
        );
        // The failure message names the files it read, not a bare "check
        // your .env" the user can't act on.
        assert!(reference_search_summary(Some(dir.as_path()))
            .contains(&dir.join(".env").display().to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
