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
use std::path::{Path, PathBuf};

use crate::delegate::{self, Delegate, ProcessEnv};

// Which delegates have an account store is the adapter's fact
// (`Delegate::supports_accounts`): Klide only ever snapshots credentials a
// CLI has already written down, so a delegate that keeps none — omp resolves
// provider keys from the shell environment — says so on its own impl, and
// `every_delegate_is_accounted_for` holds that flag and this registry
// together. There is no second id list here; each backend names its adapter.

/// macOS Keychain service Claude Code stores its OAuth tokens under.
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
/// Keychain service Klide stores *its* captured Claude account tokens under,
/// namespaced so it never collides with Claude Code's own item.
const KLIDE_CLAUDE_SERVICE: &str = "Klide Claude Accounts";

// --- paths -----------------------------------------------------------------

/// `~/.klide/accounts/<provider>/` — where snapshots + the index live.
fn store_dir(provider: &str) -> Option<PathBuf> {
    crate::cli::home_dir_path().map(|h| h.join(".klide").join("accounts").join(provider))
}

fn index_path(provider: &str) -> Option<PathBuf> {
    store_dir(provider).map(|d| d.join("accounts.json"))
}

/// Claude Code's user-state file (`.claude.json`), wherever its adapter says
/// it is — beside `~/.claude`, or inside `$CLAUDE_CONFIG_DIR`.
fn claude_config_path() -> Option<PathBuf> {
    delegate::ClaudeCode.user_state_file(&ProcessEnv)
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

// --- the provider seam -----------------------------------------------------

/// One account-snapshot backend per delegate CLI. The same shape as the
/// Delegate seam (`src/delegate/`): every piece of per-CLI knowledge — where the
/// login lives, how to read its identity, how to capture and restore it — sits
/// behind this trait, so the generic save / list / activate flow below knows
/// nothing CLI-specific. A new provider is one `impl` + one line in `provider()`.
trait AccountProvider {
    /// The Delegate this backend snapshots for. Its id, label, login command
    /// and login files are all read from the adapter — nothing is restated.
    fn delegate(&self) -> &'static dyn Delegate;
    /// Human label for messages.
    fn label(&self) -> &'static str {
        self.delegate().label()
    }
    /// What to run to log in, for the "not logged in" hint: the adapter's
    /// first login command.
    fn login_cmd(&self) -> String {
        self.delegate()
            .login_commands()
            .into_iter()
            .next()
            .unwrap_or_else(|| self.delegate().binary().to_string())
    }
    /// Live source files (file-based providers); empty for keychain-based ones.
    /// The adapter's `auth_files`, resolved against the process environment.
    fn live_files(&self) -> Vec<PathBuf> {
        self.delegate().auth_files(&ProcessEnv)
    }
    /// Read the live login's identity, or `None` when the CLI isn't logged in /
    /// the source is unreadable. Never touches the keychain.
    fn live_identity(&self) -> Option<AccountIdentity>;
    /// Capture the current login into `dir` under `name`. Returns the snapshot
    /// file names plus an optional Klide-keychain ref (Claude).
    fn capture(
        &self,
        dir: &Path,
        name: &str,
        existing: Option<&Account>,
    ) -> Result<(Vec<String>, Option<String>), String>;
    /// Restore a saved snapshot over the CLI's live store.
    fn restore(&self, dir: &Path, account: &Account) -> Result<(), String>;
}

struct CodexProvider;
struct OpenCodeProvider;
struct ClaudeProvider;

impl AccountProvider for CodexProvider {
    fn delegate(&self) -> &'static dyn Delegate {
        &delegate::Codex
    }
    fn live_identity(&self) -> Option<AccountIdentity> {
        let bytes = std::fs::read(self.live_files().first()?).ok()?;
        let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        Some(codex_identity(&v))
    }
    fn capture(
        &self,
        dir: &Path,
        name: &str,
        existing: Option<&Account>,
    ) -> Result<(Vec<String>, Option<String>), String> {
        Ok((
            capture_files(&self.live_files(), dir, name, existing)?,
            None,
        ))
    }
    fn restore(&self, dir: &Path, account: &Account) -> Result<(), String> {
        restore_files(&self.live_files(), self.label(), dir, account)
    }
}

