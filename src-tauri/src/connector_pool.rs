//! The live connector sessions a Run calls through.
//!
//! `mcp_client.rs` knows how to hold one connection; `connectors.rs` knows
//! which connectors exist and how to resolve their `${VAR}` references. This
//! module owns the sessions themselves: one per enabled connector, shared by
//! every Run in the app, started lazily, reused across turns, replaced when it
//! breaks or its resolved config changes, and killed when the app exits.
//!
//! Shared rather than per-Run because a connector's start is the expensive part
//! — an `npx` cold start can take most of a minute — and a conversation starts
//! a fresh Run for every message. A session is behind its own lock, so two
//! Runs calling the same connector take turns while calls to different
//! connectors run side by side.
//!
//! Everything here blocks; callers come through [`crate::blocking::run`].

use crate::connectors::{self, Connector};
use crate::mcp_client::{CallResult, McpTool, Session};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long one connect may take — the same budget as a probe, because the
/// first start of an `npx` connector downloads it.
const CONNECT_TIMEOUT: Duration = crate::mcp_client::PROBE_TIMEOUT;

/// One connector's slot. The lock is held for the whole of a connect or a
/// call, which is what serializes a connector's traffic.
#[derive(Default)]
struct Slot {
    /// sha256 of the resolved spec the session was opened with. A changed
    /// token or URL no longer matches, so the next use reconnects.
    fingerprint: String,
    session: Option<Session>,
    /// Why the last connect failed, until one succeeds.
    error: Option<String>,
}

type Pool = Mutex<HashMap<String, Arc<Mutex<Slot>>>>;

fn pool() -> &'static Pool {
    static POOL: OnceLock<Pool> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What each connected connector offered at its last handshake, readable
/// without its slot's lock — a slot is held for the whole of a call, and a
/// second Run starting meanwhile must still see a busy connector's tools.
fn catalog() -> &'static Mutex<HashMap<String, (Option<String>, Vec<McpTool>)>> {
    static CATALOG: OnceLock<Mutex<HashMap<String, (Option<String>, Vec<McpTool>)>>> = OnceLock::new();
    CATALOG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember(id: &str, offered: Option<(Option<String>, Vec<McpTool>)>) {
    let mut catalog = catalog().lock().unwrap_or_else(|p| p.into_inner());
    match offered {
        Some(entry) => catalog.insert(id.to_string(), entry),
        None => catalog.remove(id),
    };
}

fn slot(id: &str) -> Arc<Mutex<Slot>> {
    let mut pool = pool().lock().unwrap_or_else(|p| p.into_inner());
    pool.entry(id.to_string()).or_default().clone()
}

/// What a Run sees of one connected connector.
#[derive(Clone, Debug)]
pub struct ConnectorTools {
    pub id: String,
    pub label: String,
    pub instructions: Option<String>,
    pub tools: Vec<McpTool>,
}

/// One connector's state, for the Settings page.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    /// `connected`, `connecting`, `error`, `idle` (never tried) or `disabled`.
    pub state: &'static str,
    pub tools: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn fingerprint(spec: &crate::mcp_client::ServerSpec) -> String {
    let json = serde_json::to_vec(spec).unwrap_or_default();
    format!("{:x}", Sha256::digest(json))
}

/// Make sure `slot` holds a live session for `connector`, connecting if it
/// doesn't. Called with the slot locked.
fn ensure(slot: &mut Slot, connector: &Connector, workspace: Option<&Path>) -> Result<(), String> {
    let resolved = match connectors::resolve(&connector.server, workspace) {
        Ok(resolved) => resolved,
        Err(e) => {
            slot.session = None;
            slot.error = Some(e.clone());
            remember(&connector.id, None);
            return Err(e);
        }
    };
    let print = fingerprint(&resolved);
    let live = slot.session.as_mut().is_some_and(Session::usable);
    if live && slot.fingerprint == print {
        return Ok(());
    }
    // Drop the old session (killing its child) before starting the new one.
    slot.session = None;
    match Session::connect(&resolved, CONNECT_TIMEOUT) {
        Ok(session) => {
            remember(&connector.id, Some((session.info.instructions.clone(), session.info.tools.clone())));
            slot.session = Some(session);
            slot.fingerprint = print;
            slot.error = None;
            Ok(())
        }
        Err(e) => {
            slot.error = Some(e.clone());
            remember(&connector.id, None);
            Err(e)
        }
    }
}

fn enabled() -> Vec<Connector> {
    connectors::list().into_iter().filter(|c| c.enabled).collect()
}

