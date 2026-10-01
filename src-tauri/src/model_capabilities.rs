//! Model capabilities — the one answer to "what can this model do".
//!
//! Every surface that needs a fact about a provider + model pair — the
//! context gauge, the Auto router, the compaction threshold, the composer's
//! attach / effort controls, the cost line — asks `capabilities()` and reads
//! the field it needs. One answer, one memo, one resolution order:
//!
//! 1. **Explicit override** — a request's `num_ctx` (the caller applies it;
//!    this module never sees it).
//! 2. **Provider metadata** — what the Provider itself publishes: the Codex
//!    CLI's model manifest, an OpenAI-wire `/models` listing (OpenRouter
//!    reports windows, tool support and prices per model), a Delegate CLI's
//!    own effort vocabulary, and a registry row's fixed window.
//! 3. **Local probe** — Ollama's `/api/show` (window, `tools` / `vision` /
//!    `thinking` capabilities), and only when the caller allows it, a one-shot
//!    chat that tests whether the model reasons even though its modelfile
//!    forgot to say so.
//! 4. **Name table** — `FAMILIES`, the one list of what a model family is
//!    known to do, consulted last and only where nothing above answered.
//!
//! The price *class* (subscription, local, priced, unknown) is decided by the
//! Provider — its registry row's `KeySource` and subscription flag — never by
//! the shape of a model name. The per-model list prices stay in `pricing.rs`;
//! they are prices, not capabilities.
//!
//! What this module does not do: guess. A window nobody published is `None`,
//! and the two Rust consumers that must plan with a number (`routing`, the
//! compaction threshold) say so through `window_for_planning`, the one place
//! the fallback number lives.

use crate::pricing::ModelPricing;
use crate::providers::{self, KeySource, OLLAMA_URL};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Who makes the model — the mark a surface draws next to its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Maker {
    Anthropic,
    OpenAi,
    Google,
    Meta,
    Mistral,
    DeepSeek,
    Qwen,
    Xai,
    LiquidAi,
    Microsoft,
    MiniMax,
    Moonshot,
    Zai,
    Sakana,
}

/// What a run on this pair costs the user. Decided by the Provider, not the
/// model name: a `claude-sonnet-4-6` under Claude Code is `Subscription`, the
/// same id under Anthropic is `Priced`, and `mistral:7b` under Ollama is
/// `Local` no matter what the pricing table thinks of the word "mistral".
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PriceClass {
    /// A Delegate CLI (or a user-defined CLI agent): the user already paid.
    Subscription,
    /// A local runtime (Ollama, MLX, LM Studio): no per-token bill.
    Local,
    /// A hosted API with a published list price.
    Priced(ModelPricing),
    /// Hosted, but no list price Klide knows (a self-hosted gateway, an
    /// aggregator slug, a model that shipped after the table was written).
    Unknown,
}

/// The answer. `context_window` is `None` when nobody published one — the
/// wire carries `null` and the gauge reads "—", never a made-up number.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub context_window: Option<usize>,
    pub supports_tools: bool,
    pub supports_vision: bool,
    /// The reasoning efforts the pair accepts, weakest first. Empty = no dial.
    pub reasoning_levels: Vec<String>,
    pub price_class: PriceClass,
    pub maker: Option<Maker>,
}

/// The number the router and the compaction threshold plan with when no one
/// published a window. The one place it lives; a surface that can show
/// "unknown" reads `context_window` instead.
pub const DEFAULT_CONTEXT_WINDOW: usize = 128_000;

impl ModelCapabilities {
    /// The window as a number, for the two consumers that cannot plan
    /// without one. An unknown window plans as `DEFAULT_CONTEXT_WINDOW`.
    pub fn window_for_planning(&self) -> usize {
        self.context_window.unwrap_or(DEFAULT_CONTEXT_WINDOW)
    }

    pub fn supports_reasoning(&self) -> bool {
        !self.reasoning_levels.is_empty()
    }
}

/// The levels a Klide-wire run offers when the model reasons at all. Klide
/// owns this vocabulary for its own adapters — `adapters.rs` maps each one to
/// OpenAI's `reasoning_effort`, an Anthropic thinking budget, and Ollama's
/// `think` flag. A Delegate CLI publishes its own set instead.
pub const WIRE_REFLECTION_LEVELS: [&str; 5] = ["minimal", "low", "medium", "high", "xhigh"];

// ── The name table ────────────────────────────────────────────────────────

