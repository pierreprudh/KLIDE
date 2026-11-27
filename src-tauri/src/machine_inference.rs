//! Explicit destination-side API credentials; secrets never enter the frontend.
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_MODEL: &str = "deepseek/deepseek-v4.1-flash-1017";
pub const CAPABILITY: &str = "remote-openrouter";
/// A host that runs Kit on, and routes Claude Code to, any authorized API.
pub const API_CAPABILITY: &str = "remote-api";
pub const KEY_PATH: &str = "~/.klide/remote-api/openrouter/api-key";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteInference {
    pub provider: String,
    pub model: String,
}
impl Default for RemoteInference {
    fn default() -> Self { Self { provider: "openrouter".into(), model: DEFAULT_MODEL.into() } }
}
impl RemoteInference {
    pub fn validate(&self) -> Result<(), String> {
        if self.provider != "openrouter" || self.model.trim().is_empty() || self.model.trim() != self.model || self.model.len() > 256 || self.model.chars().any(char::is_control) || self.model == "default" {
            return Err("Choose OpenRouter and a valid model ID.".into());
        }
        Ok(())
    }
    pub fn selected_model(&self) -> Result<String, String> {
        self.validate()?;
        Ok(format!("{}{}", crate::harness_source::PREFIX, serde_json::to_string(&crate::harness_source::Selection { provider: self.provider.clone(), model: self.model.clone(), effort: None }).map_err(|e| e.to_string())?))
    }
}

/// The hosted APIs a remote machine can hold a key for: a builtin keyed row
/// whose key is a plain secret and whose URL needs nothing from this Mac. Subscription CLIs keep their own login, local
/// servers need none, and a token command (Vertex's gcloud) runs only here.
pub fn remote_api_provider(id: &str) -> bool {
    crate::providers::lookup(id).is_some_and(|entry| {
        entry.group == crate::providers::ProviderGroup::Hosted
            && matches!(entry.key, crate::providers::KeySource::Hosted { token_command: None, .. })
            // An account-scoped URL (Azure resource, AWS region…) is filled from
            // this Mac's settings, which the machine does not have.
            && !matches!(entry.wire, crate::providers::WireFormat::OpenAi(cfg) if cfg.chat_url.contains("${"))
    })
}

fn provider_dir(provider: &str) -> Result<String, String> {
    if !remote_api_provider(provider) { return Err(format!("{provider} keys cannot be authorized on a remote machine")); }
    Ok(format!(".klide/remote-api/{provider}"))
}

/// Ready when the machine can run *something*: Claude Code on its login, or
/// Kit / a routed Claude Code on at least one authorized API key.
pub fn credential_ready(cli_installed: bool, claude_logged_in: bool, api_keys: &[String]) -> bool {
    (cli_installed && claude_logged_in) || !api_keys.is_empty()
}

pub(crate) fn destination_key(path: &Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read the destination API key file.".into()),
    };
    if !metadata.file_type().is_file() || metadata.len() > 16384 { return Err("The destination API key must be a regular private file.".into()); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 { return Err("The destination API key file must have mode 600.".into()); }
    }
    let key = std::fs::read_to_string(path).map_err(|_| "Cannot read the destination API key file.")?;
    let key = key.trim();
    if key.is_empty() || key.len() > 16384 || key.chars().any(char::is_control) { return Err("The destination API key file is invalid.".into()); }
    Ok(Some(key.into()))
}

/// The key this machine was given for `provider`, read fresh per request.
pub fn configured_key_for(provider: &str) -> Result<Option<String>, String> {
    if !remote_api_provider(provider) { return Ok(None); }
    let Some(home) = crate::cli::home_dir_path() else { return Ok(None); };
    profile_key(&home.join(provider_dir(provider)?).join("api-key"))
}

/// OpenRouter's key — kept for hosts probed by `openrouter-status`.
pub fn configured_key() -> Result<Option<String>, String> { configured_key_for("openrouter") }

