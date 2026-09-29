// Where Klide keeps things, and how much room they take.
//
// Two stores hold a conversation, and they are not equals:
//
//  · the **local cache** — the browser's localStorage index the Focus rail and
//    the AI panel list read from. Bounded by the webview's ~5 MB quota, owned
//    by the frontend, and disposable.
//  · the **Run transcripts** — this module's subject: `runs/` under the app
//    data dir, written through `durable.rs`, the record Mission Control reads
//    and the only copy that survives clearing the cache.
//
// Settings needs to say all of that in numbers, give the folder a name you can
// open, and — since transcripts are the copy that matters — let you decide
// which disk they live on. Measuring and moving both walk the filesystem, so
// every command here is async and does its work off the main thread: a
// synchronous Tauri command runs ON the UI thread and freezes the window.
//
// The runs directory is resolved in exactly one place (`runs_dir`), which
// `agent::transcripts::app_runs_dir` delegates to. Every writer and reader in
// the app already goes through that function, so an override cannot half-apply
// and leave one caller writing to the old folder.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

// Serializes new run admission with storage mutations in this app process.
pub(crate) static RUN_STORAGE_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRun {
    id: String,
    title: String,
    updated_ms: i64,
    bytes: u64,
    transcript_bytes: u64,
    supporting_bytes: u64,
}

fn run_storage_paths(root: &Path, id: &str) -> Result<Vec<PathBuf>, String> {
    crate::agent::transcripts::validate_run_id(id)?;
    let paths = vec![
        root.join(format!("{id}.jsonl")),
        root.join(format!("{id}.summary.json")),
        root.join(id).join("checkpoints"),
        root.join(format!("{id}.values")),
    ];
    // Never traverse links supplied in a custom storage directory.
    for path in &paths {
        for ancestor in path.ancestors().take_while(|p| *p != root) {
            if let Ok(meta) = std::fs::symlink_metadata(ancestor) {
                if meta.file_type().is_symlink() {
                    return Err("Conversation storage contains a symbolic link.".into());
                }
            }
        }
    }
    Ok(paths)
}

fn stored_runs(root: &Path) -> Result<Vec<StoredRun>, String> {
    let mut rows = Vec::new();
    for summary in crate::agent::transcripts::list_summaries(root, None, None)? {
        let paths = run_storage_paths(root, &summary.id)?;
        let sizes: Vec<u64> = paths
            .iter()
            .map(|path| {
                std::fs::symlink_metadata(path)
                    .map(|meta| {
                        if meta.is_dir() {
                            measure(path, 0).1
                        } else {
                            meta.len()
                        }
                    })
                    .unwrap_or(0)
            })
            .collect();
        rows.push(StoredRun {
            id: summary.id,
            title: summary.title,
            updated_ms: summary.updated_ms,
            bytes: sizes.iter().sum(),
            transcript_bytes: sizes[0],
            supporting_bytes: sizes[1..].iter().sum(),
        });
    }
    rows.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.id.cmp(&b.id)));
    Ok(rows)
}

#[tauri::command]
pub async fn app_storage_conversations(app: tauri::AppHandle) -> Result<Vec<StoredRun>, String> {
    crate::blocking::run(move || stored_runs(&runs_dir(&app)?)).await
}

