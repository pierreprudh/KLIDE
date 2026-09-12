mod accounts;
mod adapters;
mod blocking;
mod cli;
mod agent;
mod coordination;
mod coordination_bridge;
mod custom_cli;
mod custom_providers;
mod delegate;
mod durable;
mod file_memo;
mod gateway;
mod git;
mod local_servers;
pub mod mcp_server;
mod memory;
mod missions;
mod models;
mod preview;
mod spreadsheet;
mod run_documents;
mod pricing;
mod providers;
mod pty;
mod pty_client;
mod pty_frame;
mod pty_wire;
pub mod pty_daemon;
mod pty_host;
mod pty_spawn;
mod search;
mod skills;
mod storage;
mod workspace;
mod worktree_setup;

use crate::providers::{AiChatResponse, ProviderKeyStatus, StreamChunk};
use memory::{memory_list, memory_read, memory_write};
use pty::{
    delegate_daemon_set_enabled, delegate_daemon_status, delegate_pty_live_sessions,
    delegate_pty_recent_sessions, delegate_pty_resize, delegate_pty_snapshot, delegate_pty_spawn,
    delegate_pty_stop, delegate_pty_write, pty_close, pty_resize, pty_spawn, pty_write,
    PtyState,
};
use tauri::ipc::Channel;
use tauri::Emitter;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    is_directory: bool,
}

/// Identity / host info used by the profile modal. All fields are
/// best-effort — failures during the shell-out become empty strings
/// rather than a hard error, so a missing `whoami` on some weird
/// container still returns a usable (if partial) struct.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppUserInfo {
    username: String,
    hostname: String,
    home_dir: String,
}

#[tauri::command]
async fn app_user_info() -> AppUserInfo {
    // `whoami` + `hostname` shell-outs — off the main thread.
    blocking::run_infallible(move || {
        let username = cli::shell_one_line("whoami", "")
            .or_else(|| std::env::var("USER").ok())
            .or_else(|| std::env::var("USERNAME").ok())
            .unwrap_or_default();
        let hostname = cli::shell_one_line("hostname", "")
            .or_else(|| std::env::var("HOSTNAME").ok())
            .or_else(|| std::env::var("COMPUTERNAME").ok())
            .unwrap_or_default();
        let home = cli::home_dir_path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        AppUserInfo {
            username,
            hostname,
            home_dir: home,
        }
    })
    .await
}

// Keychain service name lives in `providers` (single source of truth for
// key storage). `KEYCHAIN_SERVICE` was moved when the registry absorbed
// the keychain helpers.

// The `ProviderKeyStatus` struct lives in `providers` (single source of
// truth for the registry); this command is a thin shim that returns the
// registry's status unchanged.
//
// Report whether a usable key exists and where it comes from — never returns
// the key itself, so the value stays inside the Rust side.
#[tauri::command]
async fn ai_provider_key_status(provider: String) -> ProviderKeyStatus {
    // Reads the keychain-marker file; three surfaces probe all 16 providers at
    // once, so the reads stay off the main thread (blocking.rs).
    blocking::run(move || providers::key_status(&provider))
        .await
        .unwrap_or(ProviderKeyStatus {
            has_key: false,
            source: "none".to_string(),
        })
}

#[tauri::command]
async fn ai_set_provider_key(provider: String, key: String) -> Result<(), String> {
    blocking::run(move || {
        providers::set_keychain_key(&provider, &key)
    })
    .await
}

#[tauri::command]
async fn ai_clear_provider_key(provider: String) -> Result<(), String> {
    blocking::run(move || {
        providers::clear_keychain_key(&provider)
    })
    .await
}

// Per-model list price (USD per million in/out tokens), or null for local /
// subscription / unknown models. The AI panel fetches this once per model and
// computes per-message + per-conversation cost from each turn's token usage.
#[tauri::command]
fn ai_model_pricing(model: String) -> Option<pricing::ModelPricing> {
    pricing::pricing_for_model(&model)
}

// The second key method for built-in providers: a `${VAR}` env reference
// (resolved from the env / project `.env` / ~/.klide/.env), exactly like a
// self-hosted endpoint. Keychain-free, so it never pops a macOS prompt.
#[tauri::command]
async fn ai_set_provider_key_reference(provider: String, reference: String) -> Result<(), String> {
    blocking::run(move || {
        providers::set_provider_reference(&provider, Some(&reference))
    })
    .await
}

#[tauri::command]
async fn ai_clear_provider_key_reference(provider: String) -> Result<(), String> {
    blocking::run(move || {
        providers::set_provider_reference(&provider, None)
    })
    .await
}

// ── Custom (self-hosted) providers ──────────────────────────────────────
// The runtime sibling of the static `providers` registry. Config (label,
// base URL, default model) persists to `~/.klide/custom_providers.json`;
// the bearer token rides the existing `ai_set_provider_key` keychain path,
// keyed by the same `custom:` id.

