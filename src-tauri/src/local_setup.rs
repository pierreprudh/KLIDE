//! One setup owner per provider, shared by every settings panel.
use serde::Serialize;
use std::{collections::HashMap, sync::{Mutex, OnceLock}};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}
impl Default for Progress {
    fn default() -> Self { Self { phase: "idle".into(), downloaded_bytes: 0, total_bytes: None, error: None } }
}
impl Progress {
    fn active(&self) -> bool { matches!(self.phase.as_str(), "checking" | "engine" | "model" | "loading") }
}
#[derive(Default)]
struct Tracker(Mutex<HashMap<String, Progress>>);
impl Tracker {
    fn begin(&self, provider: &str) -> Result<Setup<'_>, String> {
        let mut rows = self.0.lock().map_err(|e| e.to_string())?;
        if rows.get(provider).is_some_and(Progress::active) {
            return Err("Another local model operation is in progress. Follow its progress in Local AI.".into());
        }
        rows.insert(provider.into(), Progress { phase: "checking".into(), ..Default::default() });
        Ok(Setup { tracker: self, provider: provider.into(), finished: false })
    }
}
fn tracker() -> &'static Tracker {
    static TRACKER: OnceLock<Tracker> = OnceLock::new();
    TRACKER.get_or_init(Tracker::default)
}
pub struct Setup<'a> { tracker: &'a Tracker, provider: String, finished: bool }
impl Setup<'_> {
    pub fn finish<T>(mut self, result: &Result<T, String>) {
        if let Ok(mut rows) = self.tracker.0.lock() {
            rows.insert(self.provider.clone(), Progress {
                phase: if result.is_ok() { "idle" } else { "failed" }.into(),
                error: result.as_ref().err().cloned(), ..Default::default()
            });
        }
        self.finished = true;
    }
}
impl Drop for Setup<'_> {
    fn drop(&mut self) {
        if !self.finished {
            if let Ok(mut rows) = self.tracker.0.lock() {
                rows.insert(self.provider.clone(), Progress { phase: "failed".into(),
                    error: Some("Setup was interrupted. Start again to retry.".into()), ..Default::default() });
            }
        }
    }
}
pub fn begin(provider: &str) -> Result<Setup<'static>, String> { tracker().begin(provider) }
pub fn phase(provider: &str, phase: &str) {
    if let Ok(mut rows) = tracker().0.lock() {
        if let Some(row) = rows.get_mut(provider).filter(|r| r.active()) {
            *row = Progress { phase: phase.into(), ..Default::default() };
        }
    }
}
pub fn download(provider: &str, bytes: u64, total: Option<u64>) {
    if let Ok(mut rows) = tracker().0.lock() {
        if let Some(row) = rows.get_mut(provider).filter(|r| r.active()) {
            row.downloaded_bytes = bytes; row.total_bytes = total;
        }
    }
}
#[tauri::command]
pub fn ai_local_setup_progress(provider: String) -> Progress {
    tracker().0.lock().ok().and_then(|rows| rows.get(&provider).cloned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_duplicate_setup_and_releases_after_failure() {
        let t = Tracker::default();
        let first = t.begin("llamacpp").unwrap();
        assert!(t.begin("llamacpp").is_err());
        first.finish::<()>(&Err("Checksum mismatch".into()));
        assert_eq!(t.0.lock().unwrap()["llamacpp"].error.as_deref(), Some("Checksum mismatch"));
        assert!(t.begin("llamacpp").is_ok());
    }
    #[test]
    fn interrupted_setup_is_retryable_and_does_not_claim_readiness() {
        let t = Tracker::default();
        drop(t.begin("llamacpp").unwrap());
        assert_eq!(t.0.lock().unwrap()["llamacpp"].phase, "failed");
        t.begin("llamacpp").unwrap().finish(&Ok(()));
        assert_eq!(t.0.lock().unwrap()["llamacpp"].phase, "idle");
    }
}