/// How a family row recognises a model id. Ids are normalised first
/// (`normalize_model_name`): lowercased, the vendor prefix dropped, dots
/// folded to dashes — so one spelling covers `claude-3.5-haiku` and
/// `anthropic/claude-3-5-haiku-20241022`.
#[derive(Clone, Copy)]
enum Matcher {
    Prefix(&'static str),
    Contains(&'static str),
}

impl Matcher {
    fn hit(&self, name: &str) -> bool {
        match self {
            Matcher::Prefix(p) => name.starts_with(p),
            Matcher::Contains(c) => name.contains(c),
        }
    }
}

/// One model family and what it is known to do. Only the facts a Provider
/// cannot be asked for live here; a probe or a listing always wins over a
/// row. `window: None` means the family's window varies by build (a Qwen can
/// be 32k or 256k) and nothing here should pretend otherwise.
struct Family {
    /// A label for the row, so a test can name it.
    #[cfg(test)]
    name: &'static str,
    matchers: &'static [Matcher],
    window: Option<usize>,
    vision: bool,
    reasoning: bool,
    maker: Option<Maker>,
}

/// First match wins, so an exception (a text-only build of a multimodal
/// family) sits above the family it excepts.
const FAMILIES: &[Family] = &[
    // ── Anthropic ──
    Family {
        // The 3.5 Haiku line is Anthropic's one text-only chat model; sending
        // it an image 400s the whole turn.
        #[cfg(test)]
        name: "claude-3-5-haiku",
        matchers: &[Matcher::Contains("claude-3-5-haiku")],
        window: Some(200_000),
        vision: false,
        reasoning: true,
        maker: Some(Maker::Anthropic),
    },
    Family {
        #[cfg(test)]
        name: "claude",
        matchers: &[Matcher::Prefix("claude-")],
        window: Some(200_000),
        vision: true,
        reasoning: true,
        maker: Some(Maker::Anthropic),
    },
    // ── OpenAI ──
    Family {
        #[cfg(test)]
        name: "gpt-5",
        matchers: &[Matcher::Prefix("gpt-5")],
        window: Some(272_000),
        vision: true,
        reasoning: true,
        maker: Some(Maker::OpenAi),
    },
    Family {
        #[cfg(test)]
        name: "gpt-4-1",
        matchers: &[Matcher::Prefix("gpt-4-1")],
        window: Some(1_000_000),
        vision: true,
        reasoning: false,
        maker: Some(Maker::OpenAi),
    },
    Family {
        #[cfg(test)]
        name: "gpt-4o",
        matchers: &[
            Matcher::Prefix("gpt-4o"),
            Matcher::Prefix("chatgpt-4o"),
            Matcher::Prefix("gpt-4-turbo"),
        ],
        window: Some(128_000),
        vision: true,
        reasoning: false,
        maker: Some(Maker::OpenAi),
    },
    Family {
        // The o-series' text-only small builds (o4-mini *is* multimodal).
        #[cfg(test)]
        name: "o-series-text-only",
        matchers: &[
            Matcher::Prefix("o1-mini"),
            Matcher::Prefix("o1-preview"),
            Matcher::Prefix("o3-mini"),
        ],
        window: Some(128_000),
        vision: false,
        reasoning: true,
        maker: Some(Maker::OpenAi),
    },
    Family {
        #[cfg(test)]
        name: "o-series",
        matchers: &[
            Matcher::Prefix("o1"),
            Matcher::Prefix("o3"),
            Matcher::Prefix("o4"),
            Matcher::Prefix("o5"),
        ],
        window: Some(200_000),
        vision: true,
        reasoning: true,
        maker: Some(Maker::OpenAi),
    },
    Family {
        #[cfg(test)]
        name: "gpt",
        matchers: &[Matcher::Prefix("gpt-"), Matcher::Prefix("codex")],
        window: None,
        vision: false,
        reasoning: false,
        maker: Some(Maker::OpenAi),
    },
    // ── Google ──
    Family {
        #[cfg(test)]
        name: "gemini",
        matchers: &[Matcher::Prefix("gemini")],
        window: Some(1_000_000),
        vision: true,
        reasoning: false,
        maker: Some(Maker::Google),
    },
    Family {
        #[cfg(test)]
        name: "gemma",
        matchers: &[Matcher::Prefix("gemma")],
        window: Some(128_000),
        vision: false,
        reasoning: false,
        maker: Some(Maker::Google),
    },
    // ── xAI ──
    Family {
        #[cfg(test)]
        name: "grok-4",
        matchers: &[Matcher::Prefix("grok-4")],
        window: Some(256_000),
        vision: true,
        reasoning: false,
        maker: Some(Maker::Xai),
    },
    Family {
        #[cfg(test)]
        name: "grok",
        matchers: &[Matcher::Prefix("grok")],
        window: Some(256_000),
        vision: false,
        reasoning: false,
        maker: Some(Maker::Xai),
    },
    // ── Mistral ──
    Family {
        #[cfg(test)]
        name: "pixtral",
        matchers: &[Matcher::Prefix("pixtral")],
        window: Some(128_000),
        vision: true,
        reasoning: false,
        maker: Some(Maker::Mistral),
    },
    Family {
        #[cfg(test)]
        name: "mistral-large",
        matchers: &[Matcher::Contains("mistral-large")],
        window: Some(128_000),
        vision: false,
        reasoning: false,
        maker: Some(Maker::Mistral),
    },
    Family {
        #[cfg(test)]
        name: "mistral",
        matchers: &[
            Matcher::Contains("mistral"),
            Matcher::Contains("mixtral"),
            Matcher::Contains("codestral"),
            Matcher::Contains("ministral"),
            Matcher::Contains("magistral"),
            Matcher::Contains("devstral"),
        ],
        window: None,
        vision: false,
        reasoning: false,
        maker: Some(Maker::Mistral),
    },
    // ── DeepSeek ──
    Family {
        // Hosted ids (`deepseek-chat` / `deepseek-reasoner`) and the Ollama
        // pulls (`deepseek-r1:8b`) alike: the hosted API serves 128k.
        #[cfg(test)]
        name: "deepseek",
        matchers: &[Matcher::Contains("deepseek")],
        window: Some(128_000),
        vision: false,
        reasoning: false,
        maker: Some(Maker::DeepSeek),
    },
    // ── Alibaba ──
    Family {
        // Qwen2-VL / Qwen2.5-VL and friends.
        #[cfg(test)]
        name: "qwen-vl",
        matchers: &[
            Matcher::Contains("qwen2-vl"),
            Matcher::Contains("qwen2-5-vl"),
            Matcher::Contains("qwen3-vl"),
        ],
        window: None,
        vision: true,
        reasoning: false,
        maker: Some(Maker::Qwen),
    },
    Family {
        #[cfg(test)]
        name: "qwen",
        matchers: &[Matcher::Contains("qwen")],
        window: None,
        vision: false,
        reasoning: false,
        maker: Some(Maker::Qwen),
    },
    // ── Meta ──
    Family {
        // Llama 3.2's vision builds are the multimodal ones.
        #[cfg(test)]
        name: "llama-3-2",
        matchers: &[Matcher::Contains("llama-3-2")],
        window: Some(128_000),
        vision: true,
        reasoning: false,
        maker: Some(Maker::Meta),
    },
    Family {
        #[cfg(test)]
        name: "llama",
        matchers: &[Matcher::Contains("llama")],
        window: Some(128_000),
        vision: false,
        reasoning: false,
        maker: Some(Maker::Meta),
    },
    // ── Liquid ──
    Family {
        #[cfg(test)]
        name: "lfm",
        matchers: &[Matcher::Prefix("lfm"), Matcher::Contains("liquid")],
        window: Some(128_000),
        vision: false,
        reasoning: false,
        maker: Some(Maker::LiquidAi),
    },
    // ── Microsoft ──
    Family {
        #[cfg(test)]
        name: "phi",
        matchers: &[Matcher::Prefix("phi")],
        window: None,
        vision: false,
        reasoning: false,
        maker: Some(Maker::Microsoft),
    },
    // ── MiniMax / Moonshot / Z.ai / Sakana ──
    Family {
        #[cfg(test)]
        name: "minimax",
        matchers: &[Matcher::Contains("minimax")],
        window: None,
        vision: false,
        reasoning: false,
        maker: Some(Maker::MiniMax),
    },
    Family {
        #[cfg(test)]
        name: "kimi",
        matchers: &[Matcher::Contains("kimi"), Matcher::Contains("moonshot")],
        window: None,
        vision: false,
        reasoning: false,
        maker: Some(Maker::Moonshot),
    },
    Family {
        #[cfg(test)]
        name: "glm",
        matchers: &[Matcher::Prefix("glm")],
        window: None,
        vision: false,
        reasoning: false,
        maker: Some(Maker::Zai),
    },
    Family {
        #[cfg(test)]
        name: "sakana",
        matchers: &[Matcher::Contains("sakana")],
        window: None,
        vision: false,
        reasoning: false,
        maker: Some(Maker::Sakana),
    },
    // ── Multimodal families with no maker mark ──
    Family {
        #[cfg(test)]
        name: "llava",
        matchers: &[Matcher::Prefix("llava")],
        window: None,
        vision: true,
        reasoning: false,
        maker: None,
    },
    Family {
        // Any explicit "-vision" / "-vl" build the rows above did not name.
        #[cfg(test)]
        name: "vision-build",
        matchers: &[
            Matcher::Contains("vision"),
            Matcher::Contains("-vl"),
            Matcher::Contains("vl-"),
        ],
        window: None,
        vision: true,
        reasoning: false,
        maker: None,
    },
];

/// What the table knows about one model id, resolved once.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct NameFacts {
    window: Option<usize>,
    vision: bool,
    reasoning: bool,
    maker: Option<Maker>,
}

/// Lowercase, vendor prefix dropped (`anthropic/claude-…` → `claude-…`),
/// dots folded to dashes (`gpt-4.1` → `gpt-4-1`).
fn normalize_model_name(model: &str) -> String {
    let lower = model.trim().to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(lower.as_str());
    name.replace('.', "-")
}

/// The vendor segment of a namespaced id (`openai/gpt-…` → `openai`), which
/// names the maker when the model half does not (`openai/chatgpt-4o-latest`).
fn vendor_segment(model: &str) -> Option<&str> {
    let (vendor, _) = model.trim().rsplit_once('/')?;
    let vendor = vendor.rsplit('/').next().unwrap_or(vendor);
    (!vendor.is_empty()).then_some(vendor)
}

fn maker_by_vendor(vendor: &str) -> Option<Maker> {
    match vendor.to_ascii_lowercase().as_str() {
        "openai" => Some(Maker::OpenAi),
        "anthropic" => Some(Maker::Anthropic),
        "google" | "google-vertex" => Some(Maker::Google),
        "xai" | "x-ai" => Some(Maker::Xai),
        "moonshot" | "moonshotai" => Some(Maker::Moonshot),
        "zai" | "z-ai" => Some(Maker::Zai),
        "minimax" | "minimaxai" => Some(Maker::MiniMax),
        "deepseek" | "deepseek-ai" => Some(Maker::DeepSeek),
        "qwen" | "alibaba" => Some(Maker::Qwen),
        "mistral" | "mistralai" => Some(Maker::Mistral),
        "meta" | "meta-llama" => Some(Maker::Meta),
        "microsoft" => Some(Maker::Microsoft),
        "sakana" => Some(Maker::Sakana),
        "liquid" => Some(Maker::LiquidAi),
        _ => None,
    }
}

fn family_of(name: &str) -> Option<&'static Family> {
    FAMILIES
        .iter()
        .find(|family| family.matchers.iter().any(|m| m.hit(name)))
}