#[tauri::command]
async fn custom_provider_list() -> Vec<custom_providers::CustomProvider> {
    blocking::run_infallible(move || {
        custom_providers::list()
    })
    .await
}

// Account snapshots for delegate CLIs (Codex / Claude Code / OpenCode). List
// saved snapshots with active-detection, and snapshot the current login. No
// activation/switching yet — see `accounts.rs`.
#[tauri::command]
fn accounts_list(provider: String) -> accounts::AccountsView {
    accounts::list(&provider)
}

#[tauri::command]
async fn account_save_current(provider: String, name: String) -> Result<accounts::Account, String> {
    blocking::run(move || {
        accounts::save_current(&provider, &name)
    })
    .await
}

#[tauri::command]
async fn account_activate(app: tauri::AppHandle, provider: String, name: String) -> Result<(), String> {
    blocking::run(move || {
        // Live-run guard: a running delegate refreshes its token and writes back
        // to the store we're about to swap, so refuse while one is live. Asks both
        // hosts — a ptyd-hosted session is exactly the case that outlives the app.
        if pty::provider_has_live_session(&app, &provider) {
            return Err(format!(
                "A {} session is live in Klide — finish or stop it before switching accounts.",
                provider
            ));
        }
        accounts::activate(&provider, &name)
    })
    .await
}

/// Tell the backend which folder is open, so `${VAR}` token references can
/// resolve from that project's `.env`. Called by the frontend whenever the
/// workspace changes; `None` clears it.
#[tauri::command]
async fn set_active_workspace(app: tauri::AppHandle, root: Option<String>) -> Result<(), String> {
    providers::set_active_workspace(root.clone());
    if let Some(root) = root.filter(|root| !root.trim().is_empty()) {
        missions::reconcile_workspace(app, root).await?;
    }
    Ok(())
}

#[tauri::command]
async fn custom_provider_upsert(provider: custom_providers::CustomProvider) -> Result<(), String> {
    blocking::run(move || {
        custom_providers::upsert(provider)
    })
    .await
}

#[tauri::command]
async fn custom_provider_remove(id: String) -> Result<(), String> {
    blocking::run(move || {
        // Drop the keychain token alongside the config so a re-added id with
        // the same name doesn't silently inherit the old credential.
        let _ = providers::clear_keychain_key(&id);
        custom_providers::remove(&id)
    })
    .await
}

#[tauri::command]
async fn custom_cli_list() -> Vec<custom_cli::CustomCli> {
    blocking::run_infallible(move || {
        custom_cli::list()
    })
    .await
}

#[tauri::command]
async fn custom_cli_upsert(provider: custom_cli::CustomCli) -> Result<(), String> {
    blocking::run(move || {
        custom_cli::upsert(provider)
    })
    .await
}

#[tauri::command]
async fn custom_cli_remove(id: String) -> Result<(), String> {
    blocking::run(move || {
        custom_cli::remove(&id)
    })
    .await
}

#[tauri::command]
async fn ai_subscription_status(provider: String) -> Result<cli::AiConnectionStatus, String> {
    blocking::run(move || {
        cli::subscription_status(provider)
    })
    .await
}

#[tauri::command]
fn ai_list_tools(mode: String) -> Vec<serde_json::Value> {
    let mode = match mode.as_str() {
        "plan" => agent::types::AgentMode::Plan,
        "goal" => agent::types::AgentMode::Goal,
        _ => agent::types::AgentMode::Chat,
    };
    agent::tools::list_tools(&mode, &[])
}

// ── Find in files ───────────────────────────────────────────────────────

#[tauri::command]
async fn search_in_files(
    workspace_root: String,
    pattern: String,
    include: Option<String>,
) -> Result<search::SearchResult, String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        search::search_workspace(&ws, &pattern, include.as_deref())
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ai_chat(
    provider: String,
    model: String,
    messages: Vec<serde_json::Value>,
    tools: Option<Vec<serde_json::Value>>,
    workspace_root: Option<String>,
    num_ctx: Option<usize>,
    num_predict: Option<usize>,
    reflection_level: Option<String>,
    on_chunk: Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    providers::dispatch(
        providers::ProviderTurn {
            provider,
            model,
            messages,
            tools,
            workspace_root,
            // A bare `ai_chat` is a one-shot (the summarizer); it has no
            // conversation to continue.
            run_id: None,
            // A one-shot has no project approvals to carry: it is the
            // summarizer, which asks the model for prose and runs no tools.
            allowed_commands: Vec::new(),
            mcp: None,
            num_ctx,
            num_predict,
            reflection_level,
        },
        &on_chunk,
    )
    .await
}

#[tauri::command]
async fn list_dir(workspace_root: String, path: String) -> Result<Vec<FsEntry>, String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        let path = ws.resolve_abs_read(&path)?;
        let entries = std::fs::read_dir(path).map_err(|e| format!("Unable to read folder: {e}"))?;

        let mut out = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| format!("Unable to read folder entry: {e}"))?;
            let file_type = entry
                .file_type()
                .map_err(|e| format!("Unable to read folder entry type: {e}"))?;
            out.push(FsEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_directory: file_type.is_dir(),
            });
        }

        Ok(out)
    })
    .await
}