impl AccountProvider for OpenCodeProvider {
    fn delegate(&self) -> &'static dyn Delegate {
        &delegate::OpenCode
    }
    fn live_identity(&self) -> Option<AccountIdentity> {
        // account.json (the second file) holds the identity.
        let bytes = std::fs::read(self.live_files().get(1)?).ok()?;
        let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        Some(opencode_identity(&v))
    }
    fn capture(
        &self,
        dir: &Path,
        name: &str,
        existing: Option<&Account>,
    ) -> Result<(Vec<String>, Option<String>), String> {
        Ok((
            capture_files(&self.live_files(), dir, name, existing)?,
            None,
        ))
    }
    fn restore(&self, dir: &Path, account: &Account) -> Result<(), String> {
        restore_files(&self.live_files(), self.label(), dir, account)
    }
}

impl AccountProvider for ClaudeProvider {
    fn delegate(&self) -> &'static dyn Delegate {
        &delegate::ClaudeCode
    }
    // `live_files` is the adapter's empty list: keychain-based, no files.
    fn live_identity(&self) -> Option<AccountIdentity> {
        let bytes = std::fs::read(claude_config_path()?).ok()?;
        let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let id = claude_identity(&v);
        id.is_recognised().then_some(id)
    }
    fn capture(
        &self,
        dir: &Path,
        name: &str,
        _existing: Option<&Account>,
    ) -> Result<(Vec<String>, Option<String>), String> {
        let cfg = claude_config_path().ok_or("Could not resolve home directory")?;
        let (kref, file) = capture_claude(&Keyring, dir, &cfg, name)?;
        Ok((vec![file], Some(kref)))
    }
    fn restore(&self, dir: &Path, account: &Account) -> Result<(), String> {
        let cfg = claude_config_path().ok_or("Could not resolve home directory")?;
        restore_claude(&Keyring, dir, &cfg, account)
    }
}

/// Every backend — one per Delegate whose `supports_accounts` is true.
const BACKENDS: [&dyn AccountProvider; 3] = [&CodexProvider, &ClaudeProvider, &OpenCodeProvider];

/// Resolve a provider id to its backend. Ids are never matched here: each
/// backend names its adapter, and the adapter's id is the key — so the
/// account switcher and `delegate::lookup` cannot disagree on a spelling.
fn provider(id: &str) -> Option<&'static dyn AccountProvider> {
    BACKENDS.into_iter().find(|b| b.delegate().id() == id)
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
pub fn list(provider_id: &str) -> AccountsView {
    let Some(p) = provider(provider_id) else {
        return AccountsView {
            provider: provider_id.to_string(),
            present: false,
            ..Default::default()
        };
    };
    let accounts = read_index(provider_id);
    let live = p.live_identity();
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
        provider: provider_id.to_string(),
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
pub fn save_current(provider_id: &str, name: &str) -> Result<Account, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the account a name.".to_string());
    }
    let p = provider(provider_id).ok_or_else(|| format!("Unknown provider \"{provider_id}\""))?;

    let identity = p
        .live_identity()
        .ok_or_else(|| not_logged_in_msg(p))?;
    if !identity.is_recognised() {
        return Err(format!(
            "Couldn't recognise {}'s login shape — not saving, to avoid storing \
             credentials Klide can't restore. (The CLI may have changed its format.)",
            p.label()
        ));
    }

    let dir =
        store_dir(provider_id).ok_or_else(|| "Could not resolve home directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {dir:?}: {e}"))?;

    let mut index = read_index(provider_id);
    let existing = index.iter().find(|a| a.name == name).cloned();

    let (files, keychain_ref) = p.capture(&dir, name, existing.as_ref())?;

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
    write_index(provider_id, &index)?;
    Ok(account)
}

