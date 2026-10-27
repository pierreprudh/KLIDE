//! Worker capacity — how many dispatched workers run at once, app-wide.
//!
//! Every `spawn_subagent` worker is a whole agent: a Delegate CLI is a process
//! with its own model traffic, an API worker is a Harness loop on a paid model.
//! Nothing used to bound them, so a parent (or three conversations) could start
//! ten at once. Decided 2026-10-26: a dispatch over the limit **waits** — it is
//! never refused — and the defaults are 2 Delegate CLI workers and 4 API
//! workers running at once, across every conversation.
//!
//! The wait sits in front of the child Run, not the dispatch: the card, the
//! worktree and its setup happen as before, and a background dispatch still
//! returns at once. The child starts when a slot frees, in arrival order
//! (tokio's semaphore is fair). A queued child has no Run handle yet, so a
//! cancel reaches it here instead (`cancel_queued`).
//!
//! A plain read-only subagent takes no slot: it runs on the parent's own
//! model, inside the parent's turn, and is bounded by it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

pub const CLI_WORKERS: usize = 2;
pub const API_WORKERS: usize = 4;

/// Which pool a worker draws from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotKind {
    /// A Delegate CLI (Claude Code, Codex, …).
    Cli,
    /// Klide's Harness on another provider's model.
    Api,
}

impl SlotKind {
    /// "Claude Code workers" reads better, but the pool is shared by every
    /// CLI, so the noun is the kind.
    pub fn noun(self) -> &'static str {
        match self {
            SlotKind::Cli => "CLI",
            SlotKind::Api => "API",
        }
    }
}

/// Two fair pools and the children waiting on them.
pub struct Slots {
    cli: Arc<Semaphore>,
    api: Arc<Semaphore>,
    cli_max: usize,
    api_max: usize,
    queued: Mutex<HashMap<String, CancellationToken>>,
}

/// Why a queued child never started.
#[derive(Debug, PartialEq, Eq)]
pub enum NotStarted {
    Cancelled,
}

impl Slots {
    pub fn new(cli_max: usize, api_max: usize) -> Self {
        Self {
            cli: Arc::new(Semaphore::new(cli_max)),
            api: Arc::new(Semaphore::new(api_max)),
            cli_max,
            api_max,
            queued: Mutex::new(HashMap::new()),
        }
    }

    fn pool(&self, kind: SlotKind) -> &Arc<Semaphore> {
        match kind {
            SlotKind::Cli => &self.cli,
            SlotKind::Api => &self.api,
        }
    }

    pub fn max(&self, kind: SlotKind) -> usize {
        match kind {
            SlotKind::Cli => self.cli_max,
            SlotKind::Api => self.api_max,
        }
    }

    /// Workers of this kind running right now.
    pub fn running(&self, kind: SlotKind) -> usize {
        self.max(kind) - self.pool(kind).available_permits()
    }

    /// Would a dispatch of this kind wait? Advisory: the answer can change
    /// before the child asks, and the child's own wait is what counts.
    pub fn full(&self, kind: SlotKind) -> bool {
        self.pool(kind).available_permits() == 0
    }

    /// Wait for a slot, in arrival order. Held for as long as the permit
    /// lives; `cancel_queued(child_id)` gives up the wait.
    pub async fn take(&self, kind: SlotKind, child_id: &str) -> Result<OwnedSemaphorePermit, NotStarted> {
        if let Ok(permit) = self.pool(kind).clone().try_acquire_owned() {
            return Ok(permit);
        }
        let token = CancellationToken::new();
        if let Ok(mut queued) = self.queued.lock() {
            queued.insert(child_id.to_string(), token.clone());
        }
        let outcome = tokio::select! {
            permit = self.pool(kind).clone().acquire_owned() => permit.map_err(|_| NotStarted::Cancelled),
            _ = token.cancelled() => Err(NotStarted::Cancelled),
        };
        if let Ok(mut queued) = self.queued.lock() {
            queued.remove(child_id);
        }
        outcome
    }

    /// Stop a child that is still waiting for a slot. False when it is not
    /// queued (it already started, or never was).
    pub fn cancel_queued(&self, child_id: &str) -> bool {
        let token = self.queued.lock().ok().and_then(|queued| queued.get(child_id).cloned());
        token.map(|t| t.cancel()).is_some()
    }

    pub fn is_queued(&self, child_id: &str) -> bool {
        self.queued.lock().is_ok_and(|queued| queued.contains_key(child_id))
    }
}

/// The app's pools.
pub fn slots() -> &'static Slots {
    static SLOTS: OnceLock<Slots> = OnceLock::new();
    SLOTS.get_or_init(|| Slots::new(CLI_WORKERS, API_WORKERS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_dispatch_over_the_limit_waits_and_starts_when_a_slot_frees() {
        let slots = Slots::new(2, 4);
        let a = slots.take(SlotKind::Cli, "a").await.unwrap();
        let _b = slots.take(SlotKind::Cli, "b").await.unwrap();
        assert!(slots.full(SlotKind::Cli));
        assert_eq!(slots.running(SlotKind::Cli), 2);
        // The other pool is untouched.
        assert!(!slots.full(SlotKind::Api));

        let slots = Arc::new(slots);
        let waiting = {
            let slots = slots.clone();
            tokio::spawn(async move { slots.take(SlotKind::Cli, "c").await.map(|_| ()) })
        };
        tokio::task::yield_now().await;
        assert!(slots.is_queued("c"));
        assert!(!waiting.is_finished());
        drop(a);
        assert_eq!(waiting.await.unwrap(), Ok(()));
        assert!(!slots.is_queued("c"));
    }

    #[tokio::test]
    async fn a_queued_child_can_be_cancelled_before_it_starts() {
        let slots = Arc::new(Slots::new(1, 1));
        let _held = slots.take(SlotKind::Api, "a").await.unwrap();
        let waiting = {
            let slots = slots.clone();
            tokio::spawn(async move { slots.take(SlotKind::Api, "b").await.map(|_| ()) })
        };
        tokio::task::yield_now().await;
        assert!(slots.cancel_queued("b"));
        assert_eq!(waiting.await.unwrap(), Err(NotStarted::Cancelled));
        assert!(!slots.cancel_queued("b"), "nothing left to cancel");
        // The slot is still held by `a`; no permit was taken by the cancelled wait.
        assert_eq!(slots.running(SlotKind::Api), 1);
    }

    #[tokio::test]
    async fn waiters_start_in_arrival_order() {
        let slots = Arc::new(Slots::new(1, 1));
        let held = slots.take(SlotKind::Cli, "a").await.unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut handles = vec![];
        for id in ["b", "c", "d"] {
            let (slots, order) = (slots.clone(), order.clone());
            handles.push(tokio::spawn(async move {
                let permit = slots.take(SlotKind::Cli, id).await.unwrap();
                order.lock().unwrap().push(id);
                drop(permit);
            }));
            tokio::task::yield_now().await;
        }
        drop(held);
        for h in handles { h.await.unwrap(); }
        assert_eq!(*order.lock().unwrap(), vec!["b", "c", "d"]);
    }
}