#[tauri::command]
async fn read_text_file(workspace_root: String, path: String) -> Result<String, String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        let path = ws.resolve_abs_read(&path)?;
        // User tier: the human may open their own .env; the 20 MB cap only stops
        // a file Monaco couldn't render from freezing the webview.
        ws.read_text(&path, workspace::Access::User)
    })
    .await
}

fn mime_for_path(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "apng" => "image/apng",
        _ => "application/octet-stream",
    }
}

/// Read a workspace file as a self-contained `data:<mime>;base64,…` URI, so the
/// editor can render binary files (images) that the text reader would corrupt.
/// MIME is guessed from the extension. Capped at 20 MB to keep one huge asset
/// from bloating the IPC payload and webview memory.
#[tauri::command]
async fn read_file_data_uri(workspace_root: String, path: String) -> Result<String, String> {
    blocking::run(move || {
        use base64::Engine;
        let ws = workspace::Workspace::new(&workspace_root)?;
        let abs = ws.resolve_abs_read(&path)?;
        let meta = std::fs::metadata(&abs).map_err(|e| format!("Unable to read file: {e}"))?;
        if meta.len() > workspace::USER_MAX_READ_BYTES {
            return Err("File is too large to preview (max 20 MB).".to_string());
        }
        let bytes = std::fs::read(&abs).map_err(|e| format!("Unable to read file: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:{};base64,{}", mime_for_path(&path), b64))
    })
    .await
}

#[tauri::command]
async fn path_exists(workspace_root: String, path: String) -> Result<bool, String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        Ok(ws.resolve_abs_readwrite(&path)?.exists())
    })
    .await
}

#[tauri::command]
async fn write_text_file(workspace_root: String, path: String, content: String) -> Result<(), String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        let target = ws.resolve_abs_readwrite(&path)?;
        ws.write_text(&target, &content, workspace::Access::User)
    })
    .await
}

#[tauri::command]
async fn create_entry(workspace_root: String, path: String, is_directory: bool) -> Result<(), String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        let target = ws.resolve_abs_entry(&path)?;
        if target.exists() {
            return Err("An entry with that name already exists".to_string());
        }
        if is_directory {
            std::fs::create_dir(&target).map_err(|e| format!("Unable to create folder: {e}"))
        } else {
            std::fs::write(&target, "").map_err(|e| format!("Unable to create file: {e}"))
        }
    })
    .await
}

#[tauri::command]
async fn rename_entry(workspace_root: String, from: String, to: String) -> Result<(), String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        let from_path = ws.resolve_abs_entry(&from)?;
        let to_path = ws.resolve_abs_entry(&to)?;
        if to_path.exists() {
            return Err("An entry with that name already exists".to_string());
        }
        std::fs::rename(&from_path, &to_path).map_err(|e| format!("Unable to rename: {e}"))
    })
    .await
}

#[tauri::command]
async fn delete_entry(workspace_root: String, path: String) -> Result<(), String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        let target = ws.resolve_abs_entry(&path)?;
        ws.remove(&target, workspace::Access::User)
    })
    .await
}

/// A picture of a document Klide cannot render — a deck, a spreadsheet, a PDF.
///
/// Drawn by macOS Quick Look and remembered per file and size in `preview.rs`,
/// so the card, the viewer's canvas and its rail pay for one render each and a
/// second look is a lookup. The PNG comes back as a `data:` URI so the webview
/// needs no file access of its own.
#[tauri::command]
async fn preview_file(workspace_root: String, path: String, size: Option<u32>) -> Result<String, String> {
    blocking::run(move || {
        let ws = workspace::Workspace::new(&workspace_root)?;
        let abs = ws.resolve_abs_read(&path)?;
        preview::data_uri(&abs, preview::clamp_size(size), preview::quick_look)
    })
    .await
}

/// Hand a file to the application the machine already opens it with. The one
/// way to read a deck, a PDF or a spreadsheet a run produced: Klide renders
/// none of them, and a viewer for each would be a bigger thing than the card
/// that lists them.
#[tauri::command]
fn open_entry(workspace_root: String, path: String) -> Result<(), String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    let target = ws.resolve_abs_read(&path)?;
    tauri_plugin_opener::open_path(target, None::<&str>)
        .map_err(|e| format!("Unable to open this file: {e}"))
}

#[tauri::command]
fn reveal_entry(workspace_root: String, path: String) -> Result<(), String> {
    let ws = workspace::Workspace::new(&workspace_root)?;
    let target = ws.resolve_abs_read(&path)?;
    tauri_plugin_opener::reveal_item_in_dir(target)
        .map_err(|e| format!("Unable to reveal in Finder: {e}"))
}

