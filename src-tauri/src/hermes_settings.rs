//! Klide's Hermes backend selection. Credentials remain in the provider key
//! store and are resolved only in the process host, never in a spawn envelope.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const KEY_PROVIDER_ENV: &str = "KLIDE_HERMES_KEY_PROVIDER";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HermesSettings {
    pub provider: String,
    pub model: String,
}
impl HermesSettings {
    pub fn backend(&self) -> Result<(&'static str, &'static str), String> {
        match self.provider.as_str() {
            "deepseek" => Ok(("deepseek", "DEEPSEEK_API_KEY")),
            "openrouter" => Ok(("openrouter", "OPENROUTER_API_KEY")),
            "anthropic" => Ok(("anthropic", "ANTHROPIC_API_KEY")),
            "openai" => Ok(("openai-api", "OPENAI_API_KEY")),
            "codex" => Ok(("openai-codex", "")),
            "ollama" | "mlx" | "llamacpp" | "lmstudio" | "llamaapp" => {
                Ok(("openai", "OPENAI_API_KEY"))
            }
            "hermes-subscription:openai-codex" => Ok(("openai-codex", "")),
            "hermes-subscription:nous" => Ok(("nous", "")),
            "hermes-subscription:copilot" => Ok(("copilot", "")),
            id if id.starts_with("custom:") && crate::custom_providers::get(id).is_some() => {
                Ok(("openai", "OPENAI_API_KEY"))
            }
            id if crate::providers::lookup(id).is_some_and(|row| row.group == crate::providers::ProviderGroup::Hosted && matches!(row.wire, crate::providers::WireFormat::OpenAi(_))) => Ok(("openai", "OPENAI_API_KEY")),
            id if crate::delegate::lookup(id).is_some() || id.starts_with("cli:") => Err("This CLI runs its own agent loop. Using its subscription to power Hermes needs a model-endpoint bridge that is not implemented yet.".into()),
            _ => Err("Choose a supported Hermes intelligence source.".into()),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        self.backend()?;
        if self.model.trim().is_empty() || self.model.trim().eq_ignore_ascii_case("default") {
            return Err("Enter the model ID Hermes should use.".into());
        }
        Ok(())
    }
    pub fn args(&self, selected_model: Option<&str>) -> Result<Vec<String>, String> {
        self.validate()?;
        let mut args = vec!["--provider".into(), self.backend()?.0.into()];
        if selected_model
            .map(str::trim)
            .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("default"))
            .is_none()
        {
            args.extend(["--model".into(), self.model.clone()]);
        }
        Ok(args)
    }
}
fn path() -> Result<PathBuf, String> {
    crate::cli::home_dir_path()
        .map(|h| h.join(".klide/hermes.json"))
        .ok_or_else(|| "Cannot locate the Klide settings directory.".into())
}
fn read_at(path: &Path) -> Result<Option<HermesSettings>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Read Hermes settings: {e}")),
    };
    let settings: HermesSettings =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid Hermes settings: {e}"))?;
    settings.validate()?;
    Ok(Some(settings))
}
pub fn read() -> Result<Option<HermesSettings>, String> {
    read_at(&path()?)
}
pub fn save(mut settings: HermesSettings, key: Option<String>) -> Result<(), String> {
    settings.model = settings.model.trim().into();
    settings.validate()?;
    if let Some(key) = key.filter(|k| !k.trim().is_empty()) {
        crate::providers::set_keychain_key(&settings.provider, key.trim())?;
    }
    if matches!(
        settings.provider.as_str(),
        "deepseek" | "openrouter" | "anthropic" | "openai"
    ) && !crate::providers::key_status(&settings.provider)?.has_key
    {
        return Err("Add an API key here or in Settings → API before saving.".into());
    }
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    crate::durable::write_atomic(&path()?, &bytes)
}
pub fn clear() -> Result<(), String> {
    match std::fs::remove_file(path()?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Remove Hermes selection: {e}")),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSupport {
    pub supported: bool,
    pub reason: Option<String>,
}
pub fn source_support(provider: &str) -> SourceSupport {
    let settings = HermesSettings {
        provider: provider.into(),
        model: "probe".into(),
    };
    match settings.backend() {
        Ok(_) => SourceSupport {
            supported: true,
            reason: None,
        },
        Err(reason) => SourceSupport {
            supported: false,
            reason: Some(reason),
        },
    }
}

pub const MODEL_PREFIX: &str = "hermes-source:";
pub fn selection(model: Option<&str>) -> Result<Option<HermesSettings>, String> {
    if let Some(json) = model.and_then(|m| m.strip_prefix(MODEL_PREFIX)) {
        let settings: HermesSettings = serde_json::from_str(json)
            .map_err(|_| "Invalid Hermes model selection.".to_string())?;
        settings.validate()?;
        return Ok(Some(settings));
    }
    read()
}
pub fn model_value(model: &str) -> String {
    model
        .strip_prefix(MODEL_PREFIX)
        .and_then(|json| serde_json::from_str::<HermesSettings>(json).ok())
        .map(|s| s.model)
        .unwrap_or_else(|| model.into())
}
pub fn runtime_env(provider: &str, scope: Option<&Path>) -> Result<Vec<(String, String)>, String> {
    let settings = HermesSettings {
        provider: provider.into(),
        model: "unused".into(),
    };
    let (_, name) = settings.backend()?;
    if name.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(custom) = crate::custom_providers::get(provider) {
        let mut env = vec![("OPENAI_BASE_URL".into(), custom.base_url)];
        env.push((
            name.into(),
            crate::providers::custom_token(provider, scope)
                .unwrap_or_else(|| "no-key-required".into()),
        ));
        return Ok(env);
    }
    if let Some(row) = crate::providers::lookup(provider) {
        if row.group == crate::providers::ProviderGroup::Local {
            let url = match row.wire {
                crate::providers::WireFormat::Ollama => "http://127.0.0.1:11434/v1".to_string(),
                crate::providers::WireFormat::OpenAi(cfg) => cfg
                    .chat_url
                    .trim_end_matches("/chat/completions")
                    .to_string(),
                _ => return Err("Hermes requires an OpenAI-compatible local endpoint.".into()),
            };
            return Ok(vec![
                ("OPENAI_BASE_URL".into(), url),
                (name.into(), "no-key-required".into()),
            ]);
        }
    }
    let key = crate::providers::provider_key_in(provider, scope)?
        .ok_or_else(|| "No API key available for Hermes.".to_string())?;
    let mut env = vec![(name.into(), key)];
    if settings.backend()?.0 == "openai" {
        if let Some(row) = crate::providers::lookup(provider) {
            if let crate::providers::WireFormat::OpenAi(cfg) = row.wire {
                env.push((
                    "OPENAI_BASE_URL".into(),
                    cfg.chat_url.trim_end_matches("/chat/completions").into(),
                ));
            }
        }
    }
    Ok(env)
}
// Hermes deliberately lets its own .env override inherited process values.
// Refuse a conflicting launch rather than silently use a different key/URL.
pub fn check_environment_overrides(env: &[(String, String)]) -> Result<(), String> {
    let Some(adapter) = crate::delegate::lookup("hermes") else {
        return Ok(());
    };
    let Some(home) = adapter.config_home(&crate::delegate::ProcessEnv) else {
        return Ok(());
    };
    let path = home.join(".env");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Cannot inspect Hermes environment overrides: {e}")),
    };
    for line in text.lines() {
        let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
        if let Some((name, value)) = line.split_once('=') {
            if let Some((_, expected)) = env.iter().find(|(key, _)| key == name.trim()) {
                let value = value.trim().trim_matches(|c| c == '\'' || c == '"');
                if value != expected {
                    return Err(format!("{} overrides {name}. Update or remove that entry to use the intelligence source selected in Klide, or choose Configured default.", path.display()));
                }
            }
        }
    }
    Ok(())
}
pub fn cached_models() -> Option<Vec<String>> {
    read().ok().flatten().map(|s| vec![s.model])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn support_is_separate_from_the_shared_catalog() {
        for row in crate::providers::catalog()
            .iter()
            .filter(|row| row.group != crate::providers::ProviderGroup::Subscription)
        {
            assert!(source_support(row.id).supported, "{}", row.id);
        }
        assert!(source_support("codex").supported);
        for id in [
            "claude-code",
            "amp",
            "cursor",
            "factory",
            "hermes",
            "opencode",
            "omp",
        ] {
            let support = source_support(id);
            assert!(!support.supported);
            assert!(support.reason.unwrap().contains("bridge"));
        }
        assert_eq!(
            HermesSettings {
                provider: "mistral".into(),
                model: "mistral-test".into()
            }
            .backend()
            .unwrap(),
            ("openai", "OPENAI_API_KEY")
        );
    }
    #[test]
    fn api_backend_selection_and_model_override() {
        let s = HermesSettings {
            provider: "openai".into(),
            model: "gpt-test".into(),
        };
        assert_eq!(
            s.args(Some("default")).unwrap(),
            ["--provider", "openai-api", "--model", "gpt-test"]
        );
        assert_eq!(
            s.args(Some("another-model")).unwrap(),
            ["--provider", "openai-api"]
        );
        assert_eq!(s.backend().unwrap().1, "OPENAI_API_KEY");
        assert!(HermesSettings {
            provider: "nous".into(),
            model: "x".into()
        }
        .validate()
        .is_err());
        assert!(HermesSettings {
            provider: "deepseek".into(),
            model: "default".into()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn conversation_source_beats_global_defaults() {
        let selected = HermesSettings {
            provider: "ollama".into(),
            model: "qwen-test".into(),
        };
        let token = format!(
            "{MODEL_PREFIX}{}",
            serde_json::to_string(&selected).unwrap()
        );
        assert_eq!(selection(Some(&token)).unwrap(), Some(selected));
        assert_eq!(model_value(&token), "qwen-test");
        assert_eq!(
            runtime_env("ollama", None).unwrap()[0],
            ("OPENAI_BASE_URL".into(), "http://127.0.0.1:11434/v1".into())
        );
        let subscription = HermesSettings {
            provider: "hermes-subscription:openai-codex".into(),
            model: "account-model".into(),
        };
        assert_eq!(
            subscription.args(None).unwrap(),
            ["--provider", "openai-codex", "--model", "account-model"]
        );
        assert!(runtime_env(&subscription.provider, None)
            .unwrap()
            .is_empty());
        assert!(selection(Some("hermes-source:broken")).is_err());
    }
    #[test]
    fn settings_roundtrip_never_contains_a_secret() {
        let path =
            std::env::temp_dir().join(format!("hermes-settings-{}.json", std::process::id()));
        let s = HermesSettings {
            provider: "deepseek".into(),
            model: "deepseek-chat".into(),
        };
        crate::durable::write_atomic(&path, &serde_json::to_vec(&s).unwrap()).unwrap();
        assert_eq!(read_at(&path).unwrap(), Some(s));
        assert!(serde_json::from_str::<HermesSettings>(
            r#"{"provider":"deepseek","model":"m","apiKey":"secret"}"#
        )
        .is_err());
        std::fs::write(&path, "broken").unwrap();
        assert!(read_at(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