/// Copy each of a file-based provider's live files into the store. Reuses the
/// existing snapshot's filenames when overwriting a same-named account.
fn capture_files(
    live: &[PathBuf],
    dir: &Path,
    name: &str,
    existing: Option<&Account>,
) -> Result<Vec<String>, String> {
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

/// The two keychain operations the Claude account flow needs.
///
/// A seam, because the alternative is untestable: this code reads and
/// **overwrites Claude Code's live credential item**, so exercising it against a
/// real keychain would mean a test that can log the developer out of Claude.
/// With the seam, the ordering and failure handling get covered by a fake and
/// production keeps using the OS keychain.
///
/// Deliberately not `providers.rs`'s `keyring_entry`: that helper is bound to one
/// service name and memoises reads for the process lifetime. Both are wrong here
/// — this flow spans two services, and caching a credential we are about to
/// replace is how you hand out a token that no longer exists.
trait SecretStore {
    fn get(&self, service: &str, user: &str) -> Result<String, String>;
    fn set(&self, service: &str, user: &str, secret: &str) -> Result<(), String>;
}

/// The production adapter: the OS keychain.
struct Keyring;

impl SecretStore for Keyring {
    fn get(&self, service: &str, user: &str) -> Result<String, String> {
        keyring::Entry::new(service, user)
            .and_then(|e| e.get_password())
            .map_err(|e| e.to_string())
    }

    fn set(&self, service: &str, user: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(service, user)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| e.to_string())
    }
}

