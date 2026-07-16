//! Crash-loop quarantine for agent runs (the Local Studio "launch failure
//! budget" pattern, docs/competitors-local-studio.md).
//!
//! A conversation whose runs keep erroring — provider down, bad key, model
//! not pulled — should stop being re-dispatched in a tight loop, whether the
//! retries come from a human hammering send or from an orchestration layer
//! (mission chain, race, goal loop). The budget records terminal outcomes per
//! conversation id and refuses a new start when the recent history is all
//! failures.
//!
//! Klide's runs fail fast (seconds), unlike Local Studio's minutes-long model
//! launches, so a flat 10-minute lockout would punish a user who already
//! fixed the cause (started Ollama, pasted a key). Instead a block needs BOTH:
//!   - `FAILURE_LIMIT` failures inside `FAILURE_WINDOW_MS`, and
//!   - the most recent failure younger than `COOLDOWN_MS`.
//! Tight retry loops trip it immediately; a human retrying a minute after the
//! last failure passes. Switching provider or model resets the entry (their
//! "edit the recipe" escape hatch), and a successful run clears it.

use std::collections::HashMap;
use std::sync::Mutex;

pub const FAILURE_LIMIT: usize = 3;
pub const FAILURE_WINDOW_MS: i64 = 10 * 60 * 1000;
pub const COOLDOWN_MS: i64 = 60 * 1000;

struct Entry {
    provider: String,
    model: String,
    failures_ms: Vec<i64>,
}

#[derive(Default)]
pub struct FailureBudget {
    entries: Mutex<HashMap<String, Entry>>,
}

impl FailureBudget {
    /// Refuse-or-allow gate for starting a run. `Some(reason)` means blocked.
    pub fn check(&self, id: &str, provider: &str, model: &str, now: i64) -> Option<String> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.get_mut(id)?;
        if entry.provider != provider || entry.model != model {
            // A different provider/model is a fresh chance — the failing
            // configuration is what's quarantined, not the conversation.
            entries.remove(id);
            return None;
        }
        prune(entry, now);
        let last = *entry.failures_ms.last()?;
        if entry.failures_ms.len() < FAILURE_LIMIT || now - last >= COOLDOWN_MS {
            return None;
        }
        let wait_s = ((COOLDOWN_MS - (now - last)) as f64 / 1000.0).ceil() as i64;
        Some(format!(
            "{count} runs failed in the last {window} min with {provider}/{model}. \
             Check the provider (server running? key valid? model available?), then retry \
             in {wait_s}s — or switch model to skip the cooldown.",
            count = entry.failures_ms.len(),
            window = FAILURE_WINDOW_MS / 60_000,
        ))
    }

    pub fn record_failure(&self, id: &str, provider: &str, model: &str, now: i64) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let entry = entries.entry(id.to_string()).or_insert_with(|| Entry {
            provider: provider.to_string(),
            model: model.to_string(),
            failures_ms: Vec::new(),
        });
        if entry.provider != provider || entry.model != model {
            entry.provider = provider.to_string();
            entry.model = model.to_string();
            entry.failures_ms.clear();
        }
        entry.failures_ms.push(now);
        prune(entry, now);
    }

    pub fn record_success(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(id);
        }
    }
}

fn prune(entry: &mut Entry, now: i64) {
    entry.failures_ms.retain(|ts| now - ts < FAILURE_WINDOW_MS);
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;

    fn failed_thrice(budget: &FailureBudget, id: &str) {
        for i in 0..3 {
            budget.record_failure(id, "ollama", "llama3.1:8b", T0 + i * 1_000);
        }
    }

    #[test]
    fn blocks_a_tight_failure_loop() {
        let budget = FailureBudget::default();
        failed_thrice(&budget, "run-1");
        let reason = budget.check("run-1", "ollama", "llama3.1:8b", T0 + 3_000);
        assert!(reason.is_some());
        assert!(reason.unwrap().contains("3 runs failed"));
    }

    #[test]
    fn allows_under_the_limit() {
        let budget = FailureBudget::default();
        budget.record_failure("run-1", "ollama", "llama3.1:8b", T0);
        budget.record_failure("run-1", "ollama", "llama3.1:8b", T0 + 1_000);
        assert!(budget
            .check("run-1", "ollama", "llama3.1:8b", T0 + 2_000)
            .is_none());
    }

    #[test]
    fn unblocks_once_the_cooldown_since_the_last_failure_passes() {
        let budget = FailureBudget::default();
        failed_thrice(&budget, "run-1");
        let later = T0 + 2_000 + COOLDOWN_MS;
        assert!(budget
            .check("run-1", "ollama", "llama3.1:8b", later)
            .is_none());
    }

    #[test]
    fn old_failures_age_out_of_the_window() {
        let budget = FailureBudget::default();
        failed_thrice(&budget, "run-1");
        // A single fresh failure long after: the three old ones are pruned,
        // so one failure inside the window is not enough to block.
        let later = T0 + FAILURE_WINDOW_MS + 10_000;
        budget.record_failure("run-1", "ollama", "llama3.1:8b", later);
        assert!(budget
            .check("run-1", "ollama", "llama3.1:8b", later + 1_000)
            .is_none());
    }

    #[test]
    fn success_clears_the_entry() {
        let budget = FailureBudget::default();
        failed_thrice(&budget, "run-1");
        budget.record_success("run-1");
        assert!(budget
            .check("run-1", "ollama", "llama3.1:8b", T0 + 3_000)
            .is_none());
    }

    #[test]
    fn switching_model_resets_the_budget() {
        let budget = FailureBudget::default();
        failed_thrice(&budget, "run-1");
        assert!(budget
            .check("run-1", "ollama", "qwen2.5:7b", T0 + 3_000)
            .is_none());
        // And the old entry is gone: the original model gets a fresh start too.
        assert!(budget
            .check("run-1", "ollama", "llama3.1:8b", T0 + 4_000)
            .is_none());
    }

    #[test]
    fn failure_on_a_new_model_starts_a_fresh_count() {
        let budget = FailureBudget::default();
        failed_thrice(&budget, "run-1");
        budget.record_failure("run-1", "ollama", "qwen2.5:7b", T0 + 5_000);
        assert!(budget
            .check("run-1", "ollama", "qwen2.5:7b", T0 + 6_000)
            .is_none());
    }
}
