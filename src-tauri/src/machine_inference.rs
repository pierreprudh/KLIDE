//! Explicit destination-side API credentials; secrets never enter the frontend.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

pub const DEFAULT_MODEL: &str = "deepseek/deepseek-v4.1-flash-1017";
pub const CAPABILITY: &str = "remote-openrouter";
/// A host that runs Kit on, and routes Claude Code to, any authorized API.
pub const API_CAPABILITY: &str = "remote-api";
/// A host that takes the Mac's whole key set (`ptyd sync-keys`) behind the
/// secret wall (`secret_wall.rs`).
pub const SYNC_CAPABILITY: &str = "key-sync";
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

// ── Key sync ─────────────────────────────────────────────────────────────
//
// The machine's keys are a copy of the Mac's: the Mac sends its whole set of
// remote-capable keys, the host replaces what it holds with exactly that set
// (a key deleted on the Mac is deleted there), and answers with a manifest of
// names and fingerprints — never a value — so the Mac can tell "in sync" from
// "3 changes" without reading a secret back.

/// Provider id → fingerprint of the key the machine holds.
pub type Manifest = BTreeMap<String, String>;

/// A short, one-way name for a key: enough to compare, useless to call an API.
pub fn fingerprint(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// What this machine holds now (host side).
pub fn manifest() -> Manifest {
    configured_providers().into_iter()
        .filter_map(|id| configured_key_for(&id).ok().flatten().map(|key| (id, fingerprint(&key))))
        .collect()
}

#[derive(Serialize, Deserialize)]
struct Bundle { version: u32, keys: BTreeMap<String, String> }
const BUNDLE_VERSION: u32 = 1;

/// `klide ptyd sync-keys`: the bundle on stdin, the manifest on stdout.
pub fn sync_main() -> i32 {
    use std::io::Read;
    let mut input = String::new();
    if std::io::stdin().take(1 << 20).read_to_string(&mut input).is_err() { eprintln!("Could not read the key bundle"); return 1; }
    let result = serde_json::from_str::<Bundle>(&input).map_err(|_| "The key bundle is not valid".to_string())
        .and_then(|bundle| {
            if bundle.version != BUNDLE_VERSION { return Err("This helper does not understand the key bundle; update it in Settings → Machines".into()); }
            let home = crate::cli::home_dir_path().ok_or("No home directory")?;
            // Revoking everything needs no wall; storing a key does.
            if !bundle.keys.is_empty() { crate::secret_wall::check().map_err(|_| crate::secret_wall::REFUSED.to_string())?; }
            apply_sync(&home, &bundle.keys)
        });
    match result {
        Ok(manifest) => { println!("{}", serde_json::to_string(&manifest).unwrap_or_default()); 0 }
        Err(error) => { eprintln!("{error}"); 1 }
    }
}

/// Replace the keys under `home` with exactly `keys`. Every value is checked
/// before anything is written, so an invalid bundle changes nothing; a disk
/// error midway can leave part of it, which the next check pushes again.
fn apply_sync(home: &Path, keys: &BTreeMap<String, String>) -> Result<Manifest, String> {
    for (provider, key) in keys {
        provider_dir(provider)?;
        if key.trim().is_empty() || key.len() > 16384 || key.chars().any(char::is_control) { return Err(format!("The {provider} key is not valid")); }
    }
    let root = home.join(".klide/remote-api");
    private_dir(&home.join(".klide"))?;
    private_dir(&root)?;
    for (provider, key) in keys {
        let dir = home.join(provider_dir(provider)?);
        private_dir(&dir)?;
        crate::durable::write_atomic_private(&dir.join("api-key"), key.trim().as_bytes())?;
    }
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !keys.contains_key(&name) { std::fs::remove_dir_all(entry.path()).map_err(|e| format!("Could not remove the {name} key: {e}"))?; }
    }
    Ok(keys.iter().map(|(provider, key)| (provider.clone(), fingerprint(key.trim()))).collect())
}

fn private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        if !dir.exists() { std::fs::DirBuilder::new().mode(0o700).create(dir).map_err(|e| e.to_string())?; }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    { std::fs::create_dir_all(dir).map_err(|e| e.to_string()) }
}