// ── Agent runs aggregation ──────────────────────────────────────────────
// Mission Control's board: every run a delegate CLI left on disk, plus the
// parent links recorded at dispatch time. All per-CLI discovery and parsing
// lives behind the Delegate seam (src/delegate/); these commands only add
// the Tauri glue.

use crate::delegate::{AgentRun, Delegate, RunMessage};

/// Paging the board walks the delegate log directories and parses transcripts —
/// filesystem work measured in hundreds of megabytes on a busy machine. A sync
/// command would do all of that **on the main thread** and freeze the webview
/// (the `gh pr list` lesson), so the scan goes to the blocking pool and the
/// command only awaits it.
#[tauri::command]
async fn list_agent_runs(
    app: tauri::AppHandle,
    limit: Option<usize>,
    offset: Option<usize>,
    workspace_root: Option<String>,
) -> Result<Vec<AgentRun>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let limit = limit.unwrap_or(10);
    let offset = offset.unwrap_or(0);
    let scope = workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .map(str::to_string);
    // The spawn-mapping read and the scrollback-meta scan are filesystem work
    // too, so they ride the same blocking closure rather than running after
    // the await on the runtime thread.
    let scan_app = app.clone();
    let (mut runs, (by_delegate, by_external), hosted_statuses) = blocking::run(move || {
        let runs = match scope {
            Some(root) => delegate::list_runs_for_workspace(&home, limit, offset, &root),
            None => delegate::list_runs(&home, limit, offset),
        };
        // Inject parent ids from the spawn mappings recorded at dispatch time.
        // Try by Klide's internal ID first, then by the external session ID
        // (for cases where the CLI created its own session id different from
        // the one we passed to delegate_pty_spawn).
        Ok((
            runs,
            crate::pty::read_delegate_sessions_by_id(&scan_app),
            crate::pty::historical_delegate_statuses(&scan_app),
        ))
    })
    .await?;
    for run in runs.iter_mut() {
        // Evidence: surface the linked git worktree a run executed in (when its
        // cwd is one), so the board can answer "where did this happen?".
        crate::delegate::fill_worktree_evidence(&mut run.worktree, run.cwd.as_deref());
        // Adapter transcripts cover sessions launched anywhere. When Klide
        // hosted this exact provider thread, its hook/PTY exit record is the
        // higher-fidelity lifecycle source and settles stale rows immediately.
        if let Some(status) = hosted_statuses.get(&(run.source.clone(), run.id.clone())) {
            run.status = status.clone();
        }
        if run.parent_id.is_none() {
            if let Some(mapping) = by_delegate
                .get(&run.id)
                .or_else(|| by_external.get(&run.id))
            {
                run.parent_id = Some(mapping.parent_id.clone());
            }
        }
    }
    Ok(runs)
}

/// Sandbox: only ever read the known agent-log directories. Both sides are
/// canonicalized before the containment check — a raw `starts_with` would
/// pass `~/.claude/../../etc/x` (the prefix matches textually while `..`
/// escapes it) and would follow a symlink planted inside a log dir.
fn resolve_agent_log_path(home: &str, path: &str) -> Result<std::path::PathBuf, String> {
    let canonical = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Unable to resolve run path: {e}"))?;
    let allowed = [".claude", ".codex", ".omp"];
    let inside = allowed.iter().any(|dir| {
        std::path::Path::new(home)
            .join(dir)
            .canonicalize()
            .map(|base| canonical.starts_with(&base))
            .unwrap_or(false)
    });
    if inside {
        Ok(canonical)
    } else {
        Err("Path is outside the agent log directories".to_string())
    }
}

#[tauri::command]
async fn read_agent_run(path: String, source: String) -> Result<Vec<RunMessage>, String> {
    blocking::run(move || {
        let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
        // (OpenCode runs go through read_opencode_run instead — their key is a
        // session id, not a path under home.)
        let path = resolve_agent_log_path(&home, &path)?;
        // Route through the registry so every delegate uses its own parser — an
        // unknown source errors loudly instead of being mis-read as Claude.
        let adapter = delegate::lookup(&source)
            .ok_or_else(|| format!("No delegate adapter for source: {source}"))?;
        adapter.read_run(&home, &path.to_string_lossy())
    })
    .await
}

#[tauri::command]
async fn read_opencode_run(session_id: String) -> Result<Vec<RunMessage>, String> {
    blocking::run(move || {
        let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
        delegate::OpenCode.read_run(&home, &session_id)
    })
    .await
}