fn delete_stored_run(root: &Path, id: &str) -> Result<(), String> {
    let paths = run_storage_paths(root, id)?;
    // A valid summary proves this is a known run, rather than an arbitrary id.
    crate::agent::transcripts::read_summary(root, id)?;
    // Delete the index last, leaving a discoverable row if cleanup fails.
    for index in [2, 3, 0, 1] {
        let path = &paths[index];
        let meta = match std::fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        if meta.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        }
        .map_err(|e| format!("Unable to delete {}: {e}", path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn app_storage_delete_conversation(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let _guard = RUN_STORAGE_GATE.lock().await;
    crate::blocking::run(move || {
        crate::agent::ensure_storage_idle(&app).map_err(|_| {
            "Finish or stop active conversations before deleting saved history.".to_string()
        })?;
        delete_stored_run(&runs_dir(&app)?, &id)
    })
    .await
}

/// One directory Klide owns, measured.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDir {
    /// Stable id the frontend addresses this directory by (`app_storage_reveal`).
    pub kind: String,
    pub label: String,
    /// What lives here, in one line — Settings shows it verbatim.
    pub detail: String,
    pub path: String,
    pub files: usize,
    pub bytes: u64,
    /// True when this folder is where it is because someone chose it.
    pub custom: bool,
    /// Where it would be with no choice made — what "Use default" restores.
    pub default_path: String,
    /// Set when a chosen folder was ignored (missing volume, gone read-only)
    /// and Klide fell back to the default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// How deep a measured walk may go. `runs/` is flat and `missions/` is two
/// levels; a bound keeps a stray symlink or a huge nested tree from turning a
/// Settings render into a filesystem crawl.
const MAX_DEPTH: usize = 4;

fn measure(dir: &Path, depth: usize) -> (usize, u64) {
    if depth > MAX_DEPTH {
        return (0, 0);
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut files = 0;
    let mut bytes = 0;
    for entry in entries.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let (f, b) = measure(&entry.path(), depth + 1);
            files += f;
            bytes += b;
        } else if meta.is_file() {
            files += 1;
            bytes += meta.len();
        }
    }
    (files, bytes)
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Unable to resolve the app data dir: {e}"))
}

/// The subdirectory a `kind` names, relative to the app data dir. This mapping
/// IS the allowlist — it is the only thing that turns a caller's string into a
/// path, it never returns a path built from that string, and it has no
/// catch-all, so `reveal` can only ever open a directory Klide itself owns.
fn relative_for(kind: &str) -> Result<&'static str, String> {
    match kind {
        "runs" => Ok("runs"),
        "app-data" => Ok(""),
        other => Err(format!("Unknown storage directory: {other}")),
    }
}

fn dir_for(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let relative = relative_for(kind)?;
    // "runs" goes through the resolver, so Reveal opens the folder transcripts
    // are actually written to — not the default one under app data.
    if relative == "runs" {
        return runs_dir(app);
    }
    let root = app_data(app)?;
    Ok(if relative.is_empty() {
        root
    } else {
        root.join(relative)
    })
}

/// `~/.klide/storage.json` — the same `~/.klide` home the skills loader and the
/// custom-provider store use for global (non-workspace) Klide config.
fn config_path() -> Option<PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide").join("storage.json"))
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageConfig {
    /// Absolute path the user chose for run transcripts. `None` = app data dir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runs_dir: Option<String>,
}

/// Read the config. A missing or unparseable file is "no override", not an
/// error: the file only exists once someone moves the folder, and a corrupt one
/// must not stop the app from finding its transcripts.
fn read_config() -> StorageConfig {
    let Some(path) = config_path() else {
        return StorageConfig::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return StorageConfig::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_config(config: &StorageConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "Could not resolve the home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    // Through durable.rs: a torn config would read as "no override" and send
    // the next run's transcript to a different folder than the last one's.
    crate::durable::write_atomic(&path, &json)
}

/// The folder Klide's own data lives under when nothing is overridden.
fn default_runs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("runs"))
}

/// Why an override cannot be used, if it cannot. Inspection only — it creates
/// nothing and writes nothing, so Settings can ask the question without the
/// asking making a missing folder reappear, and `runs_dir` can ask it on the
/// path of every transcript append without that costing a write. `runs_dir`
/// does the creating, once it has decided.
///
/// Being cheap has a limit worth naming: the permission bits catch a folder
/// that was chmod'd read-only, but not one on a read-only *mount*, whose bits
/// still read as writable. Proving that needs an actual write, which is what
/// `write_problem` does — at folder-selection time, and when Settings measures.
fn override_problem(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return Some(format!("{} is not an absolute path.", path.display()));
    }
    if path.exists() {
        if !path.is_dir() {
            return Some(format!("{} is a file, not a folder.", path.display()));
        }
        let readonly = std::fs::metadata(path)
            .map(|meta| meta.permissions().readonly())
            .unwrap_or(false);
        return readonly.then(|| format!("{} is read-only.", path.display()));
    }
    // Not there yet — a folder Klide can create is fine (it makes its own on
    // first use); one whose parent is gone is an unplugged drive.
    match path.parent() {
        Some(parent) if parent.is_dir() => None,
        _ => Some(format!(
            "{} is unreachable — the folder above it is missing.",
            path.display()
        )),
    }
}

