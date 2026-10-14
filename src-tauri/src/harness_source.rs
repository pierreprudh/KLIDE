//! Per-conversation intelligence routing, separate from the selected agent.
use serde::{Deserialize, Serialize};
pub const PREFIX: &str = "harness-source:";
pub const NOUS: &str = "hermes-subscription:nous";
pub const ENV: &str = "KLIDE_HARNESS_SOURCE";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub provider: String,
    pub model: String,
}
pub fn selection(model: &str) -> Result<Option<Selection>, String> {
    let Some(json) = model.strip_prefix(PREFIX) else {
        return Ok(None);
    };
    let value: Selection =
        serde_json::from_str(json).map_err(|_| "Invalid harness model selection.")?;
    if value.model.trim().is_empty()
        || value.model == "default"
        || !crate::source_endpoint::available(&value.provider)
    {
        return Err("Choose a valid intelligence source and model.".into());
    }
    Ok(Some(value))
}
pub fn intelligence(model: &str) -> Result<Option<Selection>, String> {
    if let Some(json) = model.strip_prefix(crate::hermes_settings::MODEL_PREFIX) {
        let settings: crate::hermes_settings::HermesSettings =
            serde_json::from_str(json).map_err(|_| "Invalid Hermes model selection.")?;
        settings.validate()?;
        return Ok(Some(Selection {
            provider: settings.provider,
            model: settings.model,
        }));
    }
    selection(model)
}
pub fn is_claude(model: &str) -> bool {
    model.starts_with("anthropic/claude-") || model.starts_with("claude-")
}
pub fn model_value(model: &str) -> Result<String, String> {
    Ok(selection(model)?
        .map(|s| s.model)
        .unwrap_or_else(|| model.into()))
}
pub fn support(harness: &str, provider: &str) -> crate::hermes_settings::SourceSupport {
    if harness == "hermes" {
        return crate::hermes_settings::source_support(provider);
    }
    let supported = (provider == harness && crate::delegate::lookup(harness).is_some())
        || (matches!(harness, "claude-code" | "opencode" | "codex")
            && crate::source_endpoint::available(provider));
    crate::hermes_settings::SourceSupport {
        supported,
        reason: (!supported).then(|| {
            "This intelligence source does not have an adapter for the selected harness yet.".into()
        }),
    }
}
/// Translate a saved source selection into the CLI's model reference.
pub fn cli_model(harness: &str, model: &str) -> Result<String, String> {
    let Some(source) = selection(model)? else {
        return Ok(model.into());
    };
    if !support(harness, &source.provider).supported {
        return Err("Unsupported harness/source combination.".into());
    }
    Ok(if harness == "opencode" {
        format!("klide-intelligence/{}", source.model)
    } else {
        source.model
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_is_validated_and_never_changes_the_harness() {
        let token = r#"harness-source:{"provider":"hermes-subscription:nous","model":"anthropic/claude-sonnet-4.6"}"#;
        assert_eq!(model_value(token).unwrap(), "anthropic/claude-sonnet-4.6");
        assert_eq!(model_value("sonnet").unwrap(), "sonnet");
        assert!(selection(&token.replace("claude-sonnet-4.6", "gpt-test")).is_ok());
        assert!(selection(&token.replace("hermes-subscription:nous", "codex")).is_err());
        assert!(selection("harness-source:broken").is_err());
        assert!(support("claude-code", NOUS).supported);
        assert!(!support("claude-code", "codex").supported);
        for harness in ["claude-code", "opencode", "codex"] {
            for id in [
                "openai",
                "anthropic",
                "deepseek",
                "openrouter",
                "ollama",
                NOUS,
            ] {
                assert!(support(harness, id).supported, "{harness}: {id}");
            }
        }
    }
}