/// True when the process was launched by the bundle verification script
/// (scripts/verify-bundle.sh) rather than by a user.
fn smoke_test_mode() -> bool {
    std::env::var("KLIDE_SMOKE").as_deref() == Ok("1")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Every fixed menu item, paired with the event it emits.
///
/// `build_app_menu` declares these ids and `on_menu_event` dispatched them ~180
/// lines apart, as two hand-maintained lists of the same strings. A typo in
/// either produced a menu item that silently did nothing — no error, no warning,
/// and the id it should have matched sat in the other list looking correct.
/// `every_menu_id_has_a_handler` reads this file's own source and fails if a
/// `with_id` literal is missing here.
///
/// Note `settings` emits `menu:open-settings`: the id and the event genuinely
/// differ, which is the kind of detail a second hand-written list gets wrong.
///
/// The project-switching entries are deliberately absent — they are dynamic
/// (`project:<path>` / `switch:<path>`) and dispatched by prefix.
const MENU_ITEMS: &[(&str, &str)] = &[
    ("command-palette", "menu:command-palette"),
    ("find-in-files", "menu:find-in-files"),
    ("toggle-terminal", "menu:toggle-terminal"),
    ("toggle-search", "menu:toggle-search"),
    ("settings", "menu:open-settings"),
    ("close-tab", "menu:close-tab"),
    ("close-window", "menu:close-window"),
    ("open-folder", "menu:open-folder"),
    ("save", "menu:save"),
    ("welcome-screen", "menu:welcome-screen"),
];

/// Builds the whole application menu, Projects submenu included.
///
/// One owner on purpose. The Projects list used to be appended from the
/// frontend via `Menu.default().append(...).setAsAppMenu()`, but `Menu.default()`
/// is Tauri's *stock* menu — on macOS its File submenu holds nothing but Close
/// Window. So every rebuild (mount, and any change to recents or the active
/// project) silently replaced this menu with the stock one, taking Open Folder,
/// Save, Close Tab, Find in Files, the Command Palette and Settings with it.
/// The frontend now calls `menu_sync_projects` and Rust stays the only writer.
fn build_app_menu<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    projects: &[String],
    active: Option<&str>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
    };

    let klide_menu = SubmenuBuilder::new(handle, "Klide")
        .item(
            &MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?,
        )
        .separator()
        .item(&PredefinedMenuItem::hide(handle, None)?)
        .item(&PredefinedMenuItem::hide_others(handle, None)?)
        .item(&PredefinedMenuItem::show_all(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(handle, None)?)
        .build()?;

    // Recents live here as well as in Projects: File ▸ Open Recent is where
    // macOS users look for them, and it costs nothing to list them twice.
    let mut open_recent = SubmenuBuilder::new(handle, "Open Recent");
    for path in projects {
        open_recent = open_recent.item(
            &CheckMenuItemBuilder::with_id(
                format!("project:{path}"),
                path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path),
            )
            .checked(active == Some(path.as_str()))
            .build(handle)?,
        );
    }
    let open_recent = open_recent.build()?;

    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(
            &MenuItemBuilder::with_id("open-folder", "Open Project…")
                .accelerator("CmdOrCtrl+O")
                .build(handle)?,
        )
        .item(&open_recent)
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(handle)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("welcome-screen", "Close Project").build(handle)?)
        .item(
            &MenuItemBuilder::with_id("close-tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("close-window", "Close Window")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(handle)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("find-in-files", "Find in Files…")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(handle)?,
        )
        .build()?;

    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(
            &MenuItemBuilder::with_id("command-palette", "Command Palette…")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-terminal", "Toggle Terminal")
                .accelerator("CmdOrCtrl+`")
                .build(handle)?,
        )
        .item(&MenuItemBuilder::with_id("toggle-search", "Toggle Search Panel").build(handle)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .build()?;

    let mut projects_menu = SubmenuBuilder::new(handle, "Projects");
    for path in projects {
        projects_menu = projects_menu.item(
            &CheckMenuItemBuilder::with_id(
                // Distinct id space from Open Recent, or the two entries for the
                // same project collide and only one of them fires.
                format!("switch:{path}"),
                path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path),
            )
            .checked(active == Some(path.as_str()))
            .build(handle)?,
        );
    }
    if !projects.is_empty() {
        projects_menu = projects_menu.separator();
    }
    let projects_menu = projects_menu
        .item(&MenuItemBuilder::with_id("open-folder", "Open Project…").build(handle)?)
        .item(&MenuItemBuilder::with_id("welcome-screen", "Welcome Screen").build(handle)?)
        .build()?;

    MenuBuilder::new(handle)
        .item(&klide_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&projects_menu)
        .build()
}

