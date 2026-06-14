//! Custom (self-hosted) provider store — the runtime sibling of the
//! compile-time `providers::PROVIDERS` registry.
//!
//! The built-in registry is a `const` array of `&'static str` URLs: it
//! can't hold a URL the user types at runtime. So user-added endpoints
//! ("bring your own datacenter" — any OpenAI-compatible server behind a
//! URL like `https://llm.example.com/v1`) live here instead, persisted
//! as JSON in `~/.klide/custom_providers.json`.
//!
//! Only **non-secret** config lives in this file (label, base URL,
//! default model). The bearer token stays in the macOS Keychain, keyed
//! by the provider id — the same store the built-in hosted providers
//! use (`providers::set_keychain_key`). That keeps the "no API keys
//! outside the keychain" rule intact.
//!
//! Every custom id is prefixed `custom:` so it can never collide with a
//! built-in registry id, and so `ai_chat`/`ai_provider_models` can fall
//! through to this store only when `providers::lookup` misses.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The id prefix that marks a provider as custom (self-hosted). Enforced
/// on `upsert` so the dispatch fall-through stays unambiguous.
pub const CUSTOM_ID_PREFIX: &str = "custom:";

/// One self-hosted OpenAI-compatible endpoint. Mirrors the frontend's
/// `CustomProvider` type; `serde(rename_all = "camelCase")` matches the
/// JS field names over the IPC boundary.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    /// Unique id, e.g. `custom:my-gateway`. Doubles as the keychain key.
    pub id: String,
    /// Human-readable name shown in the model picker ("My Gateway").
    pub label: String,
    /// OpenAI-compatible base URL, e.g. `https://llm.example.com/v1`.
    /// Trailing slashes are tolerated; the `*_url` helpers normalise.
    pub base_url: String,
    /// Model id pre-selected when this provider is first chosen.
    #[serde(default)]
    pub default_model: String,
    /// Optional `${VAR}` reference resolved from the process environment or
    /// `~/.klide/.env` instead of the keychain. When set, the keychain is
    /// never consulted for this provider — so reading the token triggers no
    /// macOS prompt. The reference string itself is not a secret, so it is
    /// safe to persist here in plain JSON; the value stays in the `.env`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_ref: Option<String>,
}

impl CustomProvider {
    /// `{base_url}/chat/completions`, trailing slash on the base tolerated.
    pub fn chat_url(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }

    /// `{base_url}/models`, trailing slash on the base tolerated.
    pub fn models_url(&self) -> String {
        format!("{}/models", self.base_url.trim_end_matches('/'))
    }
}

/// `~/.klide/custom_providers.json`. Same `~/.klide` home the skills
/// loader uses for global (non-workspace) Klide config.
fn store_path() -> Option<PathBuf> {
    crate::home_dir_path().map(|home| home.join(".klide").join("custom_providers.json"))
}

/// Read the store. A missing or unreadable file is "no custom providers",
/// not an error — the feature is opt-in and the file only exists once the
/// user adds one.
pub fn list() -> Vec<CustomProvider> {
    let Some(path) = store_path() else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Look up a single custom provider by id. `None` when it isn't one.
pub fn get(id: &str) -> Option<CustomProvider> {
    list().into_iter().find(|p| p.id == id)
}

fn write_all(providers: &[CustomProvider]) -> Result<(), String> {
    let path = store_path().ok_or_else(|| "Could not resolve home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {parent:?}: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(providers).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write {path:?}: {e}"))
}

/// Insert or replace a custom provider (matched by id). Validates the
/// id prefix and that label / base URL are non-empty so the dispatch and
/// the UI never have to defend against half-formed rows.
pub fn upsert(mut provider: CustomProvider) -> Result<(), String> {
    provider.id = provider.id.trim().to_string();
    provider.label = provider.label.trim().to_string();
    provider.base_url = provider.base_url.trim().to_string();
    provider.default_model = provider.default_model.trim().to_string();
    provider.token_ref = provider
        .token_ref
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty());

    if !provider.id.starts_with(CUSTOM_ID_PREFIX) {
        return Err(format!("Custom provider id must start with \"{CUSTOM_ID_PREFIX}\""));
    }
    if provider.label.is_empty() {
        return Err("Label is required".to_string());
    }
    if !provider.base_url.starts_with("http://") && !provider.base_url.starts_with("https://") {
        return Err("Base URL must start with http:// or https://".to_string());
    }

    let mut all = list();
    match all.iter_mut().find(|p| p.id == provider.id) {
        Some(existing) => *existing = provider,
        None => all.push(provider),
    }
    write_all(&all)
}

/// Remove a custom provider by id. Idempotent — removing an absent id is
/// a no-op success. The caller (the `custom_provider_remove` command)
/// also clears the keychain token.
pub fn remove(id: &str) -> Result<(), String> {
    let mut all = list();
    let before = all.len();
    all.retain(|p| p.id != id);
    if all.len() == before {
        return Ok(());
    }
    write_all(&all)
}