/// Prove a folder can actually be written to, by writing in it. The only way
/// to catch a read-only mount, whose permission bits look fine. Costs a file
/// create + delete, so it belongs at the moments a person is waiting on an
/// answer — choosing a folder, opening Settings — never on the append path.
fn write_problem(path: &Path) -> Option<String> {
    let probe = path.join(".klide-write-probe");
    match std::fs::write(&probe, b"klide") {
        Ok(()) => {
            std::fs::remove_file(&probe).ok();
            None
        }
        Err(e) => Some(format!("Cannot write in {}: {e}", path.display())),
    }
}

/// THE resolution point for run transcripts. An override that no longer works
/// falls back to the default rather than failing every run — Klide keeps
/// working on the built-in folder, and Settings says why.
///
/// "No longer works" is what `override_problem` can see without writing: gone,
/// stranded on an unplugged drive, replaced by a file, chmod'd read-only. A
/// read-only *mount* gets past all of that and is caught where a write is
/// affordable — `app_storage_dirs` reports it, and `validate_target` refuses to
/// select one in the first place.
pub fn runs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let default = default_runs_dir(app)?;
    if let Some(chosen) = read_config().runs_dir {
        let path = PathBuf::from(&chosen);
        // Creation is the last word: a folder that inspects clean but cannot be
        // made still falls through to the default. Note that `create_dir_all`
        // returns Ok for a directory that already exists, whatever its
        // permissions — which is exactly why the read-only check sits above.
        if override_problem(&path).is_none() && std::fs::create_dir_all(&path).is_ok() {
            return Ok(path);
        }
    }
    std::fs::create_dir_all(&default)
        .map_err(|e| format!("Unable to create {}: {e}", default.display()))?;
    Ok(default)
}

/// What a caller may hand `app_storage_set_runs_dir`. Kept separate from
/// `override_problem` because choosing a folder deserves stricter answers than
/// tolerating one that already exists.
fn validate_target(target: &Path, current: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("Choose an absolute path.".to_string());
    }
    if target == current {
        return Err("That is already the transcript folder.".to_string());
    }
    if target.starts_with(current) {
        return Err("Choose a folder outside the current one — nesting it inside would move the folder into itself.".to_string());
    }
    if target.exists() && !target.is_dir() {
        return Err(format!("{} is a file, not a folder.", target.display()));
    }
    // Whether the folder was ours to make, so a failed probe can undo it: a
    // rejected choice must not leave an empty folder where the user browsed.
    let created = !target.exists();
    std::fs::create_dir_all(target).map_err(|e| format!("Cannot use {}: {e}", target.display()))?;
    // Writability is worth proving now rather than at the first run's first
    // event — a read-only volume looks fine until something needs saving.
    if let Some(problem) = write_problem(target) {
        if created {
            std::fs::remove_dir(target).ok();
        }
        return Err(problem);
    }
    Ok(())
}

/// Is this one of Klide's own transcript files? Run ids are minted as
/// `run_{ts}_{hex}` but also arrive as conversation ids, so the name is no
/// guide — the suffix is. Anything else in the folder belongs to whoever put it
/// there: a chosen folder is a place on the user's disk, not Klide's to empty.
fn is_transcript_file(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    name.ends_with(".jsonl") || name.ends_with(".summary.json")
}

