// Provider streaming — the seam between "Klide wants a completion" and
// each provider's wire format. One trait, one shared HTTP/line loop, one
// adapter per wire (Ollama JSON-lines, OpenAI SSE, Anthropic SSE).
//
// New provider = one adapter, not another copy of the streaming
// infrastructure. `parse_line` takes a `&dyn Fn` sink (not a Tauri
// `Channel`) so the parsers stay unit-testable without a webview — the
// fixture tests at the bottom of this file pin each wire contract.

use crate::{
    provider_key, response_error, text_from_message, AiChatResponse, AiUsage, StreamChunk,
};
use crate::{ANTHROPIC_VERSION, OLLAMA_URL};
use std::time::Duration;
use tauri::ipc::Channel;

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

    /// Takes `self` so adapters can attach usage stats accumulated while
    /// parsing the stream (final Ollama frame, OpenAI/Anthropic usage blocks).
    fn finalize_response(
        self,
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
    // Send with retry on transient throttling. A 429 (rate limit) or 503
    // (overloaded) arrives BEFORE any streamed bytes, so retrying the whole
    // request is safe — no chunks have been emitted yet. We honor the server's
    // own backoff hint (Retry-After header, or OpenAI's "try again in Xs"
    // body) and fall back to exponential backoff. The run only fails if the
    // throttling outlasts our retries.
    const MAX_RETRIES: u32 = 3;
    let mut attempt: u32 = 0;
    let res = loop {
        let res = provider
            .build_request(&client)?
            .send()
            .await
            .map_err(|e| format!("Unable to reach {}: {e}", provider.name()))?;
        let status = res.status();
        if status.is_success() {
            break res;
        }
        let transient = matches!(status.as_u16(), 429 | 503);
        let header_wait = retry_after_header(res.headers());
        // Reading the body consumes `res`; we need it for both the backoff
        // hint and the final error, so read it once here.
        let body = res.text().await.unwrap_or_default();
        if transient && attempt < MAX_RETRIES {
            let wait = header_wait
                .or_else(|| retry_after_from_body(&body))
                .unwrap_or_else(|| Duration::from_millis(500 * 2u64.pow(attempt)))
                .min(Duration::from_secs(30)); // never sleep absurdly long
            attempt += 1;
            tokio::time::sleep(wait).await;
            continue;
        }
        return Err(response_error(provider.name(), status, &body));
    };

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

    Ok(provider.finalize_response(content, thinking, tools))
}

/// Parse a `Retry-After` response header. Per HTTP it's either a number of
/// seconds or an HTTP-date; we only handle the seconds form (what OpenAI /
/// Anthropic send), returning `None` for anything else so the caller falls
/// back to its own backoff.
fn retry_after_header(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let secs: f64 = raw.trim().parse().ok()?;
    (secs.is_finite() && secs >= 0.0).then(|| Duration::from_millis((secs * 1000.0) as u64))
}

/// Pull a backoff hint out of OpenAI's error body, which phrases it as
/// "Please try again in 3.353s" (or "…in 412ms"). Best-effort: returns `None`
/// if the phrase isn't found, so the caller uses exponential backoff instead.
fn retry_after_from_body(body: &str) -> Option<Duration> {
    let rest = body.split("try again in ").nth(1)?;
    // The number (digits + decimal point) then the unit letters right after it,
    // parsed separately so a trailing sentence period can't contaminate either.
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let unit: String = rest[num.len()..]
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    let value: f64 = num.parse().ok()?;
    match unit.as_str() {
        "ms" => Some(Duration::from_millis(value as u64)),
        "s" => Some(Duration::from_millis((value * 1000.0) as u64)),
        _ => None,
    }
}

// ── Ollama adapter ──

