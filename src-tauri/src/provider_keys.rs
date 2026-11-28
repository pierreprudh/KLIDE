//! A provider's saved API keys — several per provider, one main.
//!
//! Only the main key is ever used. Everything that sends a request reads the
//! main slot in `providers.rs` (the Keychain account `{provider}`, or a
//! `${VAR}` reference) and never learns other keys exist: making a key main
//! copies it into that slot. Each saved key keeps its secret under its own
//! Keychain account `{provider}#{id}`; the store here
//! (`~/.klide/provider_keys.json`, 0600) holds ids, labels and `${VAR}`
//! references — never a secret.

use crate::providers;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedKey {
    pub id: String,
    pub label: String,
    /// `None` → a pasted key, kept in the Keychain under `{provider}#{id}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeys {
    pub keys: Vec<SavedKey>,
    /// The key in the main slot — the one that gets used.
    #[serde(default)]
    pub main: Option<String>,
}

type Store = BTreeMap<String, ProviderKeys>;

/// What the caller hands over for a new key: a pasted secret or a reference.
pub enum NewKey {
    Secret(String),
    Reference(String),
}

pub fn list(provider: &str) -> ProviderKeys {
    let mut entry = read_store().remove(provider).unwrap_or_default();
    entry.main = current_main(provider, &entry);
    entry
}

/// Save a key. `make_main` puts it in the main slot; the first key a provider
/// gets is main whatever was asked. `replaces` swaps an existing key for this
/// one in place — same position, same label unless a new one is given — which
/// is how Edit changes a key without growing the list.
pub fn add(
    provider: &str,
    label: Option<String>,
    key: NewKey,
    make_main: bool,
    replaces: Option<String>,
) -> Result<ProviderKeys, String> {
    let mut store = read_store();
    let mut entry = store.remove(provider).unwrap_or_default();
    if entry.keys.is_empty() {
        adopt_main_slot(provider, &mut entry);
    }
    let main_before = current_main(provider, &entry);
    let replaced = replaces
        .as_deref()
        .and_then(|old| entry.keys.iter().find(|k| k.id == old).cloned());

    let id = new_id()?;
    let label = label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .or_else(|| replaced.as_ref().map(|k| k.label.clone()))
        .unwrap_or_else(|| next_label(&entry.keys));
    let (saved, secret) = match key {
        NewKey::Reference(r) => {
            let r = r.trim().to_string();
            if !providers::is_env_reference(&r) {
                return Err("Expected an env reference like ${OPENAI_API_KEY}, not a literal key".into());
            }
            (SavedKey { id: id.clone(), label, reference: Some(r) }, None)
        }
        NewKey::Secret(s) => {
            let s = s.trim().to_string();
            if s.is_empty() {
                return Err("API key is empty".into());
            }
            providers::set_keychain_secret(&account(provider, &id), &s)?;
            (SavedKey { id: id.clone(), label, reference: None }, Some(s))
        }
    };

    // Replacing the main key keeps the new one main.
    let was_main = replaced.as_ref().is_some_and(|k| main_before.as_deref() == Some(k.id.as_str()));
    if make_main || was_main || main_before.is_none() {
        activate(provider, &saved, secret)?;
        entry.main = Some(id.clone());
    } else {
        entry.main = main_before;
    }
    if let Some(old) = &replaced {
        if old.reference.is_none() {
            let _ = providers::delete_keychain_secret(&account(provider, &old.id));
        }
    }
    place(&mut entry, saved, replaced.map(|k| k.id));

    store.insert(provider.to_string(), entry);
    write_store(&store)?;
    Ok(list(provider))
}

/// Make a saved key the one that gets used.
pub fn set_main(provider: &str, id: &str) -> Result<ProviderKeys, String> {
    let mut store = read_store();
    let entry = store.entry(provider.to_string()).or_default();
    let key = entry
        .keys
        .iter()
        .find(|k| k.id == id)
        .cloned()
        .ok_or_else(|| "That key is no longer saved".to_string())?;
    activate(provider, &key, None)?;
    entry.main = Some(id.to_string());
    write_store(&store)?;
    Ok(list(provider))
}

/// Forget a saved key. Removing the main key empties the main slot — no other
/// key is promoted behind the user's back.
pub fn remove(provider: &str, id: &str) -> Result<ProviderKeys, String> {
    let mut store = read_store();
    let entry = store.entry(provider.to_string()).or_default();
    let Some(index) = entry.keys.iter().position(|k| k.id == id) else {
        return Ok(list(provider));
    };
    if current_main(provider, entry).as_deref() == Some(id) {
        providers::set_provider_reference(provider, None)?;
        providers::clear_keychain_key(provider)?;
    }
    let key = entry.keys.remove(index);
    if key.reference.is_none() {
        providers::delete_keychain_secret(&account(provider, &key.id))?;
    }
    if entry.main.as_deref() == Some(id) {
        entry.main = None;
    }
    write_store(&store)?;
    Ok(list(provider))
}

// ── Main slot ────────────────────────────────────────────────────────────

/// The recorded main key, if the slot still holds it. A key set through
/// another door (an older build, a reference written by hand) unseats it, so
/// the list never claims a key is in use when it isn't.
fn current_main(provider: &str, entry: &ProviderKeys) -> Option<String> {
    let slot_ref = providers::main_slot_reference(provider);
    let slot_keychain = providers::main_slot_has_keychain_key(provider);
    let id = entry.main.as_deref()?;
    let key = entry.keys.iter().find(|k| k.id == id)?;
    holds(key, slot_ref.as_deref(), slot_keychain).then(|| id.to_string())
}