/// Is this a run's folder? A Run keeps its file checkpoints in
/// `<runs>/<run id>/checkpoints` (see `agent::mod`) and its retained tool
/// outputs in `<runs>/<run id>.values` (see `agent::retained`), so the runs dir
/// is not flat after all, and a move that only carried files would leave every
/// rollback and every retained output behind — silently, since the transcript
/// they belong to arrived.
fn is_run_folder(path: &Path) -> bool {
    if path.join("checkpoints").is_dir() {
        return true;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".values"))
}

/// Move one entry, `rename` first (instant on the same volume), copy-then-remove
/// across volumes. Directories recurse, because `fs::rename` is the only part of
/// this the standard library does for a whole tree.
fn move_entry(source: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(source, dest).is_ok() {
        return Ok(());
    }
    if source.is_dir() {
        std::fs::create_dir_all(dest)
            .map_err(|e| format!("Could not create {}: {e}", dest.display()))?;
        let entries = std::fs::read_dir(source)
            .map_err(|e| format!("Could not read {}: {e}", source.display()))?;
        for entry in entries.flatten() {
            move_entry(&entry.path(), &dest.join(entry.file_name()))?;
        }
        std::fs::remove_dir(source).ok();
        return Ok(());
    }
    std::fs::copy(source, dest).map_err(|e| {
        format!(
            "Could not copy {} to {}: {e}",
            source.display(),
            dest.display()
        )
    })?;
    std::fs::remove_file(source).ok();
    Ok(())
}

/// Move every transcript — and every run's checkpoints — from one folder to the
/// other. A file that will not move stops the move and is reported: half a
/// folder silently left behind is worse than an error, because the runs it holds
/// would look deleted.
///
/// Only Klide's own artifacts move. The folder is a place the user chose, and it
/// may well be one they keep other things in; "Use default" must not sweep those
/// into Klide's app data. Anything unrecognised is counted and reported so the
/// caller can say what stayed put, rather than leaving it to be discovered.
fn move_runs(from: &Path, to: &Path) -> Result<(usize, u64, usize), String> {
    if !from.exists() {
        return Ok((0, 0, 0));
    }
    let entries =
        std::fs::read_dir(from).map_err(|e| format!("Could not read {}: {e}", from.display()))?;
    let mut moved = 0;
    let mut bytes = 0;
    let mut left = 0;
    for entry in entries.flatten() {
        let source = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let ours = if meta.is_dir() {
            is_run_folder(&source)
        } else if meta.is_file() {
            is_transcript_file(&entry.file_name())
        } else {
            false
        };
        if !ours {
            left += 1;
            continue;
        }
        let dest = to.join(entry.file_name());
        if dest.exists() {
            // Same run id in both folders: keep the destination, which is the
            // one the app will read from now.
            continue;
        }
        move_entry(&source, &dest)?;
        moved += 1;
        bytes += if meta.is_dir() {
            measure(&dest, 0).1
        } else {
            meta.len()
        };
    }
    Ok((moved, bytes, left))
}

/// The outcome of changing the folder — what Settings reports back.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsDirChange {
    pub path: String,
    pub custom: bool,
    pub moved_files: usize,
    pub moved_bytes: u64,
    /// Entries in the old folder that were not Klide's to move. Zero for a
    /// folder Klide made; non-zero when the user pointed it somewhere they
    /// keep other things, and Settings says so rather than let them wonder.
    pub left_behind: usize,
}