struct OllamaAdapter {
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    /// Context window (num_ctx) to request. `None` falls back to a generous
    /// default; the caller normally resolves the model's real trained window
    /// (or a user override) and passes it here.
    num_ctx: Option<usize>,
    /// Reply budget for Ollama (`num_predict`). `None` keeps Ollama's default.
    num_predict: Option<usize>,
    /// Ollama's documented thinking control is boolean. Klide stores richer
    /// labels for future providers; for Ollama, explicit non-off levels map to
    /// `think: true`, `off` maps to `false`, and Auto omits the field.
    think: Option<bool>,
    usage: AiUsage,
    /// Ollama's `done_reason` from the final frame: `"stop"` (finished) or
    /// `"length"` (cut off at num_ctx). Surfaced so the harness can flag a
    /// truncated answer.
    stop_reason: Option<String>,
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
            // Ollama defaults num_ctx to 4096 regardless of what the model can
            // actually handle. Agent turns (system prompt + tool schemas + a
            // few messages) blow past that instantly, and Ollama then returns
            // a 400 "exceeds the available context size" error. The caller
            // resolves each model's real trained window (or a user override)
            // and passes it as `num_ctx`; we fall back to a generous default
            // when it's absent. Ollama clamps to the model's trained max, so
            // an over-large value is safe.
            "options": { "num_ctx": self.num_ctx.unwrap_or(32768) },
        });
        if let Some(num_predict) = self.num_predict {
            body["options"]["num_predict"] = serde_json::json!(num_predict);
        }
        if let Some(think) = self.think {
            body["think"] = serde_json::json!(think);
        }
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
        // The final frame (done: true) carries the real token accounting.
        // Durations are nanoseconds on the wire.
        if value.get("done").and_then(|v| v.as_bool()) == Some(true) {
            let count = |k: &str| value.get(k).and_then(|v| v.as_u64());
            self.usage = AiUsage {
                prompt_tokens: count("prompt_eval_count"),
                completion_tokens: count("eval_count"),
                eval_duration_ms: count("eval_duration").map(|ns| ns / 1_000_000),
                prompt_eval_duration_ms: count("prompt_eval_duration").map(|ns| ns / 1_000_000),
            };
            self.stop_reason = value
                .get("done_reason")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        Ok(())
    }

    fn finalize_response(
        self,
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
            usage: if self.usage.is_empty() {
                None
            } else {
                Some(self.usage)
            },
            stop_reason: self.stop_reason,
        }
    }
}

/// A comfortable, flat working window for num_ctx.
///
/// Background: Ollama allocates the KV cache at model-load time, sized to
/// num_ctx — real RAM, reserved up front. We *used* to ramp num_ctx up from a
/// tiny tier per conversation to keep that cache small. But measurements on an
/// 8B model showed the cache is cheap (32k ≈ +0.5 GB over weights, 128k ≈
/// +1.8 GB) — the memory floor is the model weights, not the cache. Ramping
/// saved ~1 GB while causing two real problems: long answers were *truncated*
/// when a too-small cache filled mid-generation, and every conversation that
/// crossed a tier forced a model reload.
///
/// So instead: default to a roomy 32k working window (proven safe on a 17 GB
/// Mac), grow past it only for genuinely large conversations, and cap at the
/// model's real trained window (`ceiling`, which a user override also sets to
/// dial memory up or down). The result loads once and never truncates a normal
/// answer.
fn working_num_ctx(
    messages: &[serde_json::Value],
    tools: Option<&Vec<serde_json::Value>>,
    ceiling: usize,
) -> usize {
    // A flat default big enough for real coding conversations. Below this we
    // don't bother shrinking — the saving isn't worth the reloads/truncation.
    const WORKING_DEFAULT: usize = 32_768;
    // ~4 chars per token is the usual rough estimate. Count BOTH the messages
    // and the tool schemas — the schemas are sent separately from `messages`
    // but still occupy the prompt. Omitting them under-sizes the window, Ollama
    // truncates, the tool defs fall off the end, and the model "loses" its
    // tools and starts hallucinating its own call protocol.
    let msg_chars: usize = messages
        .iter()
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
        .map(|s| s.len())
        .sum();
    let tool_chars: usize = tools
        .map(|t| t.iter().map(|s| s.to_string().len()).sum())
        .unwrap_or(0);
    let needed = (msg_chars + tool_chars) / 4 + 4096; // + response headroom
                                                      // At least the comfortable default; grow to fit a large conversation;
                                                      // never exceed the model's real window.
    needed.max(WORKING_DEFAULT).min(ceiling).max(1024)
}

