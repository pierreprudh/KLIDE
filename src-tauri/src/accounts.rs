//! Account snapshots for delegate CLIs.
//!
//! Klide is a control plane for coding agents, so it helps to switch which
//! account a delegate CLI runs under (personal vs. work). The model is
//! deliberately narrow and safe:
//!
//!   * **Snapshot/restore only.** Klide copies the credentials a CLI *already
//!     wrote* (you log in normally with `codex login` / `claude login` / etc.);
//!     it never mints or refreshes tokens itself. The worst case is "log in
//!     again", never "your account broke".
//!   * **No live-run stomping.** Activation (a later slice) is gated on "no
//!     live run of that CLI", since a running CLI refreshes its token and
//!     writes back to the store we'd be swapping.
//!
//! This file does **capture + list + active-detection** for three providers.
//! Activation/switching is a later slice. Each provider keeps its login
//! somewhere different:
//!
//!   * **Codex** — one plaintext file `~/.codex/auth.json` (`auth_mode`,
//!     `OPENAI_API_KEY`, `tokens`). Identity: `tokens.account_id` + email/plan
//!     from the `id_token` JWT claims, or a sha256 fingerprint of the API key.
//!   * **OpenCode** — `~/.local/share/opencode/{auth.json,account.json}`.
//!     `account.json` holds `active` + an `accounts` map; identity is the
//!     active account id + its description.
//!   * **Claude Code** — split across the macOS Keychain (item
//!     `Claude Code-credentials`, holding the OAuth tokens) and the
//!     `oauthAccount` block in `~/.claude.json` (email, org, account UUID).
//!     Identity comes from the JSON alone, so **listing never touches the
//!     keychain** — only *saving* reads it (which may pop a one-time macOS
//!     keychain prompt). Klide stores captured tokens in its *own*
//!     keychain item, never in a plaintext file.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const CODEX: &str = "codex";
pub const CLAUDE: &str = "claude-code";
pub const OPENCODE: &str = "opencode";

/// macOS Keychain service Claude Code stores its OAuth tokens under.
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
/// Keychain service Klide stores *its* captured Claude account tokens under,
/// namespaced so it never collides with Claude Code's own item.
const KLIDE_CLAUDE_SERVICE: &str = "Klide Claude Accounts";

// --- paths -----------------------------------------------------------------

/// `~/.klide/accounts/<provider>/` — where snapshots + the index live.
fn store_dir(provider: &str) -> Option<PathBuf> {
    crate::home_dir_path().map(|h| h.join(".klide").join("accounts").join(provider))
}

fn index_path(provider: &str) -> Option<PathBuf> {
    store_dir(provider).map(|d| d.join("accounts.json"))
}

/// The live source files a file-based provider reads/writes. Absolute paths.
/// Claude is not file-based (keychain), so it returns an empty list.
fn live_files(provider: &str) -> Vec<PathBuf> {
    let Some(home) = crate::home_dir_path() else {
        return Vec::new();
    };
    match provider {
        CODEX => vec![home.join(".codex").join("auth.json")],
        OPENCODE => {
            let base = home.join(".local").join("share").join("opencode");
            vec![base.join("auth.json"), base.join("account.json")]
        }
        _ => Vec::new(),
    }
}

/// `~/.claude.json`.
fn claude_config_path() -> Option<PathBuf> {
    crate::home_dir_path().map(|h| h.join(".claude.json"))
}

// --- identity --------------------------------------------------------------

/// The stable, *non-secret* identity of a login — enough to tell two accounts
/// apart and label them for a human, without holding any token.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    /// Codex only: "chatgpt" | "apikey".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<String>,
    /// Stable per-account id (Codex `account_id`, OpenCode active id, Claude
    /// `accountUuid`). The primary match key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Codex API-key mode: a short sha256 fingerprint of the key (never the key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_fingerprint: Option<String>,
    /// Account email, when the source exposes one (Codex JWT / Claude config).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// A secondary human label: Codex plan, Claude org, OpenCode description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AccountIdentity {
    /// Stable key for matching the *same* account across the live source and a
    /// saved snapshot. `None` when the login looks unrecognised.
    fn match_key(&self) -> Option<String> {
        self.account_id
            .clone()
            .or_else(|| self.key_fingerprint.clone())
    }

    /// Does this look like a login we can faithfully snapshot? Guards the save
    /// path against an unfamiliar shape (e.g. an upstream format change).
    fn is_recognised(&self) -> bool {
        self.match_key().is_some()
    }
}

