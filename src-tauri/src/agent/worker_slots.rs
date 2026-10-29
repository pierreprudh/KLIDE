//! Worker capacity — how many dispatched workers run at once, app-wide.
//!
//! Every `spawn_subagent` worker is a whole agent: a Delegate CLI is a process
//! with its own model traffic, an API worker is a Harness loop on a paid model.
//! Nothing used to bound them, so a parent (or three conversations) could start
//! ten at once. Decided 2026-10-26: a dispatch over the limit **waits** — it is
//! never refused. At most 4 API workers run at once, across every
//! conversation. Delegate CLI workers are not limited: tried at 2 in the app
//! on 2026-10-27, and Pierre wants none for now (a CLI runs on its own
//! subscription). A CLI pool is one more `Slots` if that changes.
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

pub const API_WORKERS: usize = 4;

/// A fair pool and the children waiting on it.
pub struct Slots {
    pool: Arc<Semaphore>,
    max: usize,
    queued: Mutex<HashMap<String, CancellationToken>>,
}

/// Why a queued child never started.
#[derive(Debug, PartialEq, Eq)]
pub enum NotStarted {
    Cancelled,
}

/// A dropped wait future must retire its queue entry too.
struct Queued<'a> { slots: &'a Slots, id: &'a str }
impl Drop for Queued<'_> {
    fn drop(&mut self) {
        if let Ok(mut queued) = self.slots.queued.lock() { queued.remove(self.id); }
    }
}

impl Slots {
    pub fn new(max: usize) -> Self {
        Self { pool: Arc::new(Semaphore::new(max)), max, queued: Mutex::new(HashMap::new()) }
    }

    /// Workers holding a slot right now.
    pub fn running(&self) -> usize {
        self.max - self.pool.available_permits()
    }

    /// Would a dispatch of this kind wait? Advisory: the answer can change
    /// before the child asks, and the child's own wait is what counts.
    pub fn full(&self) -> bool {
        self.pool.available_permits() == 0
    }

    /// Wait for a slot, in arrival order. Held for as long as the permit
    /// lives; `cancel_queued(child_id)` gives up the wait.
    pub async fn take(&self, child_id: &str) -> Result<OwnedSemaphorePermit, NotStarted> {
        if let Ok(permit) = self.pool.clone().try_acquire_owned() {
            return Ok(permit);
        }
        let token = CancellationToken::new();
        if let Ok(mut queued) = self.queued.lock() {
            queued.insert(child_id.to_string(), token.clone());
        }
        let _queued = Queued { slots: self, id: child_id };
        let outcome = tokio::select! {
            permit = self.pool.clone().acquire_owned() => permit.map_err(|_| NotStarted::Cancelled),
            _ = token.cancelled() => Err(NotStarted::Cancelled),
        };
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

    /// Children waiting for a slot right now.
    pub fn queued_count(&self) -> usize {
        self.queued.lock().map(|queued| queued.len()).unwrap_or(0)
    }

    pub fn usage(&self) -> Usage {
        Usage { limit: self.max, running: self.running(), queued: self.queued_count() }
    }
}

/// What a pool holds right now — what the orchestration console shows
/// instead of a fresh, empty planning state.
#[derive(Clone, Copy, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub limit: usize,
    pub running: usize,
    pub queued: usize,
}

/// Live API worker occupancy. Counters only, nothing blocks.
#[tauri::command]
pub async fn agent_worker_capacity() -> Usage {
    api_slots().usage()
}

/// The app's API worker pool.
pub fn api_slots() -> &'static Slots {
    static SLOTS: OnceLock<Slots> = OnceLock::new();
    SLOTS.get_or_init(|| Slots::new(API_WORKERS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_a_queued_wait_removes_its_status() {
        let slots = Arc::new(Slots::new(1));
        let _first = slots.take("queue-drop-first").await.unwrap();
        let waiting = {
            let slots = slots.clone();
            tokio::spawn(async move { slots.take("queue-drop-waiting").await })
        };
        tokio::task::yield_now().await;
        assert!(slots.is_queued("queue-drop-waiting"));
        waiting.abort();
        let _ = waiting.await;
        assert!(!slots.is_queued("queue-drop-waiting"));
    }

    #[tokio::test]
    async fn a_dispatch_over_the_limit_waits_and_starts_when_a_slot_frees() {
        let slots = Slots::new(2);
        let a = slots.take("a").await.unwrap();
        let _b = slots.take("b").await.unwrap();
        assert!(slots.full());
        assert_eq!(slots.running(), 2);

        let slots = Arc::new(slots);
        let waiting = {
            let slots = slots.clone();
            tokio::spawn(async move { slots.take("c").await.map(|_| ()) })
        };
        tokio::task::yield_now().await;
        assert!(slots.is_queued("c"));
        assert!(!waiting.is_finished());
        assert_eq!(slots.usage(), Usage { limit: 2, running: 2, queued: 1 });
        drop(a);
        assert_eq!(waiting.await.unwrap(), Ok(()));
        assert!(!slots.is_queued("c"));
        assert_eq!(slots.usage().queued, 0);
    }

    #[tokio::test]
    async fn a_queued_child_can_be_cancelled_before_it_starts() {
        let slots = Arc::new(Slots::new(1));
        let _held = slots.take("a").await.unwrap();
        let waiting = {
            let slots = slots.clone();
            tokio::spawn(async move { slots.take("b").await.map(|_| ()) })
        };
        tokio::task::yield_now().await;
        assert!(slots.cancel_queued("b"));
        assert_eq!(waiting.await.unwrap(), Err(NotStarted::Cancelled));
        assert!(!slots.cancel_queued("b"), "nothing left to cancel");
        // The slot is still held by `a`; no permit was taken by the cancelled wait.
        assert_eq!(slots.running(), 1);
    }

    #[tokio::test]
    async fn waiters_start_in_arrival_order() {
        let slots = Arc::new(Slots::new(1));
        let held = slots.take("a").await.unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut handles = vec![];
        for id in ["b", "c", "d"] {
            let (slots, order) = (slots.clone(), order.clone());
            handles.push(tokio::spawn(async move {
                let permit = slots.take(id).await.unwrap();
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