fn name_facts(model: &str) -> NameFacts {
    let name = normalize_model_name(model);
    let family = family_of(&name);
    NameFacts {
        window: family.and_then(|f| f.window),
        vision: family.is_some_and(|f| f.vision),
        reasoning: family.is_some_and(|f| f.reasoning),
        // The model half is the more specific evidence, so it is read first —
        // `nvidia/llama-3.3-…` is a Llama; only an id whose model half names
        // no maker falls back to its vendor segment.
        maker: family
            .and_then(|f| f.maker)
            .or_else(|| vendor_segment(model).and_then(maker_by_vendor)),
    }
}

// ── The local probe seam ──────────────────────────────────────────────────

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the module asks a local runtime. The one HTTP implementation is
/// `OllamaHttp`; a test hands in a fake so the resolution order is exercised
/// without a daemon.
pub trait LocalProbe: Sync {
    /// Ollama's `/api/show` document for one installed model. `Err` means the
    /// daemon is unreachable or the model is not installed — never cached.
    fn show<'a>(&'a self, model: &'a str) -> BoxFuture<'a, Result<serde_json::Value, String>>;
    /// A one-shot chat with `think: true`, answering whether the model exposed
    /// a thinking channel. Loads the model, so only called when allowed.
    fn thinks<'a>(&'a self, model: &'a str) -> BoxFuture<'a, bool>;
}

pub struct OllamaHttp;