/// Decode a JWT's claims (the middle segment) — base64url, no padding. Reading
/// claims is not a secret operation; we only pull `email` / plan.
fn decode_jwt_claims(jwt: &str) -> Option<serde_json::Value> {
    use base64::Engine;
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// A short, non-reversible fingerprint — enough to tell two secrets apart
/// without ever storing or displaying them.
fn fingerprint(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(secret.as_bytes());
    hash.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

fn codex_identity(v: &serde_json::Value) -> AccountIdentity {
    let auth_mode = v
        .get("auth_mode")
        .and_then(|m| m.as_str())
        .map(str::to_string);
    let tokens = v.get("tokens");
    let account_id = tokens
        .and_then(|t| t.get("account_id"))
        .and_then(|a| a.as_str())
        .map(str::to_string);
    let (email, plan) = tokens
        .and_then(|t| t.get("id_token"))
        .and_then(|i| i.as_str())
        .and_then(decode_jwt_claims)
        .map(|c| {
            let email = c.get("email").and_then(|e| e.as_str()).map(str::to_string);
            let plan = c
                .get("https://api.openai.com/auth")
                .and_then(|a| a.get("chatgpt_plan_type"))
                .and_then(|p| p.as_str())
                .map(str::to_string);
            (email, plan)
        })
        .unwrap_or((None, None));
    let key_fingerprint = v
        .get("OPENAI_API_KEY")
        .and_then(|k| k.as_str())
        .filter(|k| !k.is_empty())
        .map(fingerprint);
    AccountIdentity {
        auth_mode,
        account_id,
        key_fingerprint,
        email,
        detail: plan,
    }
}

fn opencode_identity(account_json: &serde_json::Value) -> AccountIdentity {
    // `active` is { serviceID: accountId }; take the first active account id.
    let active_id = account_json
        .get("active")
        .and_then(|a| a.as_object())
        .and_then(|m| m.values().next())
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let detail = active_id.as_ref().and_then(|id| {
        let acc = account_json.get("accounts").and_then(|a| a.get(id))?;
        let desc = acc.get("description").and_then(|d| d.as_str());
        let svc = acc.get("serviceID").and_then(|s| s.as_str());
        match (desc, svc) {
            (Some(d), Some(s)) => Some(format!("{d} · {s}")),
            (Some(d), None) => Some(d.to_string()),
            (None, Some(s)) => Some(s.to_string()),
            _ => None,
        }
    });
    AccountIdentity {
        account_id: active_id,
        detail,
        ..Default::default()
    }
}

fn claude_identity(config: &serde_json::Value) -> AccountIdentity {
    let oa = config.get("oauthAccount");
    AccountIdentity {
        account_id: oa
            .and_then(|o| o.get("accountUuid"))
            .and_then(|u| u.as_str())
            .map(str::to_string),
        email: oa
            .and_then(|o| o.get("emailAddress"))
            .and_then(|e| e.as_str())
            .map(str::to_string),
        detail: oa
            .and_then(|o| o.get("organizationName"))
            .and_then(|n| n.as_str())
            .map(str::to_string),
        ..Default::default()
    }
}

/// Read the live login for `provider` and return its identity, or `None` when
/// the CLI isn't logged in / the source is unreadable. Never touches the
/// keychain (Claude identity comes from `~/.claude.json` alone).
fn live_identity(provider: &str) -> Option<AccountIdentity> {
    match provider {
        CODEX => {
            let bytes = std::fs::read(live_files(CODEX).first()?).ok()?;
            let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
            Some(codex_identity(&v))
        }
        OPENCODE => {
            // account.json is the second file; it holds the identity.
            let bytes = std::fs::read(live_files(OPENCODE).get(1)?).ok()?;
            let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
            Some(opencode_identity(&v))
        }
        CLAUDE => {
            let bytes = std::fs::read(claude_config_path()?).ok()?;
            let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
            let id = claude_identity(&v);
            id.is_recognised().then_some(id)
        }
        _ => None,
    }
}

// --- index records ---------------------------------------------------------

/// One saved snapshot, persisted in `accounts.json`. Non-secret metadata plus
/// pointers to where the secret lives (snapshot files for file providers; a
/// Klide keychain ref for Claude). The tokens themselves are never here.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub name: String,
    pub saved_ms: i64,
    pub identity: AccountIdentity,
    /// Snapshot filenames within the provider's store dir (file providers).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// Claude: the account name under Klide's keychain service holding tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keychain_ref: Option<String>,
}

/// A snapshot as shown to the frontend — `Account` plus whether it matches the
/// login the CLI is currently using. Storage pointers are omitted.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountRow {
    pub name: String,
    pub saved_ms: i64,
    pub identity: AccountIdentity,
    pub active: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountsView {
    pub provider: String,
    pub accounts: Vec<AccountRow>,
    /// Set when the live login matches none of the saved snapshots.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_unsaved: Option<AccountIdentity>,
    /// Whether the CLI is logged in at all.
    pub present: bool,
}

// --- store I/O -------------------------------------------------------------

fn read_index(provider: &str) -> Vec<Account> {
    let Some(path) = index_path(provider) else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_index(provider: &str, accounts: &[Account]) -> Result<(), String> {
    let path =
        index_path(provider).ok_or_else(|| "Could not resolve home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {parent:?}: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(accounts).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write {path:?}: {e}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Turn a display name into a safe snapshot filename stem.
fn slugify(name: &str) -> String {
    let s: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "account".to_string()
    } else {
        s
    }
}

/// Copy a file to mode 0600 (mirrors the source CLIs' own permissions, since
/// the snapshot may hold the same tokens).
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("Could not write {path:?}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn claude_keychain_username() -> String {
    std::env::var("USER").unwrap_or_else(|_| "default".to_string())
}

// --- public API ------------------------------------------------------------

/// List saved snapshots for `provider`, mark the active one, and report whether
/// the current login is unsaved. Read-only; never touches the keychain.
pub fn list(provider: &str) -> AccountsView {
    let accounts = read_index(provider);
    let live = live_identity(provider);
    let live_key = live.as_ref().and_then(AccountIdentity::match_key);

    let mut matched_any = false;
    let rows: Vec<AccountRow> = accounts
        .iter()
        .map(|a| {
            let active = match (&live_key, a.identity.match_key()) {
                (Some(lk), Some(ak)) => *lk == ak,
                _ => false,
            };
            if active {
                matched_any = true;
            }
            AccountRow {
                name: a.name.clone(),
                saved_ms: a.saved_ms,
                identity: a.identity.clone(),
                active,
            }
        })
        .collect();

    let present = live.is_some();
    let current_unsaved = match live {
        Some(id) if id.is_recognised() && !matched_any => Some(id),
        _ => None,
    };

    AccountsView {
        provider: provider.to_string(),
        accounts: rows,
        current_unsaved,
        present,
    }
}

/// Snapshot the current login for `provider` under `name`. Validates the live
/// source shape first (drift guard), then captures it: copies snapshot files at
/// mode 600 (file providers), or copies the keychain tokens into Klide's own
/// keychain item + snapshots the `oauthAccount` block (Claude). Re-saving an
/// existing name overwrites that snapshot in place.
pub fn save_current(provider: &str, name: &str) -> Result<Account, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the account a name.".to_string());
    }
    if !matches!(provider, CODEX | CLAUDE | OPENCODE) {
        return Err(format!("Unknown provider \"{provider}\""));
    }

    let identity = live_identity(provider).ok_or_else(|| not_logged_in_msg(provider))?;
    if !identity.is_recognised() {
        return Err(format!(
            "Couldn't recognise {}'s login shape — not saving, to avoid storing \
             credentials Klide can't restore. (The CLI may have changed its format.)",
            provider_label(provider)
        ));
    }

    let dir = store_dir(provider).ok_or_else(|| "Could not resolve home directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {dir:?}: {e}"))?;

    let mut index = read_index(provider);
    let existing = index.iter().find(|a| a.name == name).cloned();

    let (files, keychain_ref) = if provider == CLAUDE {
        let (kref, file) = capture_claude(&dir, name)?;
        (vec![file], Some(kref))
    } else {
        (
            capture_files(provider, &dir, name, existing.as_ref())?,
            None,
        )
    };

    let account = Account {
        name: name.to_string(),
        saved_ms: now_ms(),
        identity,
        files,
        keychain_ref,
    };
    match index.iter_mut().find(|a| a.name == name) {
        Some(slot) => *slot = account.clone(),
        None => index.push(account.clone()),
    }
    write_index(provider, &index)?;
    Ok(account)
}