/// The non-secret half of a Claude login: which account it is, no tokens.
///
/// Split out because this is what lands on disk. Anything that leaks a token
/// into the snapshot file would be a plaintext credential at rest, so the field
/// list is pinned by `claude_snapshot_carries_identity_but_never_tokens`.
fn claude_account_snapshot(config: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "oauthAccount": config.get("oauthAccount").cloned().unwrap_or(serde_json::Value::Null),
        "userID": config.get("userID").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// Splice a snapshot's identity back into an existing `~/.claude.json`.
///
/// Everything else in that file is the user's own Claude Code configuration, so
/// this replaces exactly two keys and leaves the rest untouched. A config that
/// isn't a JSON object is refused rather than overwritten — the file is the
/// user's, and guessing at its shape is how you destroy it.
fn splice_claude_identity(
    config: &mut serde_json::Value,
    snapshot: &serde_json::Value,
) -> Result<(), String> {
    let Some(obj) = config.as_object_mut() else {
        return Err("Claude Code's state file isn't a JSON object — not switching.".to_string());
    };
    for key in ["oauthAccount", "userID"] {
        obj.insert(
            key.into(),
            snapshot.get(key).cloned().unwrap_or(serde_json::Value::Null),
        );
    }
    Ok(())
}

/// Capture Claude's split login: read the OAuth tokens from Claude Code's
/// keychain item into Klide's own keychain item, and snapshot the
/// `oauthAccount` block + `userID` (account metadata, no tokens) to a file for
/// a future restore. Returns `(keychain_ref, snapshot_filename)`. Reading
/// Claude's keychain item may pop a one-time macOS prompt.
fn capture_claude(
    store: &dyn SecretStore,
    dir: &std::path::Path,
    config_path: &std::path::Path,
    name: &str,
) -> Result<(String, String), String> {
    let user = claude_keychain_username();
    let tokens = store.get(CLAUDE_KEYCHAIN_SERVICE, &user).map_err(|e| {
        format!(
            "Couldn't read Claude Code's keychain credentials: {e}. \
             Make sure you're logged in (`claude` → /login) and allow the keychain prompt."
        )
    })?;

    // Store the tokens in Klide's own keychain item, not on disk.
    store
        .set(KLIDE_CLAUDE_SERVICE, name, &tokens)
        .map_err(|e| format!("Couldn't store the account in Klide's keychain: {e}"))?;

    // Snapshot the non-secret account block so a future activation can splice
    // it back into ~/.claude.json.
    let config_bytes =
        std::fs::read(config_path).map_err(|e| format!("Could not read {}: {e}", config_path.display()))?;
    let config: serde_json::Value = serde_json::from_slice(&config_bytes)
        .map_err(|e| format!("Claude Code's state file isn't valid JSON: {e}"))?;
    let stem = slugify(name);
    let file = format!("{stem}.account.json");
    write_private(
        &dir.join(&file),
        &serde_json::to_vec_pretty(&claude_account_snapshot(&config)).map_err(|e| e.to_string())?,
    )?;

    Ok((name.to_string(), file))
}

/// Write `bytes` to `dest` atomically at mode 0600, so a reader never sees a
/// half-written credential file. The recipe this module pioneered now lives in
/// `crate::durable` and is shared with Mission and Delegate-session state.
fn atomic_write_private(dest: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    crate::durable::write_atomic_private(dest, bytes)
}

/// Switch `provider` to the saved account `name`. Refuses if a live run would
/// be stomped (the caller checks that). Restores the snapshot over the CLI's
/// live store: an atomic file swap for Codex/OpenCode, or a keychain + config
/// splice for Claude. Reads every source before writing any destination, so a
/// missing/corrupt snapshot aborts before the live store is touched.
pub fn activate(provider_id: &str, name: &str) -> Result<(), String> {
    let p = provider(provider_id).ok_or_else(|| format!("Unknown provider \"{provider_id}\""))?;
    let account = read_index(provider_id)
        .into_iter()
        .find(|a| a.name == name)
        .ok_or_else(|| format!("No saved \"{name}\" account for {}.", p.label()))?;
    let dir =
        store_dir(provider_id).ok_or_else(|| "Could not resolve home directory".to_string())?;
    p.restore(&dir, &account)
}

fn restore_files(
    live: &[PathBuf],
    label: &str,
    dir: &Path,
    account: &Account,
) -> Result<(), String> {
    if account.files.len() != live.len() {
        return Err(format!(
            "The saved \"{}\" snapshot doesn't match {label}'s current file layout — not switching.",
            account.name,
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

fn restore_claude(
    store: &dyn SecretStore,
    dir: &std::path::Path,
    cfg_path: &std::path::Path,
    account: &Account,
) -> Result<(), String> {
    let kref = account
        .keychain_ref
        .as_deref()
        .ok_or_else(|| "This Claude snapshot has no stored credentials.".to_string())?;
    let tokens = store.get(KLIDE_CLAUDE_SERVICE, kref).map_err(|e| {
        format!("Couldn't read the saved Claude credentials from Klide's keychain: {e}")
    })?;

    let file = account
        .files
        .first()
        .ok_or_else(|| "This Claude snapshot is missing its account file.".to_string())?;
    let snap: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.join(file))
            .map_err(|e| format!("Could not read account snapshot: {e}"))?,
    )
    .map_err(|e| format!("Account snapshot isn't valid JSON: {e}"))?;

    let cfg_bytes =
        std::fs::read(cfg_path).map_err(|e| format!("Could not read {}: {e}", cfg_path.display()))?;
    // One-deep backup so a botched splice is recoverable.
    let backup = std::path::PathBuf::from(format!("{}.klide-bak", cfg_path.display()));
    let _ = std::fs::write(&backup, &cfg_bytes);
    let mut cfg: serde_json::Value = serde_json::from_slice(&cfg_bytes)
        .map_err(|e| format!("Claude Code's state file isn't valid JSON: {e}"))?;
    splice_claude_identity(&mut cfg, &snap)?;
    let new_cfg = serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?;

    // Swap the keychain tokens first, then the config. Both have backups
    // (Klide's keychain item is untouched; ~/.claude.json has the .klide-bak),
    // so a failure between the two is recoverable rather than silently wrong.
    store
        .set(
            CLAUDE_KEYCHAIN_SERVICE,
            &claude_keychain_username(),
            &tokens,
        )
        .map_err(|e| format!("Couldn't write Claude Code's keychain credentials: {e}"))?;
    atomic_write_private(cfg_path, &new_cfg)
}

fn not_logged_in_msg(p: &dyn AccountProvider) -> String {
    format!(
        "{} isn't logged in. Run `{}` first.",
        p.label(),
        p.login_cmd()
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

    // ── The Claude account flow ──────────────────────────────────────────────
    // This is the highest-blast-radius path in the app: activating an account
    // overwrites Claude Code's live credential item and splices the user's own
    // ~/.claude.json. It had no tests, because reaching the keychain from a test
    // would mean a test that can log the developer out. The `SecretStore` seam
    // is what makes it coverable.

    /// An in-memory `SecretStore`, plus a record of the write order.
    #[derive(Default)]
    struct FakeStore {
        secrets: std::sync::Mutex<std::collections::HashMap<(String, String), String>>,
        writes: std::sync::Mutex<Vec<String>>,
        fail_writes_to: Option<String>,
    }

    impl FakeStore {
        fn with(service: &str, user: &str, secret: &str) -> Self {
            let me = Self::default();
            me.secrets.lock().unwrap().insert(
                (service.to_string(), user.to_string()),
                secret.to_string(),
            );
            me
        }
        fn read(&self, service: &str, user: &str) -> Option<String> {
            self.secrets
                .lock()
                .unwrap()
                .get(&(service.to_string(), user.to_string()))
                .cloned()
        }
    }

    impl SecretStore for FakeStore {
        fn get(&self, service: &str, user: &str) -> Result<String, String> {
            self.read(service, user)
                .ok_or_else(|| format!("no such item: {service}/{user}"))
        }
        fn set(&self, service: &str, user: &str, secret: &str) -> Result<(), String> {
            if self.fail_writes_to.as_deref() == Some(service) {
                return Err("keychain denied".to_string());
            }
            self.writes.lock().unwrap().push(service.to_string());
            self.secrets.lock().unwrap().insert(
                (service.to_string(), user.to_string()),
                secret.to_string(),
            );
            Ok(())
        }
    }

    fn claude_account(keychain_ref: Option<&str>) -> Account {
        Account {
            name: "work".into(),
            saved_ms: 0,
            identity: AccountIdentity::default(),
            files: vec!["work.account.json".into()],
            keychain_ref: keychain_ref.map(str::to_string),
        }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-accounts-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_snapshot_carries_identity_but_never_tokens() {
        // The snapshot is written to disk in the clear, so its field list is a
        // security boundary: exactly the two identity keys, nothing adjacent.
        let config = serde_json::json!({
            "oauthAccount": { "emailAddress": "p@example.com" },
            "userID": "user-1",
            "accessToken": "SECRET-DO-NOT-PERSIST",
            "primaryApiKey": "sk-SECRET",
            "editorMode": "vim",
        });
        let snap = claude_account_snapshot(&config);

        assert_eq!(snap["oauthAccount"]["emailAddress"], "p@example.com");
        assert_eq!(snap["userID"], "user-1");
        let text = serde_json::to_string(&snap).unwrap();
        assert!(!text.contains("SECRET"), "snapshot leaked a credential: {text}");
        assert_eq!(
            snap.as_object().unwrap().len(),
            2,
            "only the two identity keys belong on disk: {text}"
        );
    }

    #[test]
    fn splice_replaces_identity_and_leaves_the_rest_alone() {
        // ~/.claude.json is the user's own config. Switching accounts may touch
        // the two identity keys and nothing else.
        let mut config = serde_json::json!({
            "oauthAccount": { "emailAddress": "old@example.com" },
            "userID": "old-user",
            "editorMode": "vim",
            "mcpServers": { "keep": { "command": "x" } },
        });
        let snap = serde_json::json!({
            "oauthAccount": { "emailAddress": "new@example.com" },
            "userID": "new-user",
        });

        splice_claude_identity(&mut config, &snap).expect("splice");
        assert_eq!(config["oauthAccount"]["emailAddress"], "new@example.com");
        assert_eq!(config["userID"], "new-user");
        assert_eq!(config["editorMode"], "vim");
        assert_eq!(config["mcpServers"]["keep"]["command"], "x");
    }

    #[test]
    fn splice_refuses_a_config_that_is_not_an_object() {
        // Rather than overwrite a file whose shape we don't understand.
        let mut config = serde_json::json!(["not", "an", "object"]);
        let err = splice_claude_identity(&mut config, &serde_json::json!({})).unwrap_err();
        assert!(err.contains("isn't a JSON object"), "got: {err}");
        assert_eq!(config, serde_json::json!(["not", "an", "object"]));
    }

    #[test]
    fn capture_moves_tokens_into_klides_own_item_and_never_to_disk() {
        let dir = temp_dir("capture");
        let cfg = dir.join("claude.json");
        std::fs::write(
            &cfg,
            serde_json::to_vec(&serde_json::json!({
                "oauthAccount": { "emailAddress": "p@example.com" },
                "userID": "user-1",
            }))
            .unwrap(),
        )
        .unwrap();
        let user = claude_keychain_username();
        let store = FakeStore::with(CLAUDE_KEYCHAIN_SERVICE, &user, "TOKEN-123");

        let (kref, file) = capture_claude(&store, &dir, &cfg, "work").expect("capture");

        assert_eq!(kref, "work");
        // The tokens land in Klide's item, and Claude's own item is untouched.
        assert_eq!(store.read(KLIDE_CLAUDE_SERVICE, "work").as_deref(), Some("TOKEN-123"));
        assert_eq!(store.read(CLAUDE_KEYCHAIN_SERVICE, &user).as_deref(), Some("TOKEN-123"));
        // And nothing secret reached the snapshot file.
        let on_disk = std::fs::read_to_string(dir.join(&file)).unwrap();
        assert!(!on_disk.contains("TOKEN-123"), "tokens hit the disk: {on_disk}");
        assert!(on_disk.contains("p@example.com"));
    }

    #[test]
    fn capture_reports_a_logged_out_cli_instead_of_saving_an_empty_account() {
        let dir = temp_dir("capture-logged-out");
        let cfg = dir.join("claude.json");
        std::fs::write(&cfg, b"{}").unwrap();

        let err = capture_claude(&FakeStore::default(), &dir, &cfg, "work").unwrap_err();
        assert!(err.contains("Couldn't read Claude Code's keychain"), "got: {err}");
        assert!(err.contains("/login"), "the message should say how to fix it: {err}");
    }

    #[test]
    fn restore_swaps_the_keychain_then_the_config_and_backs_the_config_up() {
        let dir = temp_dir("restore");
        let cfg = dir.join("claude.json");
        std::fs::write(
            &cfg,
            serde_json::to_vec_pretty(&serde_json::json!({
                "oauthAccount": { "emailAddress": "old@example.com" },
                "userID": "old-user",
                "editorMode": "vim",
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join("work.account.json"),
            serde_json::to_vec(&serde_json::json!({
                "oauthAccount": { "emailAddress": "new@example.com" },
                "userID": "new-user",
            }))
            .unwrap(),
        )
        .unwrap();
        let store = FakeStore::with(KLIDE_CLAUDE_SERVICE, "work", "TOKEN-NEW");
        let account = claude_account(Some("work"));

        restore_claude(&store, &dir, &cfg, &account).expect("restore");

        // Claude Code's live item now holds the saved tokens.
        assert_eq!(
            store.read(CLAUDE_KEYCHAIN_SERVICE, &claude_keychain_username()).as_deref(),
            Some("TOKEN-NEW")
        );
        // The config got the new identity and kept the user's own settings.
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&cfg).unwrap()).unwrap();
        assert_eq!(after["oauthAccount"]["emailAddress"], "new@example.com");
        assert_eq!(after["editorMode"], "vim");
        // The pre-switch config is recoverable.
        let backup: serde_json::Value = serde_json::from_slice(
            &std::fs::read(format!("{}.klide-bak", cfg.display())).unwrap(),
        )
        .unwrap();
        assert_eq!(backup["oauthAccount"]["emailAddress"], "old@example.com");
    }

    #[test]
    fn restore_leaves_the_config_alone_when_the_keychain_write_fails() {
        // The ordering is deliberate: keychain first, config second. If the
        // keychain write fails, the config must still describe the account whose
        // tokens are actually installed — otherwise Claude Code reads one
        // identity with another's credentials.
        let dir = temp_dir("restore-keychain-fails");
        let cfg = dir.join("claude.json");
        let original = serde_json::json!({
            "oauthAccount": { "emailAddress": "old@example.com" },
            "userID": "old-user",
        });
        std::fs::write(&cfg, serde_json::to_vec_pretty(&original).unwrap()).unwrap();
        std::fs::write(
            dir.join("work.account.json"),
            serde_json::to_vec(&serde_json::json!({
                "oauthAccount": { "emailAddress": "new@example.com" },
                "userID": "new-user",
            }))
            .unwrap(),
        )
        .unwrap();
        let mut store = FakeStore::with(KLIDE_CLAUDE_SERVICE, "work", "TOKEN-NEW");
        store.fail_writes_to = Some(CLAUDE_KEYCHAIN_SERVICE.to_string());
        let account = claude_account(Some("work"));

        let err = restore_claude(&store, &dir, &cfg, &account).unwrap_err();
        assert!(err.contains("Couldn't write Claude Code's keychain"), "got: {err}");
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&cfg).unwrap()).unwrap();
        assert_eq!(after, original, "the config was rewritten despite the failure");
    }

    #[test]
    fn restore_refuses_an_account_with_no_stored_credentials() {
        let dir = temp_dir("restore-no-kref");
        let account = claude_account(None);
        let err = restore_claude(&FakeStore::default(), &dir, &dir.join("claude.json"), &account)
            .unwrap_err();
        assert!(err.contains("no stored credentials"), "got: {err}");
    }

    #[test]
    fn every_delegate_is_accounted_for() {
        // The account registry is deliberately shorter than `delegate::ALL`:
        // a CLI that writes no credentials has nothing to snapshot. That is only
        // safe as long as the difference is a recorded decision rather than an
        // omission — an architecture review already misread it once and reported
        // omp as missing from the seam.
        //
        // So every delegate must resolve to either a provider or a stated
        // reason. Adding a fifth CLI fails here until someone chooses.
        // So every delegate's `supports_accounts` must match whether a backend
        // exists for it. Adding a fifth CLI fails here until someone chooses.
        for delegate in crate::delegate::ALL {
            let id = delegate.id();
            let has_provider = provider(id).is_some();
            match (has_provider, delegate.supports_accounts()) {
                (true, true) | (false, false) => {}
                (false, true) => panic!(
                    "delegate {id:?} says supports_accounts but has no backend in \
accounts::BACKENDS — add one, or set the flag to false with a reason"
                ),
                (true, false) => panic!(
                    "delegate {id:?} has an account backend but its adapter says \
supports_accounts() == false — the frontend would hide the switcher"
                ),
            }
        }
        assert!(provider("nope").is_none());
    }

    #[test]
    fn a_backend_speaks_with_its_adapters_words() {
        // Label and login hint come from the Delegate, never restated here.
        for backend in BACKENDS {
            let d = backend.delegate();
            assert_eq!(backend.label(), d.label());
            assert_eq!(Some(backend.login_cmd()), d.login_commands().into_iter().next());
            assert_eq!(backend.live_files(), d.auth_files(&ProcessEnv));
        }
        // The disagreement that prompted this: OpenCode's hint said
        // `opencode auth login` here while the adapter said `opencode`.
        assert_eq!(provider("opencode").unwrap().login_cmd(), "opencode auth login");
        assert_eq!(provider("codex").unwrap().login_cmd(), "codex login");
    }
}
