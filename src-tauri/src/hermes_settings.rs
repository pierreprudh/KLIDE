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
// Hermes deliberately lets its own .env override inherited process values
// (`hermes_cli/env_loader.py` loads `~/.hermes/.env` with override=True).
// Refuse a conflicting launch rather than silently use a different key/URL.
pub fn check_environment_overrides(env: &[(String, String)]) -> Result<(), String> {
    match environment_overrides(env, None)?.into_iter().next() {
        Some(over) => Err(format!(
            "{} overrides {}. Settings → Hermes can align the two, or pick Hermes's configured source in the model picker.",
            over.path, over.name
        )),
        None => Ok(()),
    }
}
/// One variable Hermes's own `.env` sets to something other than what Klide
/// would pass for the selected source.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvOverride {
    pub name: String,
    /// The file, with the home directory shortened to `~`.
    pub path: String,
    /// The provider's own credential, which Klide could keep in its keychain.
    /// A base URL, the local-server placeholder, or Hermes's generic
    /// `OPENAI_API_KEY` slot standing in for another provider is not.
    pub importable: bool,
}
fn env_file() -> Option<PathBuf> {
    let adapter = crate::delegate::lookup("hermes")?;
    Some(adapter.config_home(&crate::delegate::ProcessEnv)?.join(".env"))
}
fn display_path(path: &Path) -> String {
    match crate::cli::home_dir_path().and_then(|h| path.strip_prefix(h).ok().map(|r| r.to_path_buf())) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}