/// Copy each of a file-based provider's live files into the store. Reuses the
/// existing snapshot's filenames when overwriting a same-named account.
fn capture_files(
    provider: &str,
    dir: &std::path::Path,
    name: &str,
    existing: Option<&Account>,
) -> Result<Vec<String>, String> {
    let live = live_files(provider);
    let stem = slugify(name);
    let mut out = Vec::new();
    for (i, src) in live.iter().enumerate() {
        // e.g. "work.auth.json", "work.account.json" — keep the source's own
        // file name as a suffix so multi-file providers stay legible.
        let src_name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("file{i}.json"));
        let dest_name = existing
            .and_then(|e| e.files.get(i).cloned())
            .unwrap_or_else(|| format!("{stem}.{src_name}"));
        let bytes = std::fs::read(src)
            .map_err(|e| format!("Could not read {src:?}: {e} (is the CLI logged in?)"))?;
        write_private(&dir.join(&dest_name), &bytes)?;
        out.push(dest_name);
    }
    Ok(out)
}

/// Capture Claude's split login: read the OAuth tokens from Claude Code's
/// keychain item into Klide's own keychain item, and snapshot the
/// `oauthAccount` block + `userID` (account metadata, no tokens) to a file for
/// a future restore. Returns `(keychain_ref, snapshot_filename)`. Reading
/// Claude's keychain item may pop a one-time macOS prompt.
fn capture_claude(dir: &std::path::Path, name: &str) -> Result<(String, String), String> {
    let user = claude_keychain_username();
    let tokens = keyring::Entry::new(CLAUDE_KEYCHAIN_SERVICE, &user)
        .and_then(|e| e.get_password())
        .map_err(|e| {
            format!(
                "Couldn't read Claude Code's keychain credentials: {e}. \
                 Make sure you're logged in (`claude` → /login) and allow the keychain prompt."
            )
        })?;

    // Store the tokens in Klide's own keychain item, not on disk.
    keyring::Entry::new(KLIDE_CLAUDE_SERVICE, name)
        .and_then(|e| e.set_password(&tokens))
        .map_err(|e| format!("Couldn't store the account in Klide's keychain: {e}"))?;

    // Snapshot the non-secret account block so a future activation can splice
    // it back into ~/.claude.json.
    let config_bytes = std::fs::read(
        claude_config_path().ok_or_else(|| "Could not resolve home directory".to_string())?,
    )
    .map_err(|e| format!("Could not read ~/.claude.json: {e}"))?;
    let config: serde_json::Value = serde_json::from_slice(&config_bytes)
        .map_err(|e| format!("~/.claude.json isn't valid JSON: {e}"))?;
    let snapshot = serde_json::json!({
        "oauthAccount": config.get("oauthAccount").cloned().unwrap_or(serde_json::Value::Null),
        "userID": config.get("userID").cloned().unwrap_or(serde_json::Value::Null),
    });
    let stem = slugify(name);
    let file = format!("{stem}.account.json");
    write_private(
        &dir.join(&file),
        &serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?,
    )?;

    Ok((name.to_string(), file))
}