fn reflection_level_to_ollama_think(level: Option<&str>) -> Option<bool> {
    match level.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some("auto") => None,
        Some("minimal" | "low" | "medium" | "high" | "xhigh") => Some(true),
        // Legacy values from older Klide builds.
        Some("off") => Some(false),
        Some("max") => Some(true),
        // Unknown future labels should be inert rather than surprising users.
        Some(_) => None,
    }
}

pub(crate) fn reflection_level_to_openai_effort(level: Option<&str>) -> Option<String> {
    match level.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some("auto" | "off") => None,
        Some("minimal") => Some("minimal".to_string()),
        Some("low") => Some("low".to_string()),
        Some("medium") => Some("medium".to_string()),
        Some("high") => Some("high".to_string()),
        Some("xhigh") => Some("xhigh".to_string()),
        // Legacy value from older Klide builds.
        Some("max") => Some("xhigh".to_string()),
        Some(_) => None,
    }
}

fn reflection_level_to_anthropic_budget(level: Option<&str>) -> Option<usize> {
    match level.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some("auto" | "off") => None,
        Some("minimal") => Some(1024),
        Some("low") => Some(2048),
        Some("medium") => Some(4096),
        Some("high") => Some(8192),
        Some("xhigh") => Some(16_384),
        // Legacy value from older Klide builds.
        Some("max") => Some(16_384),
        Some(_) => None,
    }
}

pub(crate) async fn ollama_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    num_ctx: Option<usize>,
    num_predict: Option<usize>,
    reflection_level: Option<String>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let ceiling = num_ctx.unwrap_or(32768);
    let sized = working_num_ctx(&messages, tools.as_ref(), ceiling);
    let think = reflection_level_to_ollama_think(reflection_level.as_deref());
    let adapter = OllamaAdapter {
        model,
        messages,
        tools,
        num_ctx: Some(sized),
        num_predict,
        think,
        usage: AiUsage::default(),
        stop_reason: None,
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

fn accumulate_openai_tool_calls(calls: &[serde_json::Value], tools: &mut Vec<OpenAiToolAcc>) {
    for (fallback_index, call) in calls.iter().enumerate() {
        let index = call
            .get("index")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(fallback_index);
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
            if let Some(args) = function.get("arguments") {
                if let Some(args) = args.as_str() {
                    acc.args.push_str(args);
                } else {
                    acc.args.push_str(&args.to_string());
                }
            }
        }
    }
}

struct OpenAiAdapter {
    /// Provider id, used for error messages (`"openai error: …"`). Owned
    /// because custom self-hosted providers have a runtime id.
    provider: String,
    /// The chat-completions endpoint. Owned because it comes from either
    /// the static registry (a `&'static str`, copied in) or a custom
    /// self-hosted provider (a runtime `String`).
    chat_url: String,
    /// Whether to include `tools` in the request body. MLX's local
    /// server doesn't honour them the same way; everyone else does.
    /// Comes from `OpenAiConfig::include_tools` in the registry.
    include_tools: bool,
    /// Whether to set `stream_options.include_usage`. The hosted OpenAI
    /// family honours it; local proxies may reject the field, so we
    /// leave it off there. Comes from `OpenAiConfig::include_usage_in_stream`.
    include_usage_in_stream: bool,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    key: Option<String>,
    reasoning_effort: Option<String>,
    usage: AiUsage,
}