impl LocalProbe for OllamaHttp {
    fn show<'a>(&'a self, model: &'a str) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(async move {
            let res = reqwest::Client::new()
                .post(format!("{OLLAMA_URL}/api/show"))
                .json(&serde_json::json!({ "model": model }))
                .send()
                .await
                .map_err(|e| format!("Unable to reach Ollama: {e}"))?;
            let status = res.status();
            let body = res.text().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(providers::response_error("Ollama", status, &body));
            }
            serde_json::from_str(&body).map_err(|e| format!("Invalid Ollama model info: {e}"))
        })
    }

    fn thinks<'a>(&'a self, model: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
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
            probe_response_has_thinking(&body)
        })
    }
}

/// Conservative on ambiguity: a missing or empty `thinking` field means the
/// model does not reason.
fn probe_response_has_thinking(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").cloned())
        .and_then(|m| m.get("thinking").cloned())
        .and_then(|t| t.as_str().map(str::to_string))
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// The facts one `/api/show` document carries.
#[derive(Clone, Debug, Default, PartialEq)]
struct ShowFacts {
    window: Option<usize>,
    /// `None` when the daemon is too old to report capabilities.
    tools: Option<bool>,
    vision: bool,
    thinking: bool,
}

/// Ollama reports capabilities as a top-level array of strings, e.g.
/// `["tools", "thinking", "completion", "vision"]`. A daemon old enough not
/// to report them still names the model family, and the known tool-capable
/// families are trusted on that alone.
fn show_facts(value: &serde_json::Value) -> ShowFacts {
    let caps = value.get("capabilities").and_then(|v| v.as_array());
    let has = |cap: &str| caps.is_some_and(|c| c.iter().any(|x| x.as_str() == Some(cap)));
    let tools = match caps {
        Some(_) => Some(has("tools")),
        None => {
            let family = value
                .get("details")
                .and_then(|d| d.get("family"))
                .and_then(|v| v.as_str());
            Some(matches!(family, Some("deepseek") | Some("qwen2")))
        }
    };
    ShowFacts {
        window: crate::models::find_context_window(value),
        tools,
        vision: has("vision"),
        thinking: has("thinking"),
    }
}

// ── The memo ──────────────────────────────────────────────────────────────

/// Memoised answers, keyed by `(provider, model)`. Same TTL as the `/models`
/// listing cache: a model switch must not re-hit the network, and a model
/// re-pulled with a new modelfile is picked up within minutes.
static MEMO: LazyLock<Mutex<HashMap<(String, String), (Instant, ModelCapabilities)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const MEMO_TTL: Duration = Duration::from_secs(300);

/// The one-shot chat probe's verdicts, kept for the whole process: it costs
/// an inference, and a modelfile does not change while the app runs.
static THINK_PROBE: LazyLock<Mutex<HashMap<String, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Test-only: forget every memoised answer.
#[cfg(test)]
fn clear_memo() {
    MEMO.lock().unwrap().clear();
    THINK_PROBE.lock().unwrap().clear();
}

// ── Resolution ────────────────────────────────────────────────────────────

/// What can this model do? Memoised; a local probe that cannot be reached is
/// an `Err` and is not remembered.
///
/// `allow_activation_probe` gates the only step that loads a model: the
/// one-shot chat that discovers reasoning support Ollama's modelfile did not
/// advertise. A surface that must stay passive (a resumed transcript before
/// its first send) passes `false`; the answer it gets is not memoised, so the
/// next allowed call completes it.
pub async fn capabilities(
    provider: &str,
    model: &str,
    allow_activation_probe: bool,
) -> Result<ModelCapabilities, String> {
    resolve_with(&OllamaHttp, provider, model, allow_activation_probe).await
}

/// `capabilities` with the local probe supplied — the seam tests use.
pub async fn resolve_with(
    probe: &dyn LocalProbe,
    provider: &str,
    model: &str,
    allow_activation_probe: bool,
) -> Result<ModelCapabilities, String> {
    let key = (provider.to_string(), model.to_string());
    if let Some((at, caps)) = MEMO.lock().unwrap().get(&key) {
        if at.elapsed() < MEMO_TTL {
            return Ok(caps.clone());
        }
    }
    let (caps, complete) = resolve_uncached(probe, provider, model, allow_activation_probe).await?;
    if complete {
        MEMO.lock().unwrap().insert(key, (Instant::now(), caps.clone()));
    }
    Ok(caps)
}

/// The resolution itself. Returns the answer and whether it is complete
/// (memoisable) — a reasoning verdict skipped because the probe was not
/// allowed leaves the answer incomplete.
async fn resolve_uncached(
    probe: &dyn LocalProbe,
    provider: &str,
    model: &str,
    allow_activation_probe: bool,
) -> Result<(ModelCapabilities, bool), String> {
    let names = name_facts(model);
    let price_class = price_class(provider, model);

    // `auto` is not a backend: nothing is known until the router picks. Tools
    // are guaranteed by construction (a Plan or Goal run is only ever placed
    // on a model that reports them); vision and reasoning are `false` rather
    // than a dial the resolved model may ignore; the window is unknown.
    if crate::agent::routing::is_auto(provider) {
        return Ok((
            ModelCapabilities {
                context_window: None,
                supports_tools: true,
                supports_vision: false,
                reasoning_levels: Vec::new(),
                price_class,
                maker: None,
            },
            true,
        ));
    }

    // A Delegate CLI: the CLI's own facts. Codex publishes a per-model window
    // and effort set in its manifest; Claude Code accepts a CLI-wide effort
    // vocabulary; the others have no dial. Every Delegate uses tools; none
    // takes an image through Klide's composer.
    if providers::is_subscription_provider(provider) {
        let entry = providers::lookup(provider);
        let context_window = if provider == "codex" {
            crate::models::codex_context_window(model)
        } else {
            None
        }
        .or_else(|| entry.and_then(|e| e.context_window))
        .or(names.window);
        let reasoning_levels = if provider == "codex" {
            crate::models::codex_reasoning_levels(model).unwrap_or_default()
        } else if provider == "claude-code" {
            crate::delegate::CLAUDE_EFFORT_LEVELS
                .iter()
                .map(|s| s.to_string())
                .collect()
        } else {
            Vec::new()
        };
        return Ok((
            ModelCapabilities {
                context_window,
                supports_tools: true,
                supports_vision: false,
                reasoning_levels,
                price_class,
                maker: names.maker,
            },
            true,
        ));
    }

    let entry = providers::lookup(provider);

    // Ollama: the daemon's `/api/show` is the authority for the window and
    // the tools / vision / thinking capabilities; the name table only fills a
    // window the modelfile did not carry.
    if provider == "ollama" {
        let show = show_facts(&probe.show(model).await?);
        let mut complete = true;
        let reasons = if show.thinking {
            true
        } else {
            let cached = THINK_PROBE.lock().unwrap().get(model).copied();
            match cached {
                Some(verdict) => verdict,
                None if allow_activation_probe => {
                    let verdict = probe.thinks(model).await;
                    THINK_PROBE.lock().unwrap().insert(model.to_string(), verdict);
                    verdict
                }
                None => {
                    complete = false;
                    false
                }
            }
        };
        return Ok((
            ModelCapabilities {
                context_window: show.window.or(names.window),
                supports_tools: show.tools.unwrap_or(true),
                supports_vision: show.vision,
                reasoning_levels: wire_levels_if(reasons),
                price_class,
                maker: names.maker,
            },
            complete,
        ));
    }

    // Every other Provider: its `/models` listing where it publishes one
    // (OpenRouter reports windows and tool support per model), the registry
    // row's fixed window, then the name table.
    let listing = match entry.map(|e| e.models) {
        Some(providers::ModelsHandler::OpenAiModels) => crate::models::openai_model_meta(provider)
            .await
            .get(model)
            .cloned(),
        _ => None,
    };
    let context_window = listing
        .as_ref()
        .and_then(|m| m.context_length)
        .or_else(|| entry.and_then(|e| e.context_window))
        .or(names.window);
    // Tool calling is the optimistic default on a hosted wire: an endpoint
    // that does not say is assumed to accept `tools`.
    let supports_tools = listing.as_ref().and_then(|m| m.supports_tools).unwrap_or(true);

    // Provider facts the registry does not carry yet: mlx_lm.server is
    // text-only (vision on Apple silicon needs mlx-vlm), and only the wires
    // that map a reflection level accept one. The wire is on the registry row;
    // whether the *model* reasons is the name table's call.
    let (supports_vision, reasons) = match entry.map(|e| (e.id, e.wire)) {
        Some(("mlx", _)) => (false, false),
        Some((_, providers::WireFormat::Anthropic)) => (names.vision, names.reasoning),
        Some((_, providers::WireFormat::OpenAi(cfg))) => {
            (names.vision, cfg.supports_reasoning_effort && names.reasoning)
        }
        // A self-hosted OpenAI-wire endpoint: the name is all there is to go
        // on for vision; no reflection dial, since nothing proves the server
        // honours `reasoning_effort`.
        _ => (names.vision, false),
    };

    Ok((
        ModelCapabilities {
            context_window,
            supports_tools,
            supports_vision,
            reasoning_levels: wire_levels_if(reasons),
            price_class,
            maker: names.maker,
        },
        true,
    ))
}

fn wire_levels_if(reasons: bool) -> Vec<String> {
    if reasons {
        WIRE_REFLECTION_LEVELS.iter().map(|l| l.to_string()).collect()
    } else {
        Vec::new()
    }
}

/// What a run on this pair costs, decided by the Provider. Pure and cheap —
/// no network, so the pricing command can stay synchronous.
pub fn price_class(provider: &str, model: &str) -> PriceClass {
    if providers::is_subscription_provider(provider) {
        return PriceClass::Subscription;
    }
    if crate::agent::routing::is_auto(provider) {
        return PriceClass::Unknown;
    }
    match providers::lookup(provider).map(|e| e.key) {
        Some(KeySource::Local) => PriceClass::Local,
        Some(KeySource::Hosted { .. }) => crate::pricing::list_price_for_model(model)
            .map(PriceClass::Priced)
            .unwrap_or(PriceClass::Unknown),
        // A self-hosted endpoint may front anything — a free local server or
        // a paid gateway. Nothing on the row says which.
        None => PriceClass::Unknown,
    }
}

/// The run's USD cost from its Provider, model and token counts. `None`
/// unless the pair is `Priced`. Token counts are clamped at 0 — a missing or
/// negative field is zero, never a negative bill.
pub fn cost_for_run(
    provider: &str,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
) -> Option<f64> {
    match price_class(provider, model) {
        PriceClass::Priced(price) => Some(price.cost(input_tokens, output_tokens)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(model: &str) -> NameFacts {
        name_facts(model)
    }

    // ── One test per family, every fact together ──

    #[test]
    fn family_claude() {
        for id in ["claude-sonnet-4-6", "anthropic/claude-opus-4-6", "claude-fable-5"] {
            assert_eq!(
                facts(id),
                NameFacts { window: Some(200_000), vision: true, reasoning: true, maker: Some(Maker::Anthropic) },
                "{id}"
            );
        }
        // The one text-only Claude, in both spellings.
        for id in ["claude-3-5-haiku-20241022", "anthropic/claude-3.5-haiku"] {
            assert_eq!(
                facts(id),
                NameFacts { window: Some(200_000), vision: false, reasoning: true, maker: Some(Maker::Anthropic) },
                "{id}"
            );
        }
    }

    #[test]
    fn family_gpt_5() {
        for id in ["gpt-5", "gpt-5-mini", "openai/gpt-5.2"] {
            assert_eq!(
                facts(id),
                NameFacts { window: Some(272_000), vision: true, reasoning: true, maker: Some(Maker::OpenAi) },
                "{id}"
            );
        }
    }

    #[test]
    fn family_gpt_4_1_and_4o() {
        assert_eq!(
            facts("gpt-4.1"),
            NameFacts { window: Some(1_000_000), vision: true, reasoning: false, maker: Some(Maker::OpenAi) }
        );
        for id in ["gpt-4o-mini", "chatgpt-4o-latest", "gpt-4-turbo"] {
            assert_eq!(
                facts(id),
                NameFacts { window: Some(128_000), vision: true, reasoning: false, maker: Some(Maker::OpenAi) },
                "{id}"
            );
        }
        // An OpenAI id no row names still has a maker, and nothing else.
        assert_eq!(
            facts("gpt-3.5-turbo"),
            NameFacts { window: None, vision: false, reasoning: false, maker: Some(Maker::OpenAi) }
        );
    }

    #[test]
    fn family_o_series() {
        for id in ["o1", "o3", "o4-mini", "openai/o5"] {
            assert_eq!(
                facts(id),
                NameFacts { window: Some(200_000), vision: true, reasoning: true, maker: Some(Maker::OpenAi) },
                "{id}"
            );
        }
        // The text-only small builds must not ride the prefix.
        for id in ["o1-mini", "o1-preview", "openai/o3-mini"] {
            assert_eq!(
                facts(id),
                NameFacts { window: Some(128_000), vision: false, reasoning: true, maker: Some(Maker::OpenAi) },
                "{id}"
            );
        }
    }

    #[test]
    fn family_google() {
        assert_eq!(
            facts("gemini-2.5-pro"),
            NameFacts { window: Some(1_000_000), vision: true, reasoning: false, maker: Some(Maker::Google) }
        );
        assert_eq!(
            facts("gemma3:12b"),
            NameFacts { window: Some(128_000), vision: false, reasoning: false, maker: Some(Maker::Google) }
        );
    }

    #[test]
    fn family_xai() {
        assert_eq!(
            facts("grok-4"),
            NameFacts { window: Some(256_000), vision: true, reasoning: false, maker: Some(Maker::Xai) }
        );
        assert_eq!(
            facts("grok-3"),
            NameFacts { window: Some(256_000), vision: false, reasoning: false, maker: Some(Maker::Xai) }
        );
    }

    #[test]
    fn family_mistral() {
        assert_eq!(
            facts("mistral-large-latest"),
            NameFacts { window: Some(128_000), vision: false, reasoning: false, maker: Some(Maker::Mistral) }
        );
        assert_eq!(
            facts("pixtral-12b"),
            NameFacts { window: Some(128_000), vision: true, reasoning: false, maker: Some(Maker::Mistral) }
        );
        for id in ["mistral:7b", "codestral-latest", "devstral", "mixtral-8x7b"] {
            assert_eq!(
                facts(id),
                NameFacts { window: None, vision: false, reasoning: false, maker: Some(Maker::Mistral) },
                "{id}"
            );
        }
    }

    #[test]
    fn family_deepseek() {
        for id in ["deepseek-chat", "deepseek-reasoner", "deepseek-r1:8b", "deepseek/deepseek-v3"] {
            assert_eq!(
                facts(id),
                NameFacts { window: Some(128_000), vision: false, reasoning: false, maker: Some(Maker::DeepSeek) },
                "{id}"
            );
        }
    }

    #[test]
    fn family_qwen() {
        assert_eq!(
            facts("qwen3:8b"),
            NameFacts { window: None, vision: false, reasoning: false, maker: Some(Maker::Qwen) }
        );
        assert_eq!(
            facts("qwen2.5-vl:7b"),
            NameFacts { window: None, vision: true, reasoning: false, maker: Some(Maker::Qwen) }
        );
    }

    #[test]
    fn family_llama() {
        assert_eq!(
            facts("llama3.1:8b"),
            NameFacts { window: Some(128_000), vision: false, reasoning: false, maker: Some(Maker::Meta) }
        );
        assert_eq!(
            facts("meta-llama/llama-3.2-11b-vision-instruct"),
            NameFacts { window: Some(128_000), vision: true, reasoning: false, maker: Some(Maker::Meta) }
        );
        // The model half is the more specific evidence: a Llama served by
        // NVIDIA is still a Llama.
        assert_eq!(facts("nvidia/llama-3.3-nemotron").maker, Some(Maker::Meta));
    }

    #[test]
    fn family_liquid_microsoft_and_the_rest() {
        assert_eq!(
            facts("lfm2.5:1.2b"),
            NameFacts { window: Some(128_000), vision: false, reasoning: false, maker: Some(Maker::LiquidAi) }
        );
        assert_eq!(facts("phi3:14b").maker, Some(Maker::Microsoft));
        assert_eq!(facts("minimax-m2").maker, Some(Maker::MiniMax));
        assert_eq!(facts("kimi-k2").maker, Some(Maker::Moonshot));
        assert_eq!(facts("glm-4.6").maker, Some(Maker::Zai));
        assert_eq!(facts("sakana/fugu-ultra").maker, Some(Maker::Sakana));
        assert_eq!(
            facts("llava:13b"),
            NameFacts { window: None, vision: true, reasoning: false, maker: None }
        );
        assert_eq!(facts("some-vendor-vision-x").vision, true);
    }

    #[test]
    fn every_family_row_has_its_own_name_and_at_least_one_matcher() {
        let mut seen = std::collections::HashSet::new();
        for family in FAMILIES {
            assert!(seen.insert(family.name), "duplicate family row: {}", family.name);
            assert!(!family.matchers.is_empty(), "{} matches nothing", family.name);
        }
    }

    #[test]
    fn an_unknown_model_is_unknown_not_128k() {
        assert_eq!(facts("totally-unknown"), NameFacts::default());
        // A namespaced id whose model half names nothing still has a maker
        // from its vendor segment; `openrouter/auto` routes, it does not make.
        assert_eq!(facts("openai/chatgpt-next").maker, Some(Maker::OpenAi));
        assert_eq!(facts("openrouter/auto").maker, None);
        assert_eq!(facts("mlx-community/whatever-4bit").maker, None);
    }

    // ── Price class comes from the Provider ──

    #[test]
    fn omp_is_a_subscription_price_class() {
        // pricing.rs used to list claude-code | codex | opencode and miss omp;
        // the class now comes from the registry's subscription flag, which
        // carries all four.
        for delegate in crate::delegate::ALL {
            let provider = delegate.id();
            assert_eq!(
                price_class(provider, "claude-sonnet-4-6"),
                PriceClass::Subscription,
                "{provider}"
            );
            assert_eq!(cost_for_run(provider, "claude-sonnet-4-6", 1_000_000, 1_000_000), None);
        }
    }

    #[test]
    fn local_is_free_by_key_source_not_by_name() {
        // Every one of these would be priced by the table on its name alone
        // (`mistral`, `deepseek`, `claude`); under a local runtime it is free.
        for model in ["mistral:7b", "deepseek-chat", "claude-sonnet-4-6", "gpt-5", "llama3.1:8b"] {
            for provider in ["ollama", "mlx", "lmstudio"] {
                assert_eq!(price_class(provider, model), PriceClass::Local, "{provider}/{model}");
                assert_eq!(cost_for_run(provider, model, 1_000_000, 1_000_000), None);
            }
        }
        // And the same id under a hosted Provider is priced.
        assert!(matches!(price_class("anthropic", "claude-sonnet-4-6"), PriceClass::Priced(_)));
        assert!(matches!(price_class("deepseek", "deepseek-chat"), PriceClass::Priced(_)));
        assert!((cost_for_run("openai", "gpt-5", 1_000_000, 1_000_000).unwrap() - 12.5).abs() < 1e-9);
        // Hosted but unpriced, a self-hosted endpoint, and `auto`: unknown.
        assert_eq!(price_class("openai", "gpt-9001-future"), PriceClass::Unknown);
        assert_eq!(price_class("custom:my-gateway", "gpt-5"), PriceClass::Unknown);
        assert_eq!(price_class("auto", "auto"), PriceClass::Unknown);
    }

    // ── The local probe seam ──

    struct FakeOllama {
        show: Result<serde_json::Value, String>,
        thinks: bool,
        thinks_calls: std::sync::atomic::AtomicUsize,
    }

    impl FakeOllama {
        fn new(show: serde_json::Value, thinks: bool) -> Self {
            Self { show: Ok(show), thinks, thinks_calls: Default::default() }
        }
    }

    impl LocalProbe for FakeOllama {
        fn show<'a>(&'a self, _model: &'a str) -> BoxFuture<'a, Result<serde_json::Value, String>> {
            Box::pin(std::future::ready(self.show.clone()))
        }
        fn thinks<'a>(&'a self, _model: &'a str) -> BoxFuture<'a, bool> {
            self.thinks_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(std::future::ready(self.thinks))
        }
    }

    /// The memo is process-wide, so every test that resolves uses its own
    /// model id and runs under this lock to keep the probe counts honest.
    static SERIAL: Mutex<()> = Mutex::new(());

    #[tokio::test]
    async fn the_router_and_the_gauge_read_the_same_probed_window() {
        let _guard = SERIAL.lock().unwrap();
        clear_memo();
        let probe = FakeOllama::new(
            serde_json::json!({
                "capabilities": ["tools", "completion"],
                "model_info": { "llama.context_length": 8192, "general.parameter_count": 8_000_000_000_u64 }
            }),
            false,
        );
        // The gauge command and the router both read this one answer…
        let caps = resolve_with(&probe, "ollama", "probe-window:8b", true).await.unwrap();
        assert_eq!(caps.context_window, Some(8192));
        // …and the router's planning number is the probed window, not the
        // name table's 128k (which is what `resolve_context_window` used to
        // hand it for every Ollama model).
        let facts = crate::agent::routing::facts_from(&caps);
        assert_eq!(facts.context_window, 8192);
        assert!(facts.supports_tools);
    }

    #[tokio::test]
    async fn ollama_facts_come_from_the_daemon_first_and_the_table_last() {
        let _guard = SERIAL.lock().unwrap();
        clear_memo();
        // A modelfile without a window: the family row fills it.
        let probe = FakeOllama::new(
            serde_json::json!({ "capabilities": ["tools", "vision", "thinking"] }),
            false,
        );
        let caps = resolve_with(&probe, "ollama", "llama3.2-vision:11b", true).await.unwrap();
        assert_eq!(caps.context_window, Some(128_000));
        assert!(caps.supports_tools && caps.supports_vision);
        assert_eq!(caps.reasoning_levels, WIRE_REFLECTION_LEVELS.to_vec());
        assert_eq!(caps.price_class, PriceClass::Local);
        assert_eq!(caps.maker, Some(Maker::Meta));
        // Advertised thinking means the chat probe never runs.
        assert_eq!(probe.thinks_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn the_chat_probe_runs_once_and_only_when_allowed() {
        let _guard = SERIAL.lock().unwrap();
        clear_memo();
        let probe = FakeOllama::new(serde_json::json!({ "capabilities": ["tools"] }), true);
        // Passive: no probe, no dial, and the answer is not memoised.
        let passive = resolve_with(&probe, "ollama", "lfm2.5:8b-probe", false).await.unwrap();
        assert!(passive.reasoning_levels.is_empty());
        assert_eq!(probe.thinks_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        // Allowed: one probe, then the verdict is remembered for the process.
        let active = resolve_with(&probe, "ollama", "lfm2.5:8b-probe", true).await.unwrap();
        assert_eq!(active.reasoning_levels, WIRE_REFLECTION_LEVELS.to_vec());
        let again = resolve_with(&probe, "ollama", "lfm2.5:8b-probe", true).await.unwrap();
        assert_eq!(again, active);
        assert_eq!(probe.thinks_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_unreachable_daemon_is_an_error_and_is_not_remembered() {
        let _guard = SERIAL.lock().unwrap();
        clear_memo();
        let down = FakeOllama {
            show: Err("Unable to reach Ollama".to_string()),
            thinks: false,
            thinks_calls: Default::default(),
        };
        assert!(resolve_with(&down, "ollama", "down:1b", true).await.is_err());
        let up = FakeOllama::new(serde_json::json!({ "capabilities": ["tools"] }), false);
        assert!(resolve_with(&up, "ollama", "down:1b", true).await.is_ok());
    }

    #[test]
    fn show_facts_reads_capabilities_and_falls_back_to_the_family() {
        let modern = serde_json::json!({
            "capabilities": ["tools", "thinking", "completion"],
            "model_info": { "lfm2moe.context_length": 128_000 }
        });
        assert_eq!(
            show_facts(&modern),
            ShowFacts { window: Some(128_000), tools: Some(true), vision: false, thinking: true }
        );
        // A daemon too old to list capabilities: the known tool-capable
        // families are trusted, everything else is not.
        let old = serde_json::json!({ "details": { "family": "qwen2" } });
        assert_eq!(show_facts(&old).tools, Some(true));
        let old_other = serde_json::json!({ "details": { "family": "llama" } });
        assert_eq!(show_facts(&old_other).tools, Some(false));
    }

    #[test]
    fn probe_response_recognises_a_thinking_channel() {
        assert!(probe_response_has_thinking(r#"{"message":{"thinking":"Let me think...","content":"hi"}}"#));
        assert!(!probe_response_has_thinking(r#"{"message":{"thinking":"","content":"hi"}}"#));
        assert!(!probe_response_has_thinking(r#"{"message":{"content":"hi"}}"#));
        assert!(!probe_response_has_thinking("not json"));
    }

    // ── Hosted and Delegate answers (no network) ──

    #[tokio::test]
    async fn auto_is_unknown_until_routed() {
        let caps = capabilities("auto", "auto", true).await.unwrap();
        assert_eq!(caps.context_window, None);
        assert!(caps.supports_tools);
        assert!(!caps.supports_vision);
        assert!(caps.reasoning_levels.is_empty());
        assert_eq!(caps.price_class, PriceClass::Unknown);
    }

    #[tokio::test]
    async fn mlx_is_a_tool_capable_text_only_local_runtime() {
        let caps = capabilities("mlx", "mlx-community/Llama-3.1-8B-Instruct-4bit", true)
            .await
            .unwrap();
        // The registry row's fixed window, tools from the curated presets,
        // no vision (mlx_lm.server is text-only), no dial.
        assert_eq!(caps.context_window, Some(128_000));
        assert!(caps.supports_tools);
        assert!(!caps.supports_vision);
        assert!(caps.reasoning_levels.is_empty());
        assert_eq!(caps.price_class, PriceClass::Local);
    }

    #[tokio::test]
    async fn claude_code_answers_from_the_cli_not_the_wire() {
        for model in ["default", "sonnet", "claude-opus-4-6"] {
            let caps = capabilities("claude-code", model, true).await.unwrap();
            assert_eq!(caps.context_window, Some(200_000), "{model}");
            assert!(caps.supports_tools);
            assert!(!caps.supports_vision);
            assert_eq!(caps.reasoning_levels, vec!["low", "medium", "high", "xhigh", "max"]);
            assert_eq!(caps.price_class, PriceClass::Subscription);
        }
    }

    #[tokio::test]
    async fn delegates_without_an_effort_switch_get_no_dial() {
        for provider in ["opencode", "omp"] {
            let caps = capabilities(provider, "any-model", true).await.unwrap();
            assert!(caps.reasoning_levels.is_empty(), "{provider}");
            assert!(caps.supports_tools);
            assert_eq!(caps.price_class, PriceClass::Subscription);
        }
    }

    #[tokio::test]
    async fn a_hosted_reasoning_model_offers_klides_own_levels() {
        // The Anthropic wire maps a level to a thinking budget; every Claude
        // reasons.
        let caps = capabilities("anthropic", "claude-sonnet-4-6", true).await.unwrap();
        assert_eq!(caps.reasoning_levels, WIRE_REFLECTION_LEVELS.to_vec());
        assert!(caps.supports_vision);
        assert_eq!(caps.context_window, Some(200_000));
        assert!(matches!(caps.price_class, PriceClass::Priced(_)));
        // The OpenAI wire maps one to `reasoning_effort`, for the models that
        // reason — and not for the ones that don't.
        assert!(capabilities("openai", "gpt-5", true).await.unwrap().supports_reasoning());
        assert!(capabilities("openai", "o4-mini", true).await.unwrap().supports_reasoning());
        assert!(!capabilities("openai", "gpt-4.1-mini", true).await.unwrap().supports_reasoning());
        // Mistral's wire does not accept `reasoning_effort` at all.
        assert!(!capabilities("mistral", "mistral-large", true).await.unwrap().supports_reasoning());
        // Nor does a self-hosted endpoint prove it does.
        assert!(!capabilities("custom:gateway", "gpt-5", true).await.unwrap().supports_reasoning());
    }

    #[tokio::test]
    async fn the_text_only_haiku_is_blind_on_every_wire() {
        assert!(!capabilities("anthropic", "claude-3-5-haiku-20241022", true).await.unwrap().supports_vision);
        assert!(capabilities("anthropic", "claude-haiku-4-5", true).await.unwrap().supports_vision);
        // The OpenAI wire's o-series exception rides the same table.
        assert!(!capabilities("openai", "o3-mini", true).await.unwrap().supports_vision);
        assert!(capabilities("openai", "o4-mini", true).await.unwrap().supports_vision);
    }

    #[test]
    fn planning_falls_back_to_the_one_named_default() {
        let unknown = ModelCapabilities {
            context_window: None,
            supports_tools: true,
            supports_vision: false,
            reasoning_levels: Vec::new(),
            price_class: PriceClass::Unknown,
            maker: None,
        };
        assert_eq!(unknown.window_for_planning(), DEFAULT_CONTEXT_WINDOW);
        let known = ModelCapabilities { context_window: Some(8192), ..unknown };
        assert_eq!(known.window_for_planning(), 8192);
    }
}
