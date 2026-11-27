//! Explicit destination-side API credentials; secrets never enter the frontend.
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_MODEL: &str = "deepseek/deepseek-v4.1-flash-1017";
pub const CAPABILITY: &str = "remote-openrouter";
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

pub fn credential_ready(inference: Option<&RemoteInference>, cli_installed: bool, claude_logged_in: bool, api_configured: bool) -> bool {
    cli_installed && if inference.is_some() { api_configured } else { claude_logged_in }
}

pub(crate) fn destination_key(path: &Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read the destination OpenRouter key file.".into()),
    };
    if !metadata.file_type().is_file() || metadata.len() > 16384 { return Err("The destination OpenRouter key must be a regular private file.".into()); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 { return Err("The destination OpenRouter key file must have mode 600.".into()); }
    }
    let key = std::fs::read_to_string(path).map_err(|_| "Cannot read the destination OpenRouter key file.")?;
    let key = key.trim();
    if key.is_empty() || key.len() > 16384 || key.chars().any(char::is_control) { return Err("The destination OpenRouter key file is invalid.".into()); }
    Ok(Some(key.into()))
}

pub fn configured_key() -> Result<Option<String>, String> {
    let Some(home) = crate::cli::home_dir_path() else { return Ok(None); };
    let path = home.join(KEY_PATH.trim_start_matches("~/"));
    profile_key(&path)
}

fn profile_key(path: &Path) -> Result<Option<String>, String> {
    let key = destination_key(path)?;
    if key.is_none() && path.parent().is_some_and(Path::is_dir) {
        return Err("The authorized OpenRouter key is missing. Authorize it again in Machines.".into());
    }
    Ok(key)
}

#[derive(Serialize)]
pub struct KeyOption { id: String, label: String }

#[tauri::command]
pub async fn machine_openrouter_keys() -> Result<Vec<KeyOption>, String> {
    crate::blocking::run(|| {
        let mut keys = Vec::new();
        if crate::providers::key_status("openrouter")?.has_key {
            keys.push(KeyOption { id: "configured".into(), label: "Current OpenRouter key".into() });
        }
        keys.extend(crate::provider_keys::list("openrouter").keys.into_iter().map(|key| KeyOption { id: key.id, label: key.label }));
        Ok(keys)
    }).await
}

#[tauri::command]
pub async fn machine_openrouter_authorize(id: String, key_id: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        machine.inference.as_ref().ok_or("Select OpenRouter before authorizing a key")?.validate()?;
        if crate::machine_install::detect_target(&machine.ssh_host)?.os == crate::remote_platform::HostOs::Windows {
            return Err("OpenRouter key setup currently supports Linux and macOS machines.".into());
        }
        let key = if key_id == "configured" { crate::providers::provider_key("openrouter")?.ok_or("No OpenRouter key is configured")? }
            else { crate::provider_keys::resolve_saved("openrouter", &key_id)? };
        let script = r#"set -eu
umask 077
p="$HOME/.klide/remote-api/openrouter"
mkdir -p "$p"
chmod 700 "$p"
t=$(mktemp "$p/.api-key.XXXXXX")
trap 'rm -f "$t"' EXIT HUP INT TERM
cat > "$t"
test -s "$t"
chmod 600 "$t"
mv -f "$t" "$p/api-key"
"#;
        crate::machine_install::ssh_input(&machine.ssh_host, script, key.into_bytes())?;
        Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn api_credentials_replace_subscription_login_without_bypassing_authorization() {
        let api = RemoteInference { provider: "openrouter".into(), model: DEFAULT_MODEL.into() };
        assert!(credential_ready(Some(&api), true, false, true));
        assert!(!credential_ready(Some(&api), true, true, false));
        assert!(!credential_ready(Some(&api), false, false, true));
        assert!(!credential_ready(None, true, false, true));
        assert!(credential_ready(None, true, true, false));
        let selected = crate::harness_source::selection(&api.selected_model().unwrap()).unwrap().unwrap();
        assert_eq!(selected.provider, "openrouter");
        assert_eq!(selected.model, DEFAULT_MODEL);
    }
    #[test]
    fn selection_rejects_unsupported_and_empty_models() {
        for (provider, model) in [("anthropic", "x"), ("openrouter", ""), ("openrouter", "default"), ("openrouter", "x\ny")] {
            assert!(RemoteInference { provider: provider.into(), model: model.into() }.validate().is_err());
        }
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