/// Write `bytes` to `dest` atomically (temp file + rename) at mode 0600, so a
/// reader never sees a half-written credential file.
fn atomic_write_private(dest: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = dest.with_extension("klide-tmp");
    write_private(&tmp, bytes)?;
    std::fs::rename(&tmp, dest).map_err(|e| format!("Could not move {tmp:?} into place: {e}"))
}

/// Switch `provider` to the saved account `name`. Refuses if a live run would
/// be stomped (the caller checks that). Restores the snapshot over the CLI's
/// live store: an atomic file swap for Codex/OpenCode, or a keychain + config
/// splice for Claude. Reads every source before writing any destination, so a
/// missing/corrupt snapshot aborts before the live store is touched.
pub fn activate(provider: &str, name: &str) -> Result<(), String> {
    let account = read_index(provider)
        .into_iter()
        .find(|a| a.name == name)
        .ok_or_else(|| {
            format!(
                "No saved \"{name}\" account for {}.",
                provider_label(provider)
            )
        })?;
    match provider {
        CODEX | OPENCODE => restore_files(provider, &account),
        CLAUDE => restore_claude(&account),
        _ => Err(format!("Unknown provider \"{provider}\"")),
    }
}

fn restore_files(provider: &str, account: &Account) -> Result<(), String> {
    let dir = store_dir(provider).ok_or_else(|| "Could not resolve home directory".to_string())?;
    let live = live_files(provider);
    if account.files.len() != live.len() {
        return Err(format!(
            "The saved \"{}\" snapshot doesn't match {}'s current file layout — not switching.",
            account.name,
            provider_label(provider)
        ));
    }
    // Read all snapshots up front so a missing one aborts before any live
    // file is overwritten.
    let mut payloads = Vec::with_capacity(account.files.len());
    for f in &account.files {
        let path = dir.join(f);
        payloads.push(
            std::fs::read(&path).map_err(|e| format!("Could not read snapshot {path:?}: {e}"))?,
        );
    }
    for (live_path, bytes) in live.iter().zip(payloads.iter()) {
        if let Some(parent) = live_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {parent:?}: {e}"))?;
        }
        atomic_write_private(live_path, bytes)?;
    }
    Ok(())
}