/// Every provider with a usable key on this machine, for the setup probe.
pub fn configured_providers() -> Vec<String> {
    crate::providers::PROVIDERS.iter().map(|entry| entry.id)
        .filter(|id| remote_api_provider(id) && configured_key_for(id).ok().flatten().is_some())
        .map(String::from).collect()
}

fn profile_key(path: &Path) -> Result<Option<String>, String> {
    let key = destination_key(path)?;
    if key.is_none() && path.parent().is_some_and(Path::is_dir) {
        return Err("The authorized API key is missing. Authorize it again in Settings → Machines.".into());
    }
    Ok(key)
}

#[derive(Serialize)]
pub struct KeyOption { id: String, label: String }

/// The keys this Mac holds for `provider` that may be sent to a machine.
#[tauri::command]
pub async fn machine_api_keys(provider: String) -> Result<Vec<KeyOption>, String> {
    crate::blocking::run(move || {
        provider_dir(&provider)?;
        let mut keys = Vec::new();
        if crate::providers::key_status(&provider)?.has_key {
            keys.push(KeyOption { id: "configured".into(), label: "Current key".into() });
        }
        keys.extend(crate::provider_keys::list(&provider).keys.into_iter().map(|key| KeyOption { id: key.id, label: key.label }));
        Ok(keys)
    }).await
}

/// Send one explicitly chosen key to the machine over SSH stdin. It lands in
/// `~/.klide/remote-api/<provider>/api-key` (dir 700, file 600) and replaces
/// whatever that worker account held for the provider.
#[tauri::command]
pub async fn machine_api_authorize(id: String, provider: String, key_id: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let dir = provider_dir(&provider)?;
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        if crate::machine_install::detect_target(&machine.ssh_host)?.os == crate::remote_platform::HostOs::Windows {
            return Err("API key setup currently supports Linux and macOS machines.".into());
        }
        let key = if key_id == "configured" { crate::providers::provider_key(&provider)?.ok_or("No key is configured for this provider")? }
            else { crate::provider_keys::resolve_saved(&provider, &key_id)? };
        // `dir` is built from a registry id (letters, digits, hyphens), never user text.
        let script = format!(r#"set -eu
umask 077
p="$HOME/{dir}"
mkdir -p "$p"
chmod 700 "$HOME/.klide/remote-api" "$p"
t=$(mktemp "$p/.api-key.XXXXXX")
trap 'rm -f "$t"' EXIT HUP INT TERM
cat > "$t"
test -s "$t"
chmod 600 "$t"
mv -f "$t" "$p/api-key"
"#);
        crate::machine_install::ssh_input(&machine.ssh_host, &script, key.into_bytes())?;
        Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_machine_is_ready_on_a_claude_login_or_any_authorized_key() {
        assert!(credential_ready(true, true, &[]));
        assert!(credential_ready(false, false, &["deepseek".into()]));
        assert!(!credential_ready(true, false, &[]));
    }
    #[test]
    fn only_plain_keyed_hosted_apis_can_be_sent_to_a_machine() {
        for id in ["openrouter", "anthropic", "openai", "deepseek", "mistral"] { assert!(remote_api_provider(id), "{id}"); }
        for id in ["claude-code", "codex", "ollama", "mlx", "google-vertex", "azure", "nope", "../x"] { assert!(!remote_api_provider(id), "{id}"); }
    }
    #[test]
    fn destination_key_is_read_fresh_and_never_silently_falls_back_after_invalid_configuration() {
        let root = std::env::temp_dir().join(format!("klide-destination-key-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("api-key");
        assert_eq!(destination_key(&path).unwrap(), None);
        std::fs::write(&path, "first-test-key").unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap(); }
        assert_eq!(destination_key(&path).unwrap().as_deref(), Some("first-test-key"));
        std::fs::write(&path, "second-test-key").unwrap();
        assert_eq!(destination_key(&path).unwrap().as_deref(), Some("second-test-key"));
        std::fs::write(&path, "").unwrap();
        assert!(destination_key(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(profile_key(&path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