/// Connect every enabled connector that isn't connected yet — in parallel,
/// each on its own thread — and wait up to `wait` for them. Returns the tools
/// of every connector that is connected by then. A connector still starting
/// when the wait ends keeps starting in the background and is there for the
/// next Run; one that failed is left out, its reason kept for the page.
pub fn ready(wait: Duration, workspace: Option<&Path>) -> Vec<ConnectorTools> {
    let connectors = enabled();
    // Forget sessions for connectors that were removed or switched off.
    {
        let mut pool = pool().lock().unwrap_or_else(|p| p.into_inner());
        pool.retain(|id, _| connectors.iter().any(|c| &c.id == id));
        let mut catalog = catalog().lock().unwrap_or_else(|p| p.into_inner());
        catalog.retain(|id, _| connectors.iter().any(|c| &c.id == id));
    }
    let (tx, rx) = mpsc::channel::<()>();
    for connector in connectors.clone() {
        let tx = tx.clone();
        let workspace = workspace.map(Path::to_path_buf);
        std::thread::spawn(move || {
            let slot = slot(&connector.id);
            let mut slot = slot.lock().unwrap_or_else(|p| p.into_inner());
            let _ = ensure(&mut slot, &connector, workspace.as_deref());
            let _ = tx.send(());
        });
    }
    drop(tx);
    let deadline = Instant::now() + wait;
    for _ in 0..connectors.len() {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { break };
        if rx.recv_timeout(remaining).is_err() {
            break;
        }
    }

    // A connector still connecting has no entry yet; one busy with another
    // Run's call keeps the entry its last handshake left.
    let catalog = catalog().lock().unwrap_or_else(|p| p.into_inner());
    connectors
        .into_iter()
        .filter_map(|connector| {
            let (instructions, tools) = catalog.get(&connector.id)?.clone();
            Some(ConnectorTools { id: connector.id, label: connector.label, instructions, tools })
        })
        .collect()
}

/// Start connecting in the background without waiting — at boot and after a
/// connector is saved, so the first Run doesn't pay for the cold start.
pub fn warm() {
    std::thread::spawn(|| {
        ready(Duration::ZERO, None);
    });
}

/// Call one tool on one connector. Connects first if the session is gone. A
/// server that ended our session answered before running anything, so that
/// one case reconnects and retries once; any other failure is returned as is —
/// a write that may have run is never sent twice.
pub fn call(
    id: &str,
    tool: &str,
    arguments: serde_json::Value,
    timeout: Duration,
    workspace: Option<&Path>,
) -> Result<CallResult, String> {
    let connector = enabled()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("The connector `{id}` is not enabled"))?;
    let slot = slot(id);
    let mut slot = slot.lock().unwrap_or_else(|p| p.into_inner());
    for attempt in 0..2 {
        ensure(&mut slot, &connector, workspace)?;
        let session = slot.session.as_mut().expect("ensure leaves a session");
        match session.call_tool(tool, arguments.clone(), timeout) {
            Err(e) if attempt == 0 && crate::mcp_client::is_session_ended(&e) => continue,
            outcome => return outcome,
        }
    }
    unreachable!("the loop returns on its second attempt")
}

pub fn status() -> Vec<Status> {
    connectors::list()
        .into_iter()
        .map(|connector| {
            if !connector.enabled {
                return Status { id: connector.id, state: "disabled", tools: 0, error: None };
            }
            let known = pool()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&connector.id)
                .cloned();
            let Some(slot) = known else {
                return Status { id: connector.id, state: "idle", tools: 0, error: None };
            };
            let Ok(mut slot) = slot.try_lock() else {
                return Status { id: connector.id, state: "connecting", tools: 0, error: None };
            };
            if let Some(session) = slot.session.as_mut() {
                if session.usable() {
                    let tools = session.info.tools.len();
                    return Status { id: connector.id, state: "connected", tools, error: None };
                }
            }
            match slot.error.clone() {
                Some(error) => Status { id: connector.id, state: "error", tools: 0, error: Some(error) },
                None => Status { id: connector.id, state: "idle", tools: 0, error: None },
            }
        })
        .collect()
}

/// Drop every session. Stdio children are killed as their sessions drop.
pub fn shutdown() {
    let slots: Vec<_> = pool()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain()
        .map(|(_, slot)| slot)
        .collect();
    for slot in slots {
        if let Ok(mut slot) = slot.try_lock() {
            slot.session = None;
        }
    }
    catalog().lock().unwrap_or_else(|p| p.into_inner()).clear();
}
