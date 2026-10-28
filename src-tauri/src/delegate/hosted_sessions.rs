//! The CLI sessions Klide's own conversations drive headless.
//!
//! A Focus conversation on a Delegate talks to a real CLI session, and the CLI
//! saves that session where Mission Control imports it from — so without this
//! the board shows the conversation twice: Klide's row and the CLI's copy. A
//! cold start is recognisable by its preamble (`AgentRun::klide_hosted`), but
//! a conversation carried in from the CLI (`klide://resume`, `open_cli_session`)
//! continues a session the person started, and a CLI may fork a new id on
//! resume. Neither leaves a mark in the log, so the ids are recorded here, as
//! each turn learns them.
//!
//! Append-only (`~/.klide/hosted_sessions.jsonl`, one `{provider, session}` per
//! line) because the app and `klide ptyd` both run turns; an append never
//! loses the other writer's line.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

type Ids = HashSet<(String, String)>;

fn registry_path() -> Option<PathBuf> {
    #[cfg(test)]
    {
        TEST_PATH.with(|p| p.borrow().clone())
    }
    #[cfg(not(test))]
    {
        crate::cli::home_dir_path().map(|home| home.join(".klide").join("hosted_sessions.jsonl"))
    }
}

#[cfg(test)]
thread_local! {
    /// Tests never write the person's `~/.klide`; one that wants the registry
    /// points it at a temp file.
    static TEST_PATH: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn use_test_path(path: Option<PathBuf>) {
    TEST_PATH.with(|p| *p.borrow_mut() = path);
}

/// What this process already wrote, so a turn that resumes a known session
/// costs a lock, not a line.
static WRITTEN: Mutex<Option<Ids>> = Mutex::new(None);

/// Remember that a Klide conversation drives `session` of `provider`.
pub(crate) fn record(provider: &str, session: &str) {
    let session = session.trim();
    if session.is_empty() {
        return;
    }
    let Some(path) = registry_path() else { return };
    let id = (provider.to_string(), session.to_string());
    {
        let Ok(mut written) = WRITTEN.lock() else { return };
        if !written.get_or_insert_with(HashSet::new).insert(id) {
            return;
        }
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let line = serde_json::json!({ "provider": provider, "session": session }).to_string();
    let _ = crate::durable::append_line_unsynced(&path, &line);
}

static READ: crate::file_memo::FileMemo<Arc<Ids>> = crate::file_memo::FileMemo::new();

/// Every `(provider, session)` recorded, by any process. Re-read only when the
/// file moved.
pub(crate) fn all() -> Arc<Ids> {
    let Some(path) = registry_path() else { return Arc::default() };
    READ.get_or_compute(&path, 0, |path| Arc::new(read(path)))
}

fn read(path: &Path) -> Ids {
    let Ok(content) = std::fs::read_to_string(path) else { return Ids::new() };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|v| Some((v.get("provider")?.as_str()?.to_string(), v.get("session")?.as_str()?.to_string())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_session_is_read_back_once_and_a_torn_line_is_skipped() {
        let dir = std::env::temp_dir().join("klide-hosted-sessions-test");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("hosted_sessions.jsonl");
        use_test_path(Some(path.clone()));
        record("claude-code", "resumed-1");
        record("claude-code", "resumed-1");
        record("codex", " ");
        std::fs::OpenOptions::new().append(true).open(&path).and_then(|mut f| {
            std::io::Write::write_all(&mut f, br#"{"provider":"codex""#)
        }).unwrap();

        let ids = read(&path);
        assert_eq!(ids.len(), 1);
        assert!(ids.contains(&("claude-code".to_string(), "resumed-1".to_string())));
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 2, "one line per session, plus the torn one");
        use_test_path(None);
    }
}