fn restore_claude(account: &Account) -> Result<(), String> {
    let kref = account
        .keychain_ref
        .as_deref()
        .ok_or_else(|| "This Claude snapshot has no stored credentials.".to_string())?;
    let tokens = keyring::Entry::new(KLIDE_CLAUDE_SERVICE, kref)
        .and_then(|e| e.get_password())
        .map_err(|e| {
            format!("Couldn't read the saved Claude credentials from Klide's keychain: {e}")
        })?;

    let dir = store_dir(CLAUDE).ok_or_else(|| "Could not resolve home directory".to_string())?;
    let file = account
        .files
        .first()
        .ok_or_else(|| "This Claude snapshot is missing its account file.".to_string())?;
    let snap: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.join(file))
            .map_err(|e| format!("Could not read account snapshot: {e}"))?,
    )
    .map_err(|e| format!("Account snapshot isn't valid JSON: {e}"))?;

    let cfg_path =
        claude_config_path().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let cfg_bytes =
        std::fs::read(&cfg_path).map_err(|e| format!("Could not read ~/.claude.json: {e}"))?;
    // One-deep backup so a botched splice is recoverable.
    let backup = std::path::PathBuf::from(format!("{}.klide-bak", cfg_path.display()));
    let _ = std::fs::write(&backup, &cfg_bytes);
    let mut cfg: serde_json::Value = serde_json::from_slice(&cfg_bytes)
        .map_err(|e| format!("~/.claude.json isn't valid JSON: {e}"))?;
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert(
            "oauthAccount".into(),
            snap.get("oauthAccount")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        );
        obj.insert(
            "userID".into(),
            snap.get("userID")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        );
    } else {
        return Err("~/.claude.json isn't a JSON object — not switching.".to_string());
    }
    let new_cfg = serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?;

    // Swap the keychain tokens first, then the config. Both have backups
    // (Klide's keychain item is untouched; ~/.claude.json has the .klide-bak),
    // so a failure between the two is recoverable rather than silently wrong.
    keyring::Entry::new(CLAUDE_KEYCHAIN_SERVICE, &claude_keychain_username())
        .and_then(|e| e.set_password(&tokens))
        .map_err(|e| format!("Couldn't write Claude Code's keychain credentials: {e}"))?;
    atomic_write_private(&cfg_path, &new_cfg)
}

