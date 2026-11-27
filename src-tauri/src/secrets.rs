// Klide's own secrets — pasted provider keys and connector sign-ins — behind
// one door: get / set / delete by (service, account).
//
// A release build keeps them in the macOS Keychain. A debug build keeps them
// in `~/.klide/dev-secrets.json` (mode 0600) instead, because the Keychain
// cannot remember a debug build: our local signing certificate carries no
// Apple Team ID, so macOS pins each item's partition list to the exact
// cdhash of the binary that was allowed. Every `tauri dev` relink is a new
// cdhash, and "Always allow" only ever covered the one before it — a password
// prompt per rebuild, per process.
//
// The first debug read of a secret that is only in the Keychain still asks
// once, then copies it into the file; after that the Keychain is not read.
// Debug writes go to the file only, so a key saved in dev is not visible to
// the installed app. A delete clears both, so a removed key can't come back
// from the Keychain on the next read.
//
// The CLI logins in `accounts.rs` are not ours — they live under the CLIs'
// own Keychain services — and stay on the Keychain in every build.

/// The secret stored for `(service, account)`, `None` when there is none.
/// A Keychain read may raise macOS's access prompt.
pub fn get(service: &str, account: &str) -> Option<String> {
    #[cfg(debug_assertions)]
    if let Some(hit) = dev::get(service, account) {
        return Some(hit);
    }
    let found = keychain::get(service, account)?;
    #[cfg(debug_assertions)]
    let _ = dev::set(service, account, &found);
    Some(found)
}

pub fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    return dev::set(service, account, secret);
    #[cfg(not(debug_assertions))]
    keychain::set(service, account, secret)
}

/// Forget a secret. Forgetting one that was never there is fine.
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    dev::delete(service, account)?;
    keychain::delete(service, account)
}

mod keychain {
    pub fn get(service: &str, account: &str) -> Option<String> {
        keyring::Entry::new(service, account).ok()?.get_password().ok()
    }

    #[cfg_attr(debug_assertions, allow(dead_code))]
    pub fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(service, account)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        // Tests never touch the real Keychain.
        #[cfg(test)]
        return Ok(());
        #[cfg(not(test))]
        match keyring::Entry::new(service, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(debug_assertions)]
mod dev {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Serialises read-modify-write within this process; the write itself is
    /// atomic, so another process never reads a torn file.
    static LOCK: Mutex<()> = Mutex::new(());

    type Store = BTreeMap<String, String>;

    fn path() -> Option<PathBuf> {
        #[cfg(test)]
        return Some(std::env::temp_dir().join(format!("klide-dev-secrets-{}.json", std::process::id())));
        #[cfg(not(test))]
        crate::cli::home_dir_path().map(|home| home.join(".klide").join("dev-secrets.json"))
    }

    fn key(service: &str, account: &str) -> String {
        format!("{service}\n{account}")
    }

    fn read() -> Store {
        path()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(store: &Store) -> Result<(), String> {
        let path = path().ok_or("no home directory")?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
        crate::durable::write_atomic_private(&path, &bytes)
    }

    pub fn get(service: &str, account: &str) -> Option<String> {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        read().remove(&key(service, account))
    }

    pub fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut store = read();
        store.insert(key(service, account), secret.to_string());
        write(&store)
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut store = read();
        if store.remove(&key(service, account)).is_some() {
            write(&store)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_debug_secret_round_trips_through_the_file_not_the_keychain() {
        let service = "com.klide.test.secrets";
        let account = format!("acct-{}", std::process::id());
        assert_eq!(super::get(service, &account), None);
        super::set(service, &account, "s3cret").unwrap();
        assert_eq!(super::get(service, &account).as_deref(), Some("s3cret"));
        super::delete(service, &account).unwrap();
        assert_eq!(super::get(service, &account), None);
        super::delete(service, &account).unwrap();
    }
}
