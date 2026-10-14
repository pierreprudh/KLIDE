//! Source URL and wire metadata are independent of an agent harness.
//! Credentials are resolved per request in the process host, never persisted.
use crate::providers::{ProviderGroup, WireFormat};
use std::path::Path;
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    Chat,
    Anthropic,
    Responses,
}
pub struct Endpoint {
    pub base: String,
    pub key: Option<String>,
    pub wire: Wire,
    pub stream_usage: bool,
}
pub fn available(id: &str) -> bool {
    id == crate::harness_source::NOUS
        || crate::custom_providers::get(id).is_some()
        || crate::providers::lookup(id).is_some_and(|row| row.group != ProviderGroup::Subscription)
}
pub fn resolve(id: &str, scope: Option<&Path>) -> Result<Endpoint, String> {
    if id == crate::harness_source::NOUS {
        return Ok(Endpoint {
            base: crate::claude_nous_bridge::proxy_endpoint()?,
            key: Some("klide-proxy".into()),
            wire: Wire::Chat,
            stream_usage: true,
        });
    }
    if let Some(custom) = crate::custom_providers::get(id) {
        return Ok(Endpoint {
            base: custom.base_url.trim_end_matches('/').into(),
            key: crate::providers::custom_token(id, scope),
            wire: Wire::Chat,
            stream_usage: false,
        });
    }
    let row = crate::providers::lookup(id)
        .filter(|row| row.group != ProviderGroup::Subscription)
        .ok_or("This source has no model inference endpoint.")?;
    let key = if row.group == ProviderGroup::Local {
        None
    } else {
        Some(
            crate::providers::provider_key_in(id, scope)?
                .ok_or_else(|| format!("Add the {} API key in Settings → API.", row.label))?,
        )
    };
    let (base, wire, stream_usage) = match row.wire {
        WireFormat::Anthropic => (
            "https://api.anthropic.com/v1".into(),
            Wire::Anthropic,
            false,
        ),
        WireFormat::Ollama => ("http://127.0.0.1:11434/v1".into(), Wire::Chat, false),
        WireFormat::OpenAi(cfg) => (
            cfg.chat_url.trim_end_matches("/chat/completions").into(),
            if id == "openai" {
                Wire::Responses
            } else {
                Wire::Chat
            },
            cfg.include_usage_in_stream,
        ),
    };
    Ok(Endpoint {
        base,
        key,
        wire,
        stream_usage,
    })
}