/// Every remote-capable key this Mac holds (Mac side). A key that is set but
/// can't be read right now (a locked Keychain, an unresolved `${VAR}`) fails
/// the whole set: sync replaces the machine's keys, so leaving it out would
/// delete it there.
pub fn local_keys() -> Result<BTreeMap<String, String>, String> {
    let mut keys = BTreeMap::new();
    for id in crate::providers::PROVIDERS.iter().map(|entry| entry.id).filter(|id| remote_api_provider(id)) {
        if !crate::providers::key_status(id).is_ok_and(|status| status.has_key) { continue; }
        match crate::providers::provider_key(id) {
            Ok(Some(key)) => { keys.insert(id.to_string(), key); }
            Ok(None) => {}
            Err(error) => return Err(format!("Could not read the {id} key on this Mac ({error}); nothing was synced")),
        }
    }
    Ok(keys)
}

/// Which providers differ between this Mac and a machine's manifest.
pub fn pending(local: &BTreeMap<String, String>, remote: &Manifest) -> Vec<String> {
    let mut ids: Vec<String> = local.iter().filter(|(id, key)| remote.get(*id) != Some(&fingerprint(key.trim()))).map(|(id, _)| id.clone()).collect();
    ids.extend(remote.keys().filter(|id| !local.contains_key(*id)).cloned());
    ids.sort(); ids.dedup();
    ids
}

/// Push `keys` (the whole set; empty revokes all) to `ssh_host`.
pub(crate) fn push(ssh_host: &str, keys: BTreeMap<String, String>) -> Result<Manifest, String> {
    let bundle = serde_json::to_vec(&Bundle { version: BUNDLE_VERSION, keys }).map_err(|e| e.to_string())?;
    let out = crate::machine_install::ssh_input(ssh_host, r#""$HOME/.klide/bin/klide" ptyd sync-keys"#, bundle)?;
    // The manifest is the last line: a login banner may come first.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("");
    serde_json::from_str(last.trim()).map_err(|_| "The machine did not confirm its keys".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult { synced: Vec<String> }

/// Turn key sync on (push this Mac's keys now) or off (remove every key Klide
/// put on the machine). Either way the switch is saved on the Machine.
#[tauri::command]
pub async fn machine_key_sync(id: String, enabled: bool) -> Result<SyncResult, String> {
    crate::blocking::run(move || {
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        // The secret wall that guards synced keys exists on Linux only.
        if crate::machine_install::detect_target(&machine.ssh_host)?.os != crate::remote_platform::HostOs::Linux {
            return Err("Key sync is available on Linux machines for now.".into());
        }
        let manifest = push(&machine.ssh_host, if enabled { local_keys()? } else { BTreeMap::new() })?;
        crate::machines::set_sync_keys(&machine.id, enabled)?;
        Ok(SyncResult { synced: manifest.into_keys().collect() })
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
    fn a_sync_replaces_the_machines_keys_with_exactly_the_macs() {
        let home = std::env::temp_dir().join(format!("klide-sync-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".klide/remote-api/mistral")).unwrap();
        std::fs::write(home.join(".klide/remote-api/mistral/api-key"), "old").unwrap();
        let keys: BTreeMap<String, String> = [("openrouter".to_string(), "sk-or".to_string()), ("deepseek".to_string(), "sk-ds".to_string())].into();
        let manifest = apply_sync(&home, &keys).unwrap();
        assert_eq!(manifest.keys().collect::<Vec<_>>(), ["deepseek", "openrouter"]);
        assert!(!home.join(".klide/remote-api/mistral").exists(), "a key gone from the Mac is gone here");
        assert_eq!(destination_key(&home.join(".klide/remote-api/openrouter/api-key")).unwrap().as_deref(), Some("sk-or"));
        assert!(pending(&keys, &manifest).is_empty());
        let changed: BTreeMap<String, String> = [("openrouter".to_string(), "sk-new".to_string())].into();
        assert_eq!(pending(&changed, &manifest), ["deepseek", "openrouter"]);
        assert!(apply_sync(&home, &[("ollama".to_string(), "x".to_string())].into()).is_err());
        assert!(home.join(".klide/remote-api/deepseek").exists(), "a refused bundle changes nothing");
        assert!(apply_sync(&home, &BTreeMap::new()).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(home.join(".klide/remote-api")).unwrap().count(), 0);
        std::fs::remove_dir_all(home).unwrap();
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