impl StreamingProvider for OpenAiAdapter {
    type ToolAccumulator = Vec<OpenAiToolAcc>;

    fn name(&self) -> &str {
        &self.provider
    }

    fn build_request(&self, client: &reqwest::Client) -> Result<reqwest::RequestBuilder, String> {
        let mut body = openai_chat_body(
            &self.model,
            self.messages.clone(),
            self.tools.clone(),
            self.include_tools,
        );
        if let Some(effort) = &self.reasoning_effort {
            body["reasoning_effort"] = serde_json::Value::String(effort.clone());
        }
        if self.include_usage_in_stream {
            body["stream_options"] = serde_json::json!({ "include_usage": true });
        }
        let mut req = client.post(&self.chat_url).json(&body);
        if let Some(key) = &self.key {
            req = req.bearer_auth(key);
        }
        Ok(req)
    }

    fn parse_line(
        &mut self,
        line: &str,
        content: &mut String,
        thinking: &mut String,
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
        // Usage arrives on the final chunk (or a trailing choices-less chunk
        // when stream_options.include_usage is set). Parse it wherever it
        // appears — OpenRouter and Mistral attach it without being asked.
        if let Some(usage) = value.get("usage").filter(|u| u.is_object()) {
            let count = |k: &str| usage.get(k).and_then(|v| v.as_u64());
            if count("prompt_tokens").is_some() || count("completion_tokens").is_some() {
                self.usage = AiUsage {
                    prompt_tokens: count("prompt_tokens"),
                    completion_tokens: count("completion_tokens"),
                    eval_duration_ms: None,
                    prompt_eval_duration_ms: None,
                };
            }
        }
        let Some(choice) = value
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
        else {
            return Ok(());
        };
        let Some(delta) = choice.get("delta").or_else(|| choice.get("message")) else {
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
        // Reasoning models stream their chain-of-thought in a separate field,
        // not in `content`: `reasoning_content` (DeepSeek, vLLM, Ollama's
        // reasoning models) or `reasoning` (OpenRouter). Surface it on the
        // thinking channel so it streams live, just like Anthropic/Ollama.
        if let Some(r) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(|v| v.as_str())
        {
            if !r.is_empty() {
                thinking.push_str(r);
                on_chunk(StreamChunk {
                    content: String::new(),
                    thinking: r.to_string(),
                });
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            accumulate_openai_tool_calls(calls, tools);
        }
        Ok(())
    }

    fn finalize_response(
        self,
        content: String,
        reasoning: String,
        tools: Self::ToolAccumulator,
    ) -> AiChatResponse {
        // Two thinking sources: reasoning deltas streamed into a separate
        // field (`reasoning`), and inline `<think>…</think>` tags some models
        // emit inside `content`. Combine both.
        let (content, tag_thinking) = split_thinking_tags(&content);
        let mut thinking = reasoning;
        if !tag_thinking.trim().is_empty() {
            if !thinking.is_empty() {
                thinking.push('\n');
            }
            thinking.push_str(&tag_thinking);
        }
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
            usage: if self.usage.is_empty() {
                None
            } else {
                Some(self.usage)
            },
            // Hosted providers report finish_reason too, but the
            // num_ctx-truncation warning this drives is Ollama-specific.
            stop_reason: None,
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

/// Stream a chat completion over the OpenAI wire. The endpoint, the two
/// policy flags, and the (optional) bearer key are all resolved by the
/// caller (`ai_chat`) — from the static registry for built-in providers,
/// or from the custom-provider store for self-hosted ones. The adapter
/// itself stays oblivious to where the config came from.
pub(crate) async fn openai_compatible_chat(
    provider: String,
    chat_url: String,
    include_tools: bool,
    include_usage_in_stream: bool,
    key: Option<String>,
    reasoning_effort: Option<String>,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let adapter = OpenAiAdapter {
        provider,
        chat_url,
        include_tools,
        include_usage_in_stream,
        model,
        messages,
        tools,
        key,
        reasoning_effort,
        usage: AiUsage::default(),
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
                        // OpenAI wants `arguments` as a JSON-encoded string.
                        // Some models (esp. local ones over Ollama's OpenAI
                        // shim) emit a raw object, or stream truncated/invalid
                        // JSON — Ollama then 400s on the echo with "can't find
                        // closing '}'". Normalise to a string AND guarantee it
                        // parses, falling back to "{}" when the model produced
                        // junk, so one bad tool call can't kill the whole run.
                        let as_string = if let Some(s) = arguments.as_str() {
                            s.to_string()
                        } else {
                            arguments.to_string()
                        };
                        let valid = serde_json::from_str::<serde_json::Value>(&as_string).is_ok();
                        *arguments = serde_json::Value::String(if valid {
                            as_string
                        } else {
                            "{}".to_string()
                        });
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
    thinking_budget: Option<usize>,
    usage: AiUsage,
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
        if let Some(budget) = self.thinking_budget {
            body["thinking"] = serde_json::json!({
                "type": "enabled",
                "budget_tokens": budget,
            });
            body["max_tokens"] = serde_json::json!(budget.saturating_add(4096));
        }
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
        thinking: &mut String,
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
        // Token accounting: message_start carries usage.input_tokens, the
        // closing message_delta carries cumulative usage.output_tokens.
        if let Some(usage) = value
            .get("message")
            .and_then(|m| m.get("usage"))
            .or_else(|| value.get("usage"))
        {
            if let Some(n) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
                self.usage.prompt_tokens = Some(n);
            }
            if let Some(n) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                self.usage.completion_tokens = Some(n);
            }
        }
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
                    // Extended thinking streams as `thinking_delta` blocks.
                    Some("thinking_delta") => {
                        if let Some(t) = delta.get("thinking").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                thinking.push_str(t);
                                on_chunk(StreamChunk {
                                    content: String::new(),
                                    thinking: t.to_string(),
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
        self,
        content: String,
        thinking: String,
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
            thinking: if thinking.trim().is_empty() {
                None
            } else {
                Some(thinking)
            },
            tool_calls,
            usage: if self.usage.is_empty() {
                None
            } else {
                Some(self.usage)
            },
            // Anthropic reports stop_reason too, but this field drives the
            // Ollama-specific num_ctx-truncation warning. Left None for now.
            stop_reason: None,
        }
    }
}

pub(crate) async fn anthropic_chat(
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    reflection_level: Option<String>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let key = provider_key("anthropic")?.ok_or_else(|| "Missing API key".to_string())?;
    let thinking_budget = reflection_level_to_anthropic_budget(reflection_level.as_deref());
    let adapter = AnthropicAdapter {
        model,
        messages,
        tools,
        key,
        thinking_budget,
        usage: AiUsage::default(),
    };
    stream_provider(adapter, on_chunk).await
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

    #[test]
    fn retry_after_from_body_parses_openai_hint() {
        // The exact phrasing OpenAI's 429 uses.
        let s = Duration::from_millis(3353);
        assert_eq!(
            retry_after_from_body("Rate limit reached. Please try again in 3.353s. Visit…"),
            Some(s)
        );
        // Sub-second hints come back as milliseconds.
        assert_eq!(
            retry_after_from_body("try again in 412ms."),
            Some(Duration::from_millis(412))
        );
        // No hint → None, so the caller uses exponential backoff.
        assert_eq!(retry_after_from_body("some other error"), None);
    }

    #[test]
    fn working_num_ctx_uses_flat_default_grows_for_big_chats_and_caps_at_ceiling() {
        let msg = |s: &str| serde_json::json!({ "role": "user", "content": s });
        // Tiny chat → the flat comfortable working default, not a shrunk tier.
        assert_eq!(working_num_ctx(&[msg("hi")], None, 131_072), 32_768);
        // A conversation below the default still gets the full default.
        assert_eq!(
            working_num_ctx(&[msg(&"x".repeat(40_000))], None, 131_072),
            32_768
        );
        // A conversation larger than the default grows past it (≈130k chars ≈
        // 32.5k tokens + headroom).
        assert_eq!(
            working_num_ctx(&[msg(&"x".repeat(130_000))], None, 131_072),
            36_596
        );
        // The model's real window (or a user override that dials down) is the
        // hard cap — never exceeded, even for a default-sized request.
        assert_eq!(working_num_ctx(&[msg("hi")], None, 8192), 8192);
        // A huge conversation is still capped at the ceiling.
        assert_eq!(
            working_num_ctx(&[msg(&"x".repeat(500_000))], None, 16_384),
            16_384
        );
    }

    #[test]
    fn ollama_request_includes_context_and_reply_budget_options() {
        let adapter = OllamaAdapter {
            model: "test".to_string(),
            messages: vec![serde_json::json!({ "role": "user", "content": "hi" })],
            tools: None,
            num_ctx: Some(8192),
            num_predict: Some(1024),
            think: Some(true),
            usage: AiUsage::default(),
            stop_reason: None,
        };
        let request = adapter
            .build_request(&reqwest::Client::new())
            .unwrap()
            .build()
            .unwrap();
        let body = request.body().and_then(|b| b.as_bytes()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(value["options"]["num_ctx"], 8192);
        assert_eq!(value["options"]["num_predict"], 1024);
        assert_eq!(value["think"], true);
    }

    #[test]
    fn reflection_levels_map_to_ollama_think_flag() {
        assert_eq!(reflection_level_to_ollama_think(None), None);
        assert_eq!(reflection_level_to_ollama_think(Some("auto")), None);
        assert_eq!(
            reflection_level_to_ollama_think(Some("minimal")),
            Some(true)
        );
        assert_eq!(reflection_level_to_ollama_think(Some("low")), Some(true));
        assert_eq!(reflection_level_to_ollama_think(Some("medium")), Some(true));
        assert_eq!(reflection_level_to_ollama_think(Some("high")), Some(true));
        assert_eq!(reflection_level_to_ollama_think(Some("xhigh")), Some(true));
        assert_eq!(reflection_level_to_ollama_think(Some("surprise")), None);
        assert_eq!(reflection_level_to_openai_effort(None), None);
        assert_eq!(
            reflection_level_to_openai_effort(Some("minimal")).as_deref(),
            Some("minimal")
        );
        assert_eq!(
            reflection_level_to_openai_effort(Some("low")).as_deref(),
            Some("low")
        );
        assert_eq!(
            reflection_level_to_openai_effort(Some("medium")).as_deref(),
            Some("medium")
        );
        assert_eq!(
            reflection_level_to_openai_effort(Some("high")).as_deref(),
            Some("high")
        );
        assert_eq!(
            reflection_level_to_openai_effort(Some("xhigh")).as_deref(),
            Some("xhigh")
        );
        assert_eq!(reflection_level_to_anthropic_budget(None), None);
        assert_eq!(
            reflection_level_to_anthropic_budget(Some("minimal")),
            Some(1024)
        );
        assert_eq!(
            reflection_level_to_anthropic_budget(Some("low")),
            Some(2048)
        );
        assert_eq!(
            reflection_level_to_anthropic_budget(Some("medium")),
            Some(4096)
        );
        assert_eq!(
            reflection_level_to_anthropic_budget(Some("high")),
            Some(8192)
        );
        assert_eq!(
            reflection_level_to_anthropic_budget(Some("xhigh")),
            Some(16_384)
        );
        assert_eq!(
            reflection_level_to_openai_effort(Some("max")).as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            reflection_level_to_anthropic_budget(Some("max")),
            Some(16_384)
        );
    }

    #[test]
    fn tool_call_arguments_are_coerced_to_valid_json_strings() {
        // An object → JSON-encoded string; valid string → kept; invalid /
        // truncated JSON → "{}" so Ollama can't 400 the echo. This pins the
        // guard added after a local model streamed `{"analysis": …` (no close).
        let messages = vec![serde_json::json!({
            "role": "assistant",
            "tool_calls": [
                { "function": { "name": "a", "arguments": { "x": 1 } } },
                { "function": { "name": "b", "arguments": "{\"y\": 2}" } },
                { "function": { "name": "c", "arguments": "{\"z\": " } },
                { "function": { "name": "d", "arguments": "" } },
            ]
        })];
        let out = normalize_openai_messages(messages);
        let calls = out[0]["tool_calls"].as_array().unwrap();
        let arg = |i: usize| calls[i]["function"]["arguments"].as_str().unwrap();
        // Every arguments value is a string, and every string parses as JSON.
        for i in 0..4 {
            assert!(
                serde_json::from_str::<serde_json::Value>(arg(i)).is_ok(),
                "arg {i} not valid JSON: {}",
                arg(i)
            );
        }
        assert_eq!(arg(0), "{\"x\":1}");
        assert_eq!(arg(1), "{\"y\": 2}");
        assert_eq!(arg(2), "{}"); // truncated → fallback
        assert_eq!(arg(3), "{}"); // empty → fallback
    }
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
            num_ctx: None,
            num_predict: None,
            think: None,
            usage: AiUsage::default(),
            stop_reason: None,
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
            num_ctx: None,
            num_predict: None,
            think: None,
            usage: AiUsage::default(),
            stop_reason: None,
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
            chat_url: "https://api.openai.com/v1/chat/completions".to_string(),
            include_tools: true,
            include_usage_in_stream: true,
            model: "gpt-4.1".to_string(),
            messages: vec![],
            tools: None,
            key: Some("sk-test".to_string()),
            reasoning_effort: None,
            usage: AiUsage::default(),
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
        let response = adapter.finalize_response(content, thinking, tools);
        (
            response.content,
            response.thinking,
            response.tool_calls,
            rec.record(),
        )
    }

    #[test]
    fn openai_chat_body_omits_tools_when_include_tools_false() {
        let tools = vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": { "type": "object", "properties": {} },
            },
        })];
        let body = openai_chat_body(
            "mlx-community/Llama-3.1-8B-Instruct-4bit",
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
    fn openai_request_body_includes_reasoning_effort_when_configured() {
        let adapter = OpenAiAdapter {
            provider: "openai".to_string(),
            chat_url: "https://api.openai.com/v1/chat/completions".to_string(),
            include_tools: true,
            include_usage_in_stream: true,
            model: "gpt-5".to_string(),
            messages: vec![serde_json::json!({ "role": "user", "content": "hi" })],
            tools: None,
            key: Some("sk-test".to_string()),
            reasoning_effort: Some("high".to_string()),
            usage: AiUsage::default(),
        };
        let request = adapter
            .build_request(&reqwest::Client::new())
            .unwrap()
            .build()
            .unwrap();
        let body = request.body().and_then(|b| b.as_bytes()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(value["reasoning_effort"], "high");
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
    fn openai_streams_reasoning_content_as_thinking() {
        // Reasoning models (DeepSeek/vLLM/Ollama) put the chain-of-thought in
        // a separate `reasoning_content` field that must surface as thinking,
        // streamed live, while `content` stays the visible answer. The
        // `reasoning` alias (OpenRouter) is accepted too.
        let lines = [
            r#"data: {"choices":[{"delta":{"reasoning_content":"Let me "}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning":"think…"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"42"}}]}"#,
            r#"data: [DONE]"#,
        ];
        let (content, thinking, tools, chunks) = run_openai(&lines);
        assert_eq!(content, "42");
        assert_eq!(thinking.as_deref(), Some("Let me think…"));
        assert!(tools.is_empty());
        // Reasoning streams live on the thinking channel, separate from content.
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].thinking, "Let me ");
        assert_eq!(chunks[0].content, "");
        assert_eq!(chunks[2].content, "42");
        assert_eq!(chunks[2].thinking, "");
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
    fn openai_accepts_complete_message_tool_calls_from_local_servers() {
        // Some OpenAI-compatible local servers send a complete assistant
        // `message` chunk instead of streaming `delta.tool_calls`. MLX can
        // use this shape when it has already parsed a full tool call.
        let lines = [
            r#"data: {"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call_mlx_1","type":"function","function":{"name":"read_file","arguments":{"path":"src/App.tsx"}}},{"type":"function","function":{"name":"list_dir","arguments":{"path":"src"}}}]}}]}"#,
            r#"data: [DONE]"#,
        ];
        let (content, thinking, tools, chunks) = run_openai(&lines);
        assert!(content.is_empty());
        assert!(thinking.is_none());
        assert!(chunks.is_empty());
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["id"], "call_mlx_1");
        assert_eq!(tools[0]["function"]["name"], "read_file");
        assert_eq!(tools[1]["function"]["name"], "list_dir");
        let first_args: serde_json::Value =
            serde_json::from_str(tools[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        let second_args: serde_json::Value =
            serde_json::from_str(tools[1]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(first_args["path"], "src/App.tsx");
        assert_eq!(second_args["path"], "src");
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
            chat_url: "https://api.mistral.ai/v1/chat/completions".to_string(),
            include_tools: true,
            include_usage_in_stream: false,
            model: "mistral-large".to_string(),
            messages: vec![],
            tools: None,
            key: Some("k".to_string()),
            reasoning_effort: None,
            usage: AiUsage::default(),
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
            thinking_budget: None,
            usage: AiUsage::default(),
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
        let response = adapter.finalize_response(content, thinking, tools);
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
    fn anthropic_request_body_includes_thinking_budget_when_configured() {
        let adapter = AnthropicAdapter {
            model: "claude-sonnet-4-6".to_string(),
            messages: vec![serde_json::json!({ "role": "user", "content": "hi" })],
            tools: None,
            key: "sk-ant-test".to_string(),
            thinking_budget: Some(4096),
            usage: AiUsage::default(),
        };
        let request = adapter
            .build_request(&reqwest::Client::new())
            .unwrap()
            .build()
            .unwrap();
        let body = request.body().and_then(|b| b.as_bytes()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(value["thinking"]["type"], "enabled");
        assert_eq!(value["thinking"]["budget_tokens"], 4096);
        assert_eq!(value["max_tokens"], 8192);
    }

    #[test]
    fn anthropic_streams_thinking_delta_separate_from_text() {
        // Extended thinking arrives as `thinking_delta` blocks; they must
        // stream on the thinking channel, not pollute the visible content.
        let lines = [
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weigh "}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"options"}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];
        let (content, _tools, chunks) = run_anthropic(&lines);
        assert_eq!(content, "Done");
        let thinking: String = chunks.iter().map(|c| c.thinking.as_str()).collect();
        assert_eq!(thinking, "weigh options");
        let visible: String = chunks.iter().map(|c| c.content.as_str()).collect();
        assert_eq!(visible, "Done");
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
            thinking_budget: None,
            usage: AiUsage::default(),
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
        let adapter = AnthropicAdapter {
            model: "claude-sonnet-4-6".to_string(),
            messages: vec![],
            tools: None,
            key: "k".to_string(),
            thinking_budget: None,
            usage: AiUsage::default(),
        };
        let content = String::new();
        let thinking = String::new();
        let tools: Vec<AnthropicToolAcc> = vec![AnthropicToolAcc::default()];
        let response = adapter.finalize_response(content, thinking, tools);
        assert!(response.tool_calls.is_empty());
    }
}