/// `KEY=value` or `export KEY=value`; a commented line defines nothing.
fn env_line(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
    let (name, value) = line.split_once('=')?;
    let name = name.trim();
    if name.is_empty() || name.starts_with('#') {
        return None;
    }
    Some((name, value.trim().trim_matches(|c| c == '\'' || c == '"')))
}
/// The value each name ends up with — the last definition wins, as in dotenv.
fn effective_env(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, value) in text.lines().filter_map(env_line) {
        match out.iter_mut().find(|(n, _)| n == name) {
            Some(slot) => slot.1 = value.into(),
            None => out.push((name.into(), value.into())),
        }
    }
    out
}
fn overrides_in(text: &str, path: &str, env: &[(String, String)], importable: Option<&str>) -> Vec<EnvOverride> {
    let file = effective_env(text);
    env.iter()
        .filter(|(name, expected)| file.iter().any(|(n, v)| n == name && v != expected))
        .map(|(name, _)| EnvOverride {
            name: name.clone(),
            path: path.into(),
            importable: importable == Some(name.as_str()),
        })
        .collect()
}
pub fn environment_overrides(env: &[(String, String)], provider: Option<&str>) -> Result<Vec<EnvOverride>, String> {
    let Some(path) = env_file() else {
        return Ok(Vec::new());
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Cannot inspect Hermes environment overrides: {e}")),
    };
    Ok(overrides_in(&text, &display_path(&path), env, provider.and_then(importable_name)))
}
/// The variable whose value is this provider's own key — only where Hermes
/// names the provider in the slot, so an import never files one provider's
/// key under another.
fn importable_name(provider: &str) -> Option<&'static str> {
    if !matches!(provider, "deepseek" | "openrouter" | "anthropic" | "openai") {
        return None;
    }
    HermesSettings { provider: provider.into(), model: "probe".into() }
        .backend()
        .ok()
        .map(|(_, name)| name)
}
/// What Hermes's own `.env` would change about the selected source, for
/// Settings. Nothing to compare until Klide has a key for the provider.
pub fn overrides_for(provider: &str) -> Result<Vec<EnvOverride>, String> {
    HermesSettings { provider: provider.into(), model: "probe".into() }.backend()?;
    let Ok(env) = runtime_env(provider, None) else {
        return Ok(Vec::new());
    };
    environment_overrides(&env, Some(provider))
}
/// Whose value survives an alignment.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Keep {
    Hermes,
    Klide,
}
/// Make the two agree. `Keep::Hermes` stores the key from Hermes's `.env` in
/// Klide's keychain for the provider; `Keep::Klide` rewrites the conflicting
/// `.env` entries with the values Klide passes, so the terminal Hermes runs on
/// them too. Returns what still differs afterwards.
pub fn align_env(provider: &str, keep: Keep) -> Result<Vec<EnvOverride>, String> {
    let path = env_file().ok_or("Cannot locate Hermes's configuration directory.")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Read {}: {e}", display_path(&path)))?;
    match keep {
        Keep::Hermes => {
            let name = importable_name(provider).ok_or("This source has no key Klide could import.")?;
            let value = effective_env(&text)
                .into_iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v)
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| format!("{} does not set {name}.", display_path(&path)))?;
            crate::providers::set_keychain_key(provider, &value)?;
        }
        Keep::Klide => {
            let env = runtime_env(provider, None)?;
            let next = with_env_values(&text, &env);
            if next != text {
                // Hermes secures the file to 0600 on its own writes; so does this.
                crate::durable::write_atomic_private(&path, next.as_bytes())?;
            }
        }
    }
    overrides_for(provider)
}
/// Rewrite the lines that define a name in `values`, in place, the way
/// Hermes's own `save_env_value` does. A name the file never sets stays with
/// the process environment Klide passes.
fn with_env_values(text: &str, values: &[(String, String)]) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let rewritten = env_line(line)
            .and_then(|(name, _)| values.iter().find(|(key, _)| key == name))
            .map(|(name, value)| format!("{name}={}{}", quote_env(value), if line.ends_with('\n') { "\n" } else { "" }));
        out.push_str(rewritten.as_deref().unwrap_or(line));
    }
    out
}
fn quote_env(value: &str) -> String {
    if value.chars().any(|c| c.is_whitespace() || matches!(c, '#' | '"' | '\'' | '$')) {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
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
    fn env_file_overrides_are_read_by_effect_and_rewritten_in_place() {
        let text = "# OPENROUTER_API_KEY=commented\nexport OPENAI_BASE_URL=\"http://x\"\nOPENROUTER_API_KEY=old\nOPENROUTER_API_KEY='hermes-key'\nTERMINAL_TIMEOUT=60";
        let env = vec![
            ("OPENROUTER_API_KEY".to_string(), "klide-key".to_string()),
            ("OPENAI_BASE_URL".to_string(), "http://x".to_string()),
            ("OPENAI_API_KEY".to_string(), "no-key-required".to_string()),
        ];
        let found = overrides_in(text, "~/.hermes/.env", &env, Some("OPENROUTER_API_KEY"));
        assert_eq!(
            found,
            vec![EnvOverride { name: "OPENROUTER_API_KEY".into(), path: "~/.hermes/.env".into(), importable: true }]
        );
        assert!(!overrides_in(text, "p", &env, None)[0].importable);
        assert!(overrides_in(text, "p", &[("OPENROUTER_API_KEY".into(), "hermes-key".into())], None).is_empty());
        assert_eq!(effective_env(text).iter().find(|(n, _)| n == "OPENROUTER_API_KEY").unwrap().1, "hermes-key");
        let next = with_env_values(text, &env);
        assert_eq!(
            next,
            "# OPENROUTER_API_KEY=commented\nOPENAI_BASE_URL=http://x\nOPENROUTER_API_KEY=klide-key\nOPENROUTER_API_KEY=klide-key\nTERMINAL_TIMEOUT=60"
        );
        assert!(overrides_in(&next, "p", &env, None).is_empty());
        assert_eq!(quote_env("a b#c"), "\"a b#c\"");
        assert_eq!(importable_name("openrouter"), Some("OPENROUTER_API_KEY"));
        assert_eq!(importable_name("mistral"), None, "Hermes's generic OPENAI_API_KEY slot is not Mistral's key");
        assert_eq!(importable_name("ollama"), None);
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