#[tauri::command]
pub async fn app_storage_set_runs_dir(
    app: tauri::AppHandle,
    path: String,
    move_existing: bool,
) -> Result<RunsDirChange, String> {
    let _guard = RUN_STORAGE_GATE.lock().await;
    let target = PathBuf::from(path.trim());
    // Resolving the current folder touches the filesystem, so it belongs inside
    // the blocking task with the rest — a Tauri command body runs on the UI
    // thread until it awaits, and this module's whole point is not to freeze it.
    tokio::task::spawn_blocking(move || {
        crate::agent::ensure_storage_idle(&app)?;
        let current = runs_dir(&app)?;
        validate_target(&target, &current)?;
        let (moved_files, moved_bytes, left_behind) = if move_existing {
            move_runs(&current, &target)?
        } else {
            (0, 0, 0)
        };
        // Recorded after the move, so a move that fails leaves every transcript
        // where the app is still looking for it. The other order of that coin:
        // if the move lands and recording it does not, the transcripts are at
        // the target while the app still reads the source — so carry them back
        // before reporting, rather than leave the two halves disagreeing.
        if let Err(e) = write_config(&StorageConfig {
            runs_dir: Some(target.to_string_lossy().to_string()),
        }) {
            if moved_files > 0 {
                move_runs(&target, &current).ok();
            }
            return Err(e);
        }
        Ok(RunsDirChange {
            path: target.to_string_lossy().to_string(),
            custom: true,
            moved_files,
            moved_bytes,
            left_behind,
        })
    })
    .await
    .map_err(|e| format!("Changing the transcript folder failed: {e}"))?
}

#[tauri::command]
pub async fn app_storage_reset_runs_dir(
    app: tauri::AppHandle,
    move_existing: bool,
) -> Result<RunsDirChange, String> {
    let _guard = RUN_STORAGE_GATE.lock().await;
    tokio::task::spawn_blocking(move || {
        crate::agent::ensure_storage_idle(&app)?;
        let current = runs_dir(&app)?;
        let default = default_runs_dir(&app)?;
        if current == default {
            return Ok(RunsDirChange {
                path: default.to_string_lossy().to_string(),
                custom: false,
                moved_files: 0,
                moved_bytes: 0,
                left_behind: 0,
            });
        }
        std::fs::create_dir_all(&default)
            .map_err(|e| format!("Unable to create {}: {e}", default.display()))?;
        let (moved_files, moved_bytes, left_behind) = if move_existing {
            move_runs(&current, &default)?
        } else {
            (0, 0, 0)
        };
        if let Err(e) = write_config(&StorageConfig { runs_dir: None }) {
            if moved_files > 0 {
                move_runs(&default, &current).ok();
            }
            return Err(e);
        }
        Ok(RunsDirChange {
            path: default.to_string_lossy().to_string(),
            custom: false,
            moved_files,
            moved_bytes,
            left_behind,
        })
    })
    .await
    .map_err(|e| format!("Restoring the transcript folder failed: {e}"))?
}

#[tauri::command]
pub async fn app_storage_dirs(app: tauri::AppHandle) -> Result<Vec<StorageDir>, String> {
    tokio::task::spawn_blocking(move || {
        let runs = dir_for(&app, "runs")?;
        let root = dir_for(&app, "app-data")?;
        let default_runs = default_runs_dir(&app)?;
        // A chosen folder that no longer works: `runs_dir` already fell back, so
        // say which one was skipped and why rather than showing a healthy
        // default. Settings is also the one place a write probe is affordable,
        // so this is where a read-only *mount* — invisible to the permission
        // bits `runs_dir` checks — gets named instead of failing every append.
        let warning = read_config().runs_dir.map(PathBuf::from).and_then(|chosen| {
            override_problem(&chosen)
                .or_else(|| chosen.is_dir().then(|| write_problem(&chosen)).flatten())
                .map(|why| format!("{why} Using the default folder."))
        });
        let (run_files, run_bytes) = measure(&runs, 0);
        let (all_files, all_bytes) = measure(&root, 0);
        let custom = runs != default_runs;
        Ok(vec![
            StorageDir {
                kind: "runs".into(),
                label: "Run transcripts".into(),
                detail: "Every agent run's events and summary — the durable record behind Mission Control.".into(),
                path: runs.to_string_lossy().to_string(),
                files: run_files,
                bytes: run_bytes,
                custom,
                default_path: default_runs.to_string_lossy().to_string(),
                warning,
            },
            StorageDir {
                kind: "app-data".into(),
                label: "Klide app data".into(),
                detail: "Settings, caches, and — unless you moved them — the transcripts above.".into(),
                path: root.to_string_lossy().to_string(),
                files: all_files,
                bytes: all_bytes,
                custom: false,
                default_path: root.to_string_lossy().to_string(),
                warning: None,
            },
        ])
    })
    .await
    .map_err(|e| format!("Storage measurement failed: {e}"))?
}