fn provider_label(provider: &str) -> &'static str {
    match provider {
        CODEX => "Codex",
        CLAUDE => "Claude Code",
        OPENCODE => "OpenCode",
        _ => "the CLI",
    }
}

fn not_logged_in_msg(provider: &str) -> String {
    let cmd = match provider {
        CODEX => "codex login",
        CLAUDE => "claude → /login",
        OPENCODE => "opencode auth login",
        _ => "the CLI's login",
    };
    format!(
        "{} isn't logged in. Run `{cmd}` first.",
        provider_label(provider)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_identity_reads_account_and_claims() {
        use base64::Engine;
        let claims = serde_json::json!({
            "email": "x@example.com",
            "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" }
        });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        let auth = serde_json::json!({
            "auth_mode": "chatgpt",
            "tokens": { "account_id": "acc-123", "id_token": format!("h.{payload}.s") }
        });
        let id = codex_identity(&auth);
        assert_eq!(id.account_id.as_deref(), Some("acc-123"));
        assert_eq!(id.email.as_deref(), Some("x@example.com"));
        assert_eq!(id.detail.as_deref(), Some("plus"));
        assert!(id.is_recognised());
        assert_eq!(id.match_key().as_deref(), Some("acc-123"));
    }

    #[test]
    fn codex_apikey_fingerprinted_not_exposed() {
        let id = codex_identity(
            &serde_json::json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "sk-secret" }),
        );
        let fp = id.key_fingerprint.as_deref().unwrap();
        assert_eq!(fp.len(), 12);
        assert!(!fp.contains("secret"));
        assert!(id.is_recognised());
        assert_eq!(fingerprint("sk-secret"), fp);
        assert_ne!(fingerprint("sk-other"), fp);
    }

    #[test]
    fn opencode_identity_reads_active_account() {
        let v = serde_json::json!({
            "active": { "opencode-go": "acc-xyz" },
            "accounts": { "acc-xyz": { "id": "acc-xyz", "serviceID": "opencode-go", "description": "default" } }
        });
        let id = opencode_identity(&v);
        assert_eq!(id.account_id.as_deref(), Some("acc-xyz"));
        assert_eq!(id.detail.as_deref(), Some("default · opencode-go"));
        assert!(id.is_recognised());
    }

    #[test]
    fn claude_identity_reads_oauth_account() {
        let v = serde_json::json!({
            "userID": "u-1",
            "oauthAccount": { "accountUuid": "uuid-1", "emailAddress": "p@ex.com", "organizationName": "Acme" }
        });
        let id = claude_identity(&v);
        assert_eq!(id.account_id.as_deref(), Some("uuid-1"));
        assert_eq!(id.email.as_deref(), Some("p@ex.com"));
        assert_eq!(id.detail.as_deref(), Some("Acme"));
        assert!(id.is_recognised());
    }

    #[test]
    fn unrecognised_shapes_are_not_saveable() {
        assert!(
            !codex_identity(&serde_json::json!({ "auth_mode": "chatgpt", "tokens": {} }))
                .is_recognised()
        );
        assert!(!claude_identity(&serde_json::json!({})).is_recognised());
        assert!(!opencode_identity(&serde_json::json!({})).is_recognised());
    }

    #[test]
    fn slugify_is_filesystem_safe() {
        assert_eq!(slugify("Work Account"), "work-account");
        assert_eq!(slugify("  Pierre@OntraaK  "), "pierre-ontraak");
        assert_eq!(slugify("///"), "account");
    }
}
