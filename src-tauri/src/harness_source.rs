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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
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
    if value.effort.as_deref().is_some_and(|level| !EFFORT_LEVELS.contains(&level)) {
        return Err("Invalid reasoning effort.".into());
    }
    if value.effort.is_some() && !effort_source(&value.provider) {
        return Err("This intelligence source does not expose a supported effort control.".into());
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
            effort: None,
        }));
    }
    selection(model)
}
pub const EFFORT_LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

fn effort_source(provider: &str) -> bool {
    provider == NOUS || provider == "anthropic" || crate::providers::lookup(provider).is_some_and(|row|
        matches!(row.wire, crate::providers::WireFormat::OpenAi(config) if config.supports_reasoning_effort))
}

pub(crate) fn gateway_efforts(row: &serde_json::Value) -> Option<Vec<String>> {
    if let Some(params) = row.get("supported_parameters").and_then(serde_json::Value::as_array) {
        if !params.iter().any(|p| p == "reasoning" || p == "reasoning_effort") { return Some(vec![]); }
    }
    let reasoning = row.get("reasoning");
    let advertised = reasoning.and_then(|r| r.get("supported_efforts"));
    let mut levels = if let Some(values) = advertised.and_then(serde_json::Value::as_array) {
        values.iter().filter_map(|v| v.as_str()).filter(|level| EFFORT_LEVELS.contains(level)).map(str::to_string).collect::<Vec<_>>()
    } else if advertised.is_some_and(serde_json::Value::is_null) {
        EFFORT_LEVELS.iter().filter(|s| **s != "ultra").map(|s| s.to_string()).collect()
    } else {
        return None;
    };
    if reasoning.is_some_and(|r| r["mandatory"] == true) { levels.retain(|l| l != "none"); }
    Some(levels)
}

/// A per-launch selection: the saved model identity remains independent of effort.
pub fn with_effort(model: &str, effort: Option<&str>) -> Result<String, String> {
    let Some(mut source) = selection(model)? else { return Ok(model.into()); };
    source.effort = effort.map(str::trim).filter(|s| !s.is_empty() && *s != "auto").map(str::to_string);
    let encoded = format!("{PREFIX}{}", serde_json::to_string(&source).map_err(|e| e.to_string())?);
    selection(&encoded)?;
    Ok(encoded)
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
    #[test]
    fn effort_is_per_launch_and_does_not_change_the_model() {
        let model = r#"harness-source:{"provider":"openrouter","model":"openai/gpt-test"}"#;
        let high = with_effort(model, Some("high")).unwrap();
        assert_eq!(selection(&high).unwrap().unwrap().effort.as_deref(), Some("high"));
        assert_eq!(cli_model("opencode", &high).unwrap(), "klide-intelligence/openai/gpt-test");
        assert_eq!(with_effort(&high, None).unwrap(), model);
        assert_eq!(with_effort("sonnet", Some("high")).unwrap(), "sonnet");
        assert!(with_effort(model, Some("unlimited")).is_err());
        assert!(with_effort(&model.replace("openrouter", "ollama"), Some("high")).is_err());
    }
    #[test]
    fn gateway_catalog_controls_the_effort_choices() {
        use serde_json::json;
        assert_eq!(gateway_efforts(&json!({"supported_parameters":["tools"]})), Some(vec![]));
        assert_eq!(gateway_efforts(&json!({"reasoning":{"supported_efforts":["low","high","bogus"]}})), Some(vec!["low".into(),"high".into()]));
        let levels = gateway_efforts(&json!({"reasoning":{"supported_efforts":null,"mandatory":true}})).unwrap();
        assert!(!levels.contains(&"none".into()));
        assert!(!levels.contains(&"ultra".into()));
        assert!(gateway_efforts(&json!({})).is_none());
    }
}
