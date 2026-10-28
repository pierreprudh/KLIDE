//! The cancellation token for a child before its Run handle exists. The same
//! token is handed to Run host admission, so cancelling during setup, queuing
//! or the handoff to execution cannot miss the child. This owns no Run state.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

fn tokens() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) struct Dispatch {
    id: String,
    pub cancel: CancellationToken,
}

impl Dispatch {
    pub fn register(id: &str) -> Result<Self, String> {
        let mut tokens = tokens().lock().map_err(|_| "Dispatch state is unavailable")?;
        if tokens.contains_key(id) {
            return Err("This worker dispatch is already active".into());
        }
        let cancel = CancellationToken::new();
        tokens.insert(id.into(), cancel.clone());
        Ok(Self { id: id.into(), cancel })
    }
}

impl Drop for Dispatch {
    fn drop(&mut self) {
        if let Ok(mut tokens) = tokens().lock() { tokens.remove(&self.id); }
    }
}

pub(super) fn token(id: &str) -> Option<CancellationToken> {
    tokens().lock().ok()?.get(id).cloned()
}

pub(super) fn cancel(id: &str) -> bool {
    token(id).map(|token| token.cancel()).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_survives_the_handoff_to_a_run_and_targets_only_one_child() {
        let a = Dispatch::register("cancel-handoff-a").unwrap();
        let b = Dispatch::register("cancel-handoff-b").unwrap();
        assert!(cancel("cancel-handoff-a"));
        let admitted = token("cancel-handoff-a").unwrap();
        assert!(admitted.is_cancelled());
        assert!(!b.cancel.is_cancelled());
        drop(a);
        assert!(token("cancel-handoff-a").is_none());
        assert!(admitted.is_cancelled());
        assert!(!cancel("missing-dispatch"));
    }
}