/// Rebuild the menu with the current recents. Called by the frontend whenever
/// the recents list or the active project changes.
#[tauri::command]
fn menu_sync_projects(
    app: tauri::AppHandle,
    projects: Vec<String>,
    active: Option<String>,
) -> Result<(), String> {
    let menu = build_app_menu(&app, &projects, active.as_deref()).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .manage(crate::pty_host::SessionHost::default())
        .manage(pty::DaemonBridge::default())
        .manage(delegate::status::DelegateStatusState::default())
        .manage(agent::AgentSupervisorState::default())
        .manage(coordination::CoordinationStoreState::default())
        .manage(coordination_bridge::CoordinationBridgeState::default())
        .manage(missions::MissionStoreState::default())
        .manage(local_servers::LocalServerState::default())
        .manage(models::ReflectionProbeCache::default())
        .plugin(tauri_plugin_dialog::init())
        // KLIDE_SMOKE=1 is the bundle boot check (scripts/verify-bundle.sh):
        // the frontend finishing its first page load proves the packaged
        // binary, its dylibs, the webview entitlements, and the embedded
        // assets all work — the failure classes a signed-but-broken bundle
        // exhibits. Print the marker the script greps for and leave.
        .on_page_load(|_webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished && smoke_test_mode() {
                println!("KLIDE_SMOKE_OK");
                let _ = std::io::Write::flush(&mut std::io::stdout());
                // Hard exit on purpose: a smoke boot must terminate
                // deterministically, never hang in teardown.
                std::process::exit(0);
            }
        })
        .setup(|app| {
            use tauri::Manager;

            let handle = app.handle();

            // Persistent delegate sessions: reconnect to (or start) the ptyd
            // daemon when the toggle was left on last session. Skipped during
            // the smoke boot so a release check never touches live sessions.
            if !smoke_test_mode() {
                pty::init_daemon_bridge(handle.clone());
            }

            // Open at a comfortable fraction of the display the window lands on,
            // centered — like a native macOS app, rather than a fixed pixel size
            // that's cramped on a large screen and oversized on a laptop. The
            // window starts hidden (tauri.conf.json `visible: false`) so the user
            // never sees it snap from the config size to this one. Panels then
            // lay out against the real size (the workbench ResizeObserver clamps
            // every rect to it — see usePanelLayout).
            if let Some(window) = app.get_webview_window("main") {
                let monitor = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| window.primary_monitor().ok().flatten());
                if let Some(monitor) = monitor {
                    let screen = monitor.size().to_logical::<f64>(monitor.scale_factor());
                    // ~80% wide / ~85% tall leaves room for the menu bar + Dock,
                    // clamped so it never goes below the min size or absurdly big.
                    let w = (screen.width * 0.80).clamp(960.0, 1600.0);
                    let h = (screen.height * 0.85).clamp(640.0, 1040.0);
                    let _ = window.set_size(tauri::LogicalSize::new(w, h));
                }
                let _ = window.center();
                // Smoke boot stays invisible: the webview loads (and fires
                // on_page_load) without the window ever being shown.
                if !smoke_test_mode() {
                    let _ = window.show();
                }
            }

            app.set_menu(build_app_menu(handle, &[], None)?)?;

            app.on_menu_event(move |_app_handle, event| {
                let id = event.id().as_ref();
                if let Some((_, event)) = MENU_ITEMS.iter().find(|(item, _)| *item == id) {
                    let _ = _app_handle.emit(*event, ());
                    return;
                }
                // Both the File ▸ Open Recent entries and the Projects menu
                // switch projects; they only differ by id prefix so the two
                // copies of a project do not collide.
                if let Some(path) = id
                    .strip_prefix("project:")
                    .or_else(|| id.strip_prefix("switch:"))
                {
                    let _ = _app_handle.emit("menu:open-project", path.to_string());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_resize,
            pty_write,
            pty_close,
            delegate_pty_spawn,
            delegate_pty_write,
            delegate_pty_resize,
            delegate_pty_stop,
            delegate_daemon_status,
            delegate_daemon_set_enabled,
            delegate_pty_snapshot,
            delegate_pty_live_sessions,
            delegate_pty_recent_sessions,
            list_dir,
            read_text_file,
            read_file_data_uri,
            spreadsheet::save_spreadsheet,
            spreadsheet::spreadsheet_version,
            path_exists,
            write_text_file,
            create_entry,
            rename_entry,
            delete_entry,
            open_entry,
            preview_file,
            reveal_entry,
            storage::app_storage_dirs,
            storage::app_storage_reveal,
            storage::app_storage_set_runs_dir,
            storage::app_storage_reset_runs_dir,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_diff,
            git::git_branch_diff,
            list_agent_runs,
            read_agent_run,
            read_opencode_run,
            models::ai_provider_models,
            models::ai_provider_credits,
            models::ai_provider_model_meta,
            ai_subscription_status,
            app_user_info,
            menu_sync_projects,
            models::ai_context_window,
            models::ai_model_supports_tools,
            models::ai_model_supports_vision,
            models::ai_model_supports_reflection,
            models::ai_model_reflection_levels,
            models::ai_count_tokens,
            ai_list_tools,
            search_in_files,
            ai_provider_key_status,
            ai_set_provider_key,
            ai_clear_provider_key,
            ai_set_provider_key_reference,
            ai_clear_provider_key_reference,
            ai_model_pricing,
            custom_provider_list,
            custom_provider_upsert,
            custom_provider_remove,
            custom_cli_list,
            custom_cli_upsert,
            custom_cli_remove,
            accounts_list,
            account_save_current,
            account_activate,
            set_active_workspace,
            ai_chat,
            local_servers::ai_local_server_start,
            local_servers::ai_local_server_stop,
            local_servers::ai_local_server_status,
            local_servers::ollama_account_status,
            gateway::gateway_status,
            gateway::gateway_start,
            gateway::gateway_stop,
            agent::agent_start_run,
            agent::agent_submit_user_turn,
            agent::agent_resolve_permission,
            agent::agent_resolve_diff,
            agent::agent_resolve_question,
            agent::agent_compact_context,
            agent::agent_abort_run,
            agent::agent_run_status,
            agent::agent_list_runs,
            agent::agent_run_origins,
            agent::agent_read_run,
            run_documents::agent_run_document_references,
            agent::agent_export_evidence,
            agent::agent_list_checkpoints,
            agent::agent_revert_checkpoint,
            agent::agent_revert_run_checkpoints,
            agent::agent_accept_run_checkpoints,
            skills::install_skill,
            skills::uninstall_skill,
            skills::list_filesystem_skills,
            memory_write,
            memory_list,
            memory_read,
            coordination::coordination_apply_command,
            coordination::coordination_snapshot,
            coordination::coordination_events,
            missions::mission_create,
            missions::mission_read,
            missions::mission_list,
            missions::mission_save_task,
            missions::mission_approve,
            missions::mission_dispatch_task,
            missions::mission_prepare_attempt,
            missions::mission_fail_attempt_dispatch,
            missions::mission_validate_attempt,
            missions::mission_review_attempt,
            git::github::create_pr,
            git::git_log,
            git::git_graph,
            git::git_commit_details,
            git::github::github_current_user,
            git::github::github_accounts,
            git::github::github_set_account,
            git::github::github_commit_avatars,
            git::git_checkout_branch,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_discard,
            git::git_stash,
            git::git_stash_list,
            git::github::git_pr_list,
            git::github::git_pr_view,
            git::github::git_pr_checkout,
            git::github::git_pr_merge,
            git::github::git_pr_open,
            git::github::git_pr_merged,
            git::git_worktree_add,
            git::git_worktree_list,
            git::git_worktree_merge,
            git::git_worktree_remove,
            git::project_create,
            git::project_clone
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod agent_log_path_tests {
    use super::resolve_agent_log_path;

    #[test]
    fn resolves_only_inside_the_known_log_dirs() {
        let home = std::env::temp_dir().join(format!("klide-loghome-{}", std::process::id()));
        let logs = home.join(".claude").join("projects");
        std::fs::create_dir_all(&logs).unwrap();
        let transcript = logs.join("run.jsonl");
        std::fs::write(&transcript, "{}").unwrap();
        let outside = home.join("secret.txt");
        std::fs::write(&outside, "x").unwrap();
        let home_str = home.to_string_lossy();

        // A real transcript resolves.
        assert!(resolve_agent_log_path(&home_str, &transcript.to_string_lossy()).is_ok());
        // `..` escapes are caught even though the raw prefix matches.
        let traversal = format!("{}/.claude/../secret.txt", home_str);
        assert!(resolve_agent_log_path(&home_str, &traversal).is_err());
        // Paths outside the log dirs are refused.
        assert!(resolve_agent_log_path(&home_str, &outside.to_string_lossy()).is_err());
        // A symlink planted inside a log dir pointing outside is refused.
        #[cfg(unix)]
        {
            let link = logs.join("link.jsonl");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(resolve_agent_log_path(&home_str, &link.to_string_lossy()).is_err());
        }

        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod menu_tests {
    use super::MENU_ITEMS;

    #[test]
    fn every_menu_id_has_a_handler() {
        // Two hand-maintained lists of the same strings, ~180 lines apart, is
        // how a menu item ends up doing nothing at all: no error, no warning,
        // and the id it should have matched sitting in the other list looking
        // perfectly correct. `MENU_ITEMS` is now the only list, and this reads
        // the builder's own source to keep it complete.
        let src = include_str!("lib.rs");
        let body = &src[..src.find("mod menu_tests").expect("this module")];

        let needle = "with_id(\"";
        let mut declared: Vec<&str> = Vec::new();
        for (idx, _) in body.match_indices(needle) {
            let rest = &body[idx + needle.len()..];
            declared.push(&rest[..rest.find('"').expect("closing quote")]);
        }
        declared.sort_unstable();
        declared.dedup();
        assert!(
            declared.len() >= 9,
            "only found {} menu ids — the parse is wrong, not the code",
            declared.len()
        );

        let missing: Vec<&&str> = declared
            .iter()
            .filter(|id| !MENU_ITEMS.iter().any(|(item, _)| item == *id))
            .collect();
        assert!(
            missing.is_empty(),
            "menu ids built but absent from MENU_ITEMS: {missing:?} — these items \
would render and then do nothing when clicked"
        );

        // And nothing in the table is stale: every entry must be a real item.
        let unbuilt: Vec<&str> = MENU_ITEMS
            .iter()
            .map(|(item, _)| *item)
            .filter(|item| !declared.contains(item))
            .collect();
        assert!(unbuilt.is_empty(), "MENU_ITEMS lists absent items: {unbuilt:?}");

        // Every event stays under the one namespace the frontend listens on.
        for (_, event) in MENU_ITEMS {
            assert!(event.starts_with("menu:"), "{event} is not a menu event");
        }
    }
}

#[cfg(test)]
mod blocking_door_tests {
    //! A sync `#[tauri::command]` runs on the main thread (see blocking.rs).
    //! This test reads the command modules' own source so a new sync command
    //! that does IO cannot slip in unnoticed: either make it `async fn` and
    //! route the work through `blocking::run`, or add it to the allowlist on
    //! purpose, with a reason.

    /// Commands allowed to stay sync. Each is in-memory, a sub-millisecond
    /// mutex/handle touch, or a Mission write behind a state lock that a
    /// blocking closure cannot hold.
    const SYNC_COMMANDS: &[&str] = &[
        // lib.rs — pure or a table lookup
        "ai_model_pricing",
        "ai_list_tools",
        // lib.rs — a small JSON read; user-driven, not polled
        "accounts_list",
        // lib.rs — hand off to the opener plugin / native menu
        "open_entry",
        "reveal_entry",
        "menu_sync_projects",
        // missions.rs — Mission writes serialized behind the store's write
        // gate (ADR-0002); a blocking closure cannot hold that State lock.
        "mission_create",
        "mission_save_task",
        "mission_prepare_attempt",
        "mission_fail_attempt_dispatch",
        "mission_validate_attempt",
        // pty.rs — a mutex touch on an in-process session, or a spawn whose
        // cost is the fork itself
        "delegate_daemon_status",
        "delegate_daemon_set_enabled",
        "pty_spawn",
        "pty_resize",
        "pty_write",
        "pty_close",
        "delegate_pty_spawn",
        "delegate_pty_write",
        "delegate_pty_live_sessions",
        "delegate_pty_resize",
        "delegate_pty_stop",
        // local_servers.rs / agent/mod.rs — kill a child / read a status map
        "ai_local_server_stop",
        "agent_run_status",
    ];

    const COMMAND_SOURCES: &[(&str, &str)] = &[
        ("lib.rs", include_str!("lib.rs")),
        ("skills.rs", include_str!("skills.rs")),
        ("memory.rs", include_str!("memory.rs")),
        ("missions.rs", include_str!("missions.rs")),
        ("pty.rs", include_str!("pty.rs")),
        ("local_servers.rs", include_str!("local_servers.rs")),
        ("gateway.rs", include_str!("gateway.rs")),
        ("models.rs", include_str!("models.rs")),
        ("coordination.rs", include_str!("coordination.rs")),
        ("storage.rs", include_str!("storage.rs")),
        ("providers.rs", include_str!("providers.rs")),
        ("agent/mod.rs", include_str!("agent/mod.rs")),
        ("git/mod.rs", include_str!("git/mod.rs")),
        ("git/github.rs", include_str!("git/github.rs")),
    ];

    /// Names of every `#[tauri::command]` in `src` whose `fn` is not `async`.
    fn sync_commands_in(src: &str) -> Vec<String> {
        let lines: Vec<&str> = src.lines().collect();
        let mut out = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if !line.trim().starts_with("#[tauri::command") {
                continue;
            }
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim_start().starts_with("#[") {
                j += 1;
            }
            let Some(sig) = lines.get(j) else { continue };
            if sig.contains("async fn ") {
                continue;
            }
            let Some(rest) = sig.split("fn ").nth(1) else { continue };
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                out.push(name);
            }
        }
        out
    }

    #[test]
    fn every_sync_command_is_on_the_allowlist() {
        let mut found: Vec<(&str, String)> = Vec::new();
        for (file, src) in COMMAND_SOURCES {
            for name in sync_commands_in(src) {
                found.push((file, name));
            }
        }
        assert!(
            found.len() >= 5,
            "found only {} sync commands — the parse is wrong, not the code",
            found.len()
        );
        let unvouched: Vec<&(&str, String)> = found
            .iter()
            .filter(|(_, name)| !SYNC_COMMANDS.contains(&name.as_str()))
            .collect();
        assert!(
            unvouched.is_empty(),
            "sync #[tauri::command]s nobody vouched for: {unvouched:?} — a sync command \
runs on the main thread and freezes the window while it works. Make it `async fn` \
and route the body through blocking::run, or add it to SYNC_COMMANDS with a reason."
        );
        let stale: Vec<&&str> = SYNC_COMMANDS
            .iter()
            .filter(|name| !found.iter().any(|(_, f)| f == **name))
            .collect();
        assert!(stale.is_empty(), "SYNC_COMMANDS lists commands that are no longer sync: {stale:?}");
    }
}