/// Whether the main slot holds `key` — compared without a Keychain read: a
/// reference by its text, a pasted key by "the slot has a pasted key and no
/// reference in front of it".
fn holds(key: &SavedKey, slot_ref: Option<&str>, slot_keychain: bool) -> bool {
    match (&key.reference, slot_ref) {
        (Some(r), Some(slot)) => r.trim() == slot.trim(),
        (None, None) => slot_keychain,
        _ => false,
    }
}

fn activate(provider: &str, key: &SavedKey, secret: Option<String>) -> Result<(), String> {
    match &key.reference {
        Some(r) => providers::set_provider_reference(provider, Some(r)),
        None => {
            let secret = secret
                .or_else(|| providers::read_keychain_secret(&account(provider, &key.id)))
                .ok_or_else(|| format!("The Keychain no longer holds “{}”", key.label))?;
            providers::set_keychain_key(provider, &secret)
        }
    }
}

/// A key saved before this store existed lives only in the main slot. Taken
/// into the list on the first save, so adding a second key doesn't strand it.
fn adopt_main_slot(provider: &str, entry: &mut ProviderKeys) {
    let Ok(id) = new_id() else { return };
    let label = next_label(&entry.keys);
    if let Some(r) = providers::main_slot_reference(provider) {
        entry.keys.push(SavedKey { id: id.clone(), label, reference: Some(r) });
        entry.main = Some(id);
    } else if providers::main_slot_has_keychain_key(provider) {
        let Some(secret) = providers::read_main_slot_key(provider) else { return };
        if providers::set_keychain_secret(&account(provider, &id), &secret).is_ok() {
            entry.keys.push(SavedKey { id: id.clone(), label, reference: None });
            entry.main = Some(id);
        }
    }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

fn account(provider: &str, id: &str) -> String {
    format!("{provider}#{id}")
}

/// "Key N" for the first N not already taken.
fn next_label(keys: &[SavedKey]) -> String {
    (1..)
        .map(|n| format!("Key {n}"))
        .find(|l| !keys.iter().any(|k| &k.label == l))
        .unwrap_or_default()
}

/// Put `key` where `replaces` was, or at the end.
fn place(entry: &mut ProviderKeys, key: SavedKey, replaces: Option<String>) {
    match replaces.and_then(|old| entry.keys.iter().position(|k| k.id == old)) {
        Some(i) => entry.keys[i] = key,
        None => entry.keys.push(key),
    }
}

fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).map_err(|e| format!("Unable to generate a key id: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ── Store ────────────────────────────────────────────────────────────────

fn store_path() -> Option<std::path::PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide").join("provider_keys.json"))
}

fn read_store() -> Store {
    store_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_store(store: &Store) -> Result<(), String> {
    let path = store_path().ok_or_else(|| "Could not resolve home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    crate::durable::write_atomic_private(&path, &json)
        .map_err(|e| format!("Could not write {path:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str, label: &str, reference: Option<&str>) -> SavedKey {
        SavedKey { id: id.into(), label: label.into(), reference: reference.map(Into::into) }
    }

    #[test]
    fn a_reference_is_held_only_when_the_slot_has_that_reference() {
        let k = key("a", "Key 1", Some("${OPENAI_API_KEY}"));
        assert!(holds(&k, Some("${OPENAI_API_KEY}"), false));
        assert!(holds(&k, Some(" ${OPENAI_API_KEY} "), true));
        assert!(!holds(&k, Some("${OTHER}"), false));
        assert!(!holds(&k, None, true));
    }

    #[test]
    fn a_pasted_key_is_held_only_when_no_reference_stands_in_front() {
        let k = key("a", "Key 1", None);
        assert!(holds(&k, None, true));
        assert!(!holds(&k, None, false));
        // The reference is read first, so a pasted key behind it isn't used.
        assert!(!holds(&k, Some("${OPENAI_API_KEY}"), true));
    }

    #[test]
    fn labels_fill_the_first_free_number() {
        assert_eq!(next_label(&[]), "Key 1");
        let keys = [key("a", "Key 1", None), key("b", "Key 3", None)];
        assert_eq!(next_label(&keys), "Key 2");
    }

    #[test]
    fn a_replacement_takes_the_old_keys_place() {
        let mut entry = ProviderKeys {
            keys: vec![key("a", "Work", None), key("b", "Personal", None)],
            main: Some("a".into()),
        };
        place(&mut entry, key("c", "Work", None), Some("a".into()));
        let ids: Vec<_> = entry.keys.iter().map(|k| k.id.as_str()).collect();
        assert_eq!(ids, ["c", "b"]);
        place(&mut entry, key("d", "Spare", None), None);
        assert_eq!(entry.keys.last().unwrap().id, "d");
    }

    #[test]
    fn the_store_never_serialises_a_secret_field() {
        let entry = ProviderKeys { keys: vec![key("a", "Work", None)], main: Some("a".into()) };
        let json = serde_json::to_string(&entry).unwrap();
        assert_eq!(json, r#"{"keys":[{"id":"a","label":"Work"}],"main":"a"}"#);
    }
}