#[tauri::command]
pub async fn app_storage_reveal(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    let dir = dir_for(&app, &kind)?;
    tokio::task::spawn_blocking(move || {
        // Reveal wants something that exists; the runs dir is only created when
        // the first run is written.
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Unable to create {}: {e}", dir.display()))?;
        tauri_plugin_opener::reveal_item_in_dir(&dir)
            .map_err(|e| format!("Unable to reveal in Finder: {e}"))
    })
    .await
    .map_err(|e| format!("Reveal task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_counts_files_and_bytes_under_the_depth_bound() {
        let dir = std::env::temp_dir().join(format!("klide-storage-{}", std::process::id()));
        let nested = dir.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(dir.join("top.jsonl"), b"12345").unwrap();
        std::fs::write(nested.join("deep.jsonl"), b"123").unwrap();

        let (files, bytes) = measure(&dir, 0);
        assert_eq!(files, 2);
        assert_eq!(bytes, 8);

        // Starting past the bound measures nothing rather than walking anyway.
        assert_eq!(measure(&dir, MAX_DEPTH + 1), (0, 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fresh temp dir, unique per test name so cases cannot collide.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-storage-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_target_folder_must_be_absolute_new_and_writable() {
        let root = scratch("target");
        let current = root.join("current");
        std::fs::create_dir_all(&current).unwrap();

        assert!(validate_target(Path::new("relative/runs"), &current).is_err());
        assert!(validate_target(&current, &current).is_err());
        // Nesting the destination inside the source would move it into itself.
        assert!(validate_target(&current.join("inner"), &current).is_err());

        let file = root.join("a-file");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_target(&file, &current).is_err());

        let good = root.join("elsewhere");
        assert!(validate_target(&good, &current).is_ok());
        assert!(good.is_dir(), "a valid target is created, ready to receive");
        // The write probe cleans up after itself.
        assert!(!good.join(".klide-write-probe").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn moving_carries_the_transcripts_and_leaves_nothing_behind() {
        let root = scratch("move");
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(from.join("run_a.jsonl"), b"12345").unwrap();
        std::fs::write(from.join("run_a.summary.json"), b"123").unwrap();
        // A run id already present at the destination keeps the destination's
        // copy — that is the one the app reads from now.
        std::fs::write(from.join("run_b.jsonl"), b"old").unwrap();
        std::fs::write(to.join("run_b.jsonl"), b"kept").unwrap();

        let (moved, bytes, left) = move_runs(&from, &to).unwrap();
        assert_eq!((moved, bytes, left), (2, 8, 0));
        assert!(to.join("run_a.jsonl").exists());
        assert!(!from.join("run_a.jsonl").exists());
        assert_eq!(std::fs::read(to.join("run_b.jsonl")).unwrap(), b"kept");

        // Moving from a folder that was never created is not an error.
        assert_eq!(move_runs(&root.join("absent"), &to).unwrap(), (0, 0, 0));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_runs_checkpoint_folder_travels_with_its_transcript() {
        // The runs dir is not flat: a Run keeps its file checkpoints in
        // `<runs>/<run id>/checkpoints`. A move that carried only files would
        // land the transcript and strand every rollback that belongs to it —
        // and say nothing, because the transcript arrived.
        let root = scratch("checkpoints");
        let from = root.join("from");
        let to = root.join("to");
        let checkpoints = from.join("run_a").join("checkpoints");
        std::fs::create_dir_all(&checkpoints).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(from.join("run_a.jsonl"), b"12345").unwrap();
        std::fs::write(checkpoints.join("src.rs"), b"before").unwrap();

        let (moved, _, left) = move_runs(&from, &to).unwrap();
        assert_eq!((moved, left), (2, 0));
        assert_eq!(
            std::fs::read(to.join("run_a").join("checkpoints").join("src.rs")).unwrap(),
            b"before",
        );
        assert!(!from.join("run_a").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_runs_retained_values_travel_with_its_transcript() {
        // Retained tool outputs live in `<runs>/<run id>.values`, a sibling of
        // the transcript. Left behind, a resumed run would replay the full
        // result in place of the stub — graceful, but the retained text the
        // user paid for is gone and reported as "not ours".
        let root = scratch("values");
        let from = root.join("from");
        let to = root.join("to");
        let values = from.join("run_a.values");
        std::fs::create_dir_all(&values).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(from.join("run_a.jsonl"), b"12345").unwrap();
        std::fs::write(values.join("call_1.txt"), b"retained").unwrap();

        let (moved, _, left) = move_runs(&from, &to).unwrap();
        assert_eq!((moved, left), (2, 0));
        assert_eq!(
            std::fs::read(to.join("run_a.values").join("call_1.txt")).unwrap(),
            b"retained",
        );
        assert!(!from.join("run_a.values").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_chosen_folder_keeps_whatever_else_the_user_put_in_it() {
        // The folder is a place on someone's disk, and "Use default" must not
        // sweep it into Klide's app data. Only transcripts and run folders move;
        // the rest is counted so Settings can say what stayed.
        let root = scratch("theirs");
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::create_dir_all(from.join("Photos")).unwrap();
        std::fs::write(from.join("run_a.jsonl"), b"12345").unwrap();
        std::fs::write(from.join("taxes.pdf"), b"not klide's").unwrap();
        std::fs::write(from.join("notes.md"), b"nor this").unwrap();

        let (moved, bytes, left) = move_runs(&from, &to).unwrap();
        assert_eq!((moved, bytes, left), (1, 5, 3));
        assert!(from.join("taxes.pdf").exists(), "the user's file stays put");
        assert!(from.join("notes.md").exists());
        assert!(
            from.join("Photos").is_dir(),
            "a folder with no checkpoints is not ours"
        );
        assert!(!to.join("taxes.pdf").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unusable_override_is_reported_rather_than_obeyed() {
        let root = scratch("override");

        // A folder Klide would create on first use is fine…
        let fresh = root.join("not-yet");
        assert!(override_problem(&fresh).is_none());
        // …and asking must not have created it: a probe that repairs what it is
        // inspecting can never report a missing folder.
        assert!(!fresh.exists(), "inspection must not create anything");

        // …but one whose parent is gone is an unplugged drive.
        let stranded = root.join("gone").join("deeper");
        assert!(override_problem(&stranded).unwrap().contains("unreachable"));

        let file = root.join("not-a-folder");
        std::fs::write(&file, b"x").unwrap();
        assert!(override_problem(&file).unwrap().contains("is a file"));
        assert!(override_problem(Path::new("runs"))
            .unwrap()
            .contains("absolute"));

        let existing = root.join("already");
        std::fs::create_dir_all(&existing).unwrap();
        assert!(override_problem(&existing).is_none());

        // `create_dir_all` returns Ok for a directory that already exists,
        // whatever its permissions — so a read-only folder used to resolve
        // clean and then fail every single append, with nothing said anywhere.
        let locked = root.join("read-only");
        std::fs::create_dir_all(&locked).unwrap();
        set_readonly(&locked, true);
        assert!(
            std::fs::create_dir_all(&locked).is_ok(),
            "the trap this guards"
        );
        assert!(override_problem(&locked).unwrap().contains("read-only"));
        assert!(write_problem(&locked).is_some());

        set_readonly(&locked, false);
        assert!(write_problem(&locked).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    fn set_readonly(path: &Path, readonly: bool) {
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_readonly(readonly);
        std::fs::set_permissions(path, perms).unwrap();
    }

    #[test]
    fn a_rejected_target_leaves_no_folder_behind() {
        // Choosing a folder that turns out to be unwritable must not litter the
        // disk with the empty folder the attempt created.
        let root = scratch("rejected");
        let current = root.join("current");
        std::fs::create_dir_all(&current).unwrap();

        let parent = root.join("locked-parent");
        std::fs::create_dir_all(&parent).unwrap();
        set_readonly(&parent, true);

        let target = parent.join("runs");
        assert!(validate_target(&target, &current).is_err());
        assert!(!target.exists(), "a refused choice creates nothing lasting");

        set_readonly(&parent, false);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn only_klide_owned_directories_can_be_named() {
        assert_eq!(relative_for("runs").unwrap(), "runs");
        assert_eq!(relative_for("app-data").unwrap(), "");
        // A caller's string never becomes a path component.
        for hostile in ["../../etc", "/etc", "runs/../..", "", "RUNS"] {
            assert!(relative_for(hostile).is_err(), "{hostile} must be refused");
        }
    }
}

#[cfg(test)]
mod conversation_storage_tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "klide-history-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    fn saved(root: &Path, id: &str, text: &str) {
        let summary = serde_json::json!({"id": id, "path": "", "source": "klide", "title": id,
            "status": "done", "provider": "opencode", "model": "test", "createdMs": 1,
            "updatedMs": 2, "messageCount": 1});
        std::fs::write(root.join(format!("{id}.summary.json")), summary.to_string()).unwrap();
        std::fs::write(root.join(format!("{id}.jsonl")), text).unwrap();
    }
    #[test]
    fn measures_largest_first_and_deletes_only_selected_history() {
        let root = fixture();
        saved(&root, "small", "a");
        saved(&root, "large", &"a".repeat(1000));
        std::fs::create_dir_all(root.join("large/checkpoints")).unwrap();
        std::fs::write(root.join("large/checkpoints/saved"), "backup").unwrap();
        std::fs::write(root.join("large/unrelated"), "keep").unwrap();
        std::fs::create_dir_all(root.join("large.values")).unwrap();
        std::fs::write(root.join("large.values/result"), "output").unwrap();
        let rows = stored_runs(&root).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "large");
        assert_eq!(rows[0].transcript_bytes, 1000);
        assert!(rows[0].supporting_bytes >= 12);
        delete_stored_run(&root, "large").unwrap();
        assert!(!root.join("large.jsonl").exists());
        assert!(!root.join("large.summary.json").exists());
        assert!(!root.join("large/checkpoints").exists());
        assert!(!root.join("large.values").exists());
        assert!(root.join("large/unrelated").exists());
        assert!(root.join("small.jsonl").exists());
        assert_eq!(stored_runs(&root).unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_unknown_ids_and_path_escape() {
        let root = fixture();
        std::fs::write(root.join("unknown.jsonl"), "keep").unwrap();
        assert!(delete_stored_run(&root, "unknown").is_err());
        assert!(delete_stored_run(&root, "../outside").is_err());
        assert!(root.join("unknown.jsonl").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn refuses_linked_storage_without_touching_target() {
        let root = fixture();
        let outside = fixture();
        saved(&root, "linked", "history");
        std::fs::write(outside.join("keep"), "safe").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked.values")).unwrap();
        assert!(delete_stored_run(&root, "linked").is_err());
        assert!(outside.join("keep").exists());
        assert!(root.join("linked.jsonl").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
