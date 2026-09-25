//! Coordination bridge — how a Delegate CLI reaches the coordination journal.
//!
//! The Harness talks to `.klide/coordination/events.jsonl` in-process through
//! its native `agent_*` Tools. A Delegate (Claude Code, Codex, OpenCode) is a
//! separate process with its own tool vocabulary, so it gets the same five
//! operations as an MCP server: `klide mcp coordination` (mcp_server.rs) runs
//! as a stdio child of the CLI and relays every call to this bridge over
//! loopback HTTP. The relay exists because the journal has one writer gate
//! (`CoordinationStoreState`) and one change event (`coordination:changed`),
//! both of which live in the app process — an MCP child appending to the
//! file directly would race the app and leave every panel blind to the write.
//!
//! Identity is bound here, never trusted from the caller. An MCP child is
//! started knowing two stable things: the path of this app's endpoint file and
//! its own session id. It resolves the live port and token from that file on
//! every call and posts to `/coord/<token>/<session_id>`; the bridge looks the
//! session up to learn which Run id and Workspace the call acts as. No request
//! field can name another actor or another journal — the same posture the
//! status hook server takes, and the rule `coordination_apply_command`
//! documents for every adapter.
//!
//! The token is shared by every child this app starts, so it cannot say which
//! session is calling. Each session therefore carries its own secret too
//! ([`SECRET_HEADER`]), minted when it is wired and read by the child from a
//! 0600 file; the bridge keeps only its sha256. A child that learns another
//! session's id still cannot speak on that session's line.
//!
//! Nothing durable may hold a port. A Delegate PTY is hosted by the ptyd
//! daemon and outlives the app process, so a restart gives the bridge a new
//! ephemeral port and an empty session map while the CLI is still running and
//! still calling. The endpoint file answers the first half (the child always
//! reads where the bridge is now) and [`BridgeHooks::resolve_session`] the
//! second (an unknown session is rebuilt from what its spawn wrote to disk).
//!
//! Delivery is pull, not push: a Delegate reads its inbox through `agent_wait`
//! at a moment of its own choosing, because Klide owns no turn boundary inside
//! a foreign CLI. Waking an idle Delegate when mail arrives is a separate
//! slice (a Stop hook that blocks with the inbox as reason).

use crate::coordination::{
    self, CoordinationActor, CoordinationCommand, CoordinationCommandOutcome,
    CoordinationDeliveryState, CoordinationEnvelope, CoordinationEnvelopeKind,
    CoordinationEnvelopeSnapshot, CoordinationEvent, CoordinationResultStatus,
    CoordinationRunRegistration, CoordinationRunState, CoordinationStoreState,
    CoordinationWorkerKind,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Hard ceiling on one blocking wait, matching the Harness Tool schema.
pub const MAX_WAIT_SECONDS: u64 = 120;
const DEFAULT_WAIT_SECONDS: u64 = 30;
/// A waiting Delegate is woken by the journal itself when this process
/// appends; this floor only bounds how late it sees another process's append.
const WAIT_POLL: Duration = Duration::from_secs(2);
const MAX_BODY_BYTES: usize = 256 * 1024;
/// Requests being served at once. Each may block in a two-minute wait, so the
/// bound is on threads, not on work; past it the bridge answers 503.
pub const MAX_IN_FLIGHT: usize = 64;
/// tiny_http reads a body this small into memory before handing the request
/// over, so dropping such a request never touches the socket again.
const BUFFERED_BODY_BYTES: usize = 1024;

/// What one bound Delegate session acts as. Filled by the app at spawn time
/// (pty.rs), read by the bridge on every request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeSession {
    pub run_id: String,
    pub workspace_root: String,
    /// A bounded Mission attempt ends for good when its process exits; an
    /// interactive conversation can be reopened (`--resume`) and so, like a
    /// Harness thread between turns, only ever rests in `waiting`.
    pub terminal: bool,
    /// sha256 (hex) of the secret this session's MCP child presents on every
    /// call. The app token only proves "some child Klide started"; this proves
    /// *which* one, so knowing another session's id is not enough to act as it.
    /// The secret itself lives only in a 0600 file the child reads.
    pub secret_sha256: String,
}

/// The header an MCP child carries its session secret in. Never the URL: a
/// URL ends up in logs and error messages.
pub const SECRET_HEADER: &str = "X-Klide-Session-Secret";

/// A fresh per-session secret: 32 bytes from the OS RNG, URL-safe base64 —
/// the same recipe as the status hook token, twice the length.
pub fn mint_session_secret() -> Result<String, String> {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("OS RNG unavailable: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// What the app keeps of a secret: its sha256, hex. Enough to check one, not
/// to present one — so the scrollback meta can carry it across a restart.
pub fn secret_sha256(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(secret.trim().as_bytes()))
}

/// Constant-time equality, so a caller cannot learn a credential a byte at a
/// time from how long a rejection took.
fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Both sides hashed first, so the comparison is fixed-length whatever was sent.
fn same_token(presented: &str, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    same_bytes(&Sha256::digest(presented), &Sha256::digest(expected))
}

fn secret_matches(presented: Option<&str>, session: &BridgeSession) -> bool {
    match presented {
        Some(secret) if !session.secret_sha256.is_empty() => {
            same_bytes(secret_sha256(secret).as_bytes(), session.secret_sha256.as_bytes())
        }
        _ => false,
    }
}

pub type SessionMap = Arc<Mutex<HashMap<String, BridgeSession>>>;

/// Messaging and approved-Mission operations a Delegate may perform, mirroring the Harness Tools
/// `agent_list` / `agent_send` / `agent_wait` / `agent_read_result` plus
/// `agent_publish_result` (a Harness Run publishes its result automatically
/// at settle; a Delegate has to say so). This is the wire between the MCP
/// child and the bridge — never exposed beyond loopback.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum BridgeRequest {
    List,
    Orchestrate { request: crate::missions::orchestration::Request },
    Send {
        to_run_id: String,
        body: String,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        reply_to: Option<String>,
        #[serde(default)]
        correlation_id: Option<String>,
        #[serde(default)]
        idempotency_key: Option<String>,
        #[serde(default)]
        wait_for_reply: bool,
        #[serde(default)]
        timeout_seconds: Option<u64>,
    },
    Wait {
        #[serde(default)]
        from_run_id: Option<String>,
        #[serde(default)]
        reply_to: Option<String>,
        #[serde(default)]
        timeout_seconds: Option<u64>,
    },
    ReadResult {
        run_id: String,
    },
    PublishResult {
        status: String,
        summary: String,
    },
}

/// The bridge's answer: one JSON value, or one readable error line.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BridgeResponse {
    fn ok(value: serde_json::Value) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(error.into()),
        }
    }
}

/// What the pure executor needs from the app: a way to announce a journal
/// change (the Tauri event), a way to say whether a Run is around right now,
/// and a way to recover a session binding this process never made. All
/// closures, so the executor and its tests stay Tauri-free.
pub type OrchestrationHook = Box<
    dyn Fn(&BridgeSession, crate::missions::orchestration::Request) -> Result<serde_json::Value, String>
        + Send
        + Sync,
>;

pub struct BridgeHooks {
    pub orchestrate: Option<OrchestrationHook>,
    pub on_change: Box<dyn Fn(&str, &CoordinationCommandOutcome) + Send + Sync>,
    pub is_live: Box<dyn Fn(&str) -> bool + Send + Sync>,
    /// Called when a request names a session this process has not bound —
    /// after an app restart, that is every surviving Delegate. The app rebuilds
    /// the identity from the session's own spawn record on disk. `None` when
    /// nothing on disk says that session is still running.
    pub resolve_session: Box<dyn Fn(&str) -> Option<BridgeSession> + Send + Sync>,
}

#[cfg(test)]
impl BridgeHooks {
    pub fn silent() -> Self {
        Self {
            orchestrate: None,
            on_change: Box::new(|_, _| {}),
            is_live: Box::new(|_| false),
            resolve_session: Box::new(|_| None),
        }
    }
}

fn apply(
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
    workspace_root: &str,
    command: CoordinationCommand,
) -> Result<CoordinationCommandOutcome, String> {
    let outcome = coordination::apply_coordination_command(store, workspace_root, command)?;
    (hooks.on_change)(workspace_root, &outcome);
    Ok(outcome)
}

/// A reply is an answer: with `replyTo` set, an omitted kind means answer.
fn parse_kind(kind: Option<&str>, is_reply: bool) -> Result<CoordinationEnvelopeKind, String> {
    match kind.map(str::trim).filter(|k| !k.is_empty()) {
        None if is_reply => Ok(CoordinationEnvelopeKind::Answer),
        None | Some("instruction") => Ok(CoordinationEnvelopeKind::Instruction),
        Some("question") => Ok(CoordinationEnvelopeKind::Question),
        Some("answer") => Ok(CoordinationEnvelopeKind::Answer),
        Some("progress") => Ok(CoordinationEnvelopeKind::Progress),
        Some("handoff") => Ok(CoordinationEnvelopeKind::Handoff),
        Some(other) => Err(format!("Unknown coordination message kind `{other}`.")),
    }
}

fn parse_result_status(status: &str) -> Result<CoordinationResultStatus, String> {
    match status.trim() {
        "succeeded" => Ok(CoordinationResultStatus::Succeeded),
        "partial" => Ok(CoordinationResultStatus::Partial),
        "failed" => Ok(CoordinationResultStatus::Failed),
        "cancelled" => Ok(CoordinationResultStatus::Cancelled),
        other => Err(format!("Unknown result status `{other}`.")),
    }
}

fn clamp_timeout(seconds: Option<u64>) -> Duration {
    Duration::from_secs(seconds.unwrap_or(DEFAULT_WAIT_SECONDS).clamp(1, MAX_WAIT_SECONDS))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The same fenced delivery the Harness hands its model, so a Delegate and a
/// Harness Run read peers' words in one shape — preamble included.
pub fn messages_text(inbox: &[CoordinationEnvelopeSnapshot]) -> Result<String, String> {
    crate::agent::delivery::render_mail(inbox)
}

/// Block until a matching accepted envelope arrives for `run_id`, or the
/// deadline passes. Matched mail is marked delivered and acknowledged in the
/// same call: unlike the Harness, a Delegate has no later turn boundary at
/// which Klide could confirm the model actually read it, so handing the text
/// back over the wire *is* the read.
fn wait_for_messages(
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
    session: &BridgeSession,
    from_run_id: Option<&str>,
    reply_to: Option<&str>,
    timeout: Duration,
) -> Result<Option<Vec<CoordinationEnvelopeSnapshot>>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let snapshot = coordination::read_snapshot(store, &session.workspace_root)?;
        let inbox = coordination::inbox_for(&snapshot, &session.run_id)?;
        let matched: Vec<CoordinationEnvelopeSnapshot> = inbox
            .into_iter()
            .filter(|entry| coordination::envelope_answers_wait(entry, from_run_id, reply_to))
            .collect();
        if !matched.is_empty() {
            for entry in &matched {
                if entry.delivery_state == CoordinationDeliveryState::Accepted {
                    apply(
                        store,
                        hooks,
                        &session.workspace_root,
                        CoordinationCommand::MarkEnvelopeDelivered {
                            run_id: session.run_id.clone(),
                            envelope_id: entry.envelope.id.clone(),
                        },
                    )?;
                }
                apply(
                    store,
                    hooks,
                    &session.workspace_root,
                    CoordinationCommand::AcknowledgeEnvelope {
                        run_id: session.run_id.clone(),
                        envelope_id: entry.envelope.id.clone(),
                    },
                )?;
            }
            return Ok(Some(matched));
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(None);
        }
        // Woken the moment this process appends; the floor catches an append
        // from another Klide process, which wakes nobody here.
        coordination::wait_for_change(
            store,
            &session.workspace_root,
            snapshot.next_seq,
            WAIT_POLL.min(deadline - now),
        )?;
    }
}

fn envelope_from_outcome(
    outcome: &CoordinationCommandOutcome,
    session: &BridgeSession,
    target: &str,
    idempotency_key: &Option<String>,
) -> Option<CoordinationEnvelope> {
    outcome
        .appended
        .as_ref()
        .and_then(|line| match &line.event {
            CoordinationEvent::EnvelopeQueued { envelope } => Some(envelope.clone()),
            _ => None,
        })
        .or_else(|| {
            outcome.snapshot.envelopes.iter().rev().find_map(|entry| {
                let envelope = &entry.envelope;
                (envelope.from
                    == (CoordinationActor::Run {
                        run_id: session.run_id.clone(),
                    })
                    && envelope.to_run_id == target
                    && envelope.idempotency_key == *idempotency_key)
                    .then(|| envelope.clone())
            })
        })
}

/// Run one bridge request as the bound session. Pure apart from the journal
/// and the hooks — tests drive it with a temp Workspace and `BridgeHooks::silent()`.
pub fn execute(
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
    session: &BridgeSession,
    request: BridgeRequest,
) -> BridgeResponse {
    match execute_inner(store, hooks, session, request) {
        Ok(value) => BridgeResponse::ok(value),
        Err(error) => BridgeResponse::err(error),
    }
}

fn execute_inner(
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
    session: &BridgeSession,
    request: BridgeRequest,
) -> Result<serde_json::Value, String> {
    let root = session.workspace_root.as_str();
    let me = session.run_id.as_str();
    match request {
        BridgeRequest::Orchestrate { request } => hooks.orchestrate.as_ref()
            .ok_or("Mission orchestration is unavailable in this host.")?(session, request),
        BridgeRequest::List => {
            let snapshot = coordination::read_snapshot(store, root)?;
            let visible = coordination::visible_runs_for(&snapshot, me)?;
            let rows = visible
                .into_iter()
                .map(|run| {
                    let run_id = run.registration.run_id.as_str();
                    serde_json::json!({
                        "runId": run_id,
                        "relation": coordination::relation_label(&snapshot, me, run_id),
                        "state": run.state,
                        "live": (hooks.is_live)(run_id),
                        "workerKind": run.registration.worker_kind,
                        "label": run.registration.label,
                        "missionId": run.registration.mission_id,
                        "cancelRequested": run.cancel_request.is_some(),
                    })
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!({ "runs": rows }))
        }
        BridgeRequest::Send {
            to_run_id,
            body,
            kind,
            reply_to,
            correlation_id,
            idempotency_key,
            wait_for_reply,
            timeout_seconds,
        } => {
            let target = to_run_id.trim().to_string();
            let body = body.trim().to_string();
            if target.is_empty() || body.is_empty() {
                return Err("agent_send requires non-empty toRunId and body.".into());
            }
            let kind = parse_kind(kind.as_deref(), non_empty(reply_to.clone()).is_some())?;
            let idempotency_key = non_empty(idempotency_key);
            let outcome = apply(
                store,
                hooks,
                root,
                CoordinationCommand::SendEnvelope {
                    from: CoordinationActor::Run {
                        run_id: me.to_string(),
                    },
                    to_run_id: target.clone(),
                    kind,
                    body,
                    reply_to: non_empty(reply_to),
                    correlation_id: non_empty(correlation_id),
                    idempotency_key: idempotency_key.clone(),
                    source_refs: vec![],
                },
            )?;
            let envelope = envelope_from_outcome(&outcome, session, &target, &idempotency_key)
                .ok_or_else(|| {
                    "The message was recorded but its envelope could not be resolved.".to_string()
                })?;
            let (reply_status, replies, snapshot) = if wait_for_reply {
                let waited = wait_for_messages(
                    store,
                    hooks,
                    session,
                    Some(&target),
                    Some(&envelope.id),
                    clamp_timeout(timeout_seconds),
                )?;
                // Waiting moved mail to delivered and acknowledged, so the
                // receipt has to read the journal after it, not before.
                let snapshot = coordination::read_snapshot(store, root)?;
                match waited {
                    Some(replies) => (
                        coordination::CoordinationReplyStatus::Received,
                        replies,
                        snapshot,
                    ),
                    None => (
                        coordination::CoordinationReplyStatus::TimedOut,
                        vec![],
                        snapshot,
                    ),
                }
            } else {
                // Nothing has touched the journal since the send, and `apply`
                // already handed back the post-command snapshot — including on
                // the idempotent retry that appended nothing, which is exactly
                // the state this receipt reports.
                (
                    coordination::CoordinationReplyStatus::NotRequested,
                    vec![],
                    outcome.snapshot,
                )
            };
            let receipt =
                coordination::send_receipt(&snapshot, &envelope.id, reply_status, &replies)?;
            serde_json::to_value(receipt)
                .map_err(|error| format!("Unable to encode send receipt: {error}"))
        }

        BridgeRequest::Wait {
            from_run_id,
            reply_to,
            timeout_seconds,
        } => {
            let from = non_empty(from_run_id);
            let reply = non_empty(reply_to);
            match wait_for_messages(
                store,
                hooks,
                session,
                from.as_deref(),
                reply.as_deref(),
                clamp_timeout(timeout_seconds),
            )? {
                Some(messages) => Ok(serde_json::json!({
                    "messages": messages,
                    "text": messages_text(&messages)?,
                })),
                None => Ok(serde_json::json!({
                    "messages": [],
                    "timedOut": true,
                    "text": "No coordination message arrived within the wait window.",
                })),
            }
        }
        BridgeRequest::ReadResult { run_id } => {
            let target = run_id.trim();
            if target.is_empty() {
                return Err("agent_read_result requires runId.".into());
            }
            let snapshot = coordination::read_snapshot(store, root)?;
            match coordination::visible_result_for(&snapshot, me, target)? {
                Some(result) => Ok(serde_json::json!({
                    "ready": true,
                    "result": result,
                    "text": format!(
                        "@{target} published a {:?} result:\n{}",
                        result.status, result.summary
                    )
                    .to_lowercase(),
                })),
                None => Ok(serde_json::json!({
                    "ready": false,
                    "text": format!("@{target} has not published a result yet."),
                })),
            }
        }
        BridgeRequest::PublishResult { status, summary } => {
            let summary = summary.trim().to_string();
            if summary.is_empty() {
                return Err("agent_publish_result requires a summary.".into());
            }
            let status = parse_result_status(&status)?;
            let outcome = apply(
                store,
                hooks,
                root,
                CoordinationCommand::PublishResult {
                    run_id: me.to_string(),
                    status,
                    summary,
                    artifacts: vec![],
                    source_refs: vec![],
                },
            )?;
            Ok(serde_json::json!({
                "published": outcome.appended.is_some(),
                "text": "Result published for this Run.",
            }))
        }
    }
}

// ── Loopback server ─────────────────────────────────────────────────────

pub struct BridgeServer {
    pub port: u16,
    pub token: String,
    /// Requests holding a serving thread right now (tests watch it).
    #[cfg_attr(not(test), allow(dead_code))]
    pub in_flight: Arc<AtomicUsize>,
}

/// The whole app holds one session map and (lazily) one bridge server, the
/// same shape as `DelegateStatusState`. `bridge_url_for` is the only way in,
/// so the listener can't start twice.
#[derive(Default)]
pub struct CoordinationBridgeState {
    sessions: SessionMap,
    server: Mutex<Option<BridgeServer>>,
}

impl CoordinationBridgeState {
    pub fn bind_session(&self, session_id: &str, session: BridgeSession) {
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), session);
    }

    pub fn forget_session(&self, session_id: &str) -> Option<BridgeSession> {
        self.sessions.lock().unwrap().remove(session_id)
    }

    /// A headless Delegate turn's binding ends with the Harness Run that made
    /// it — unless a PTY for the same conversation is live, in which case the
    /// binding is that session's and its exit settles it. Returns whether a
    /// binding was dropped.
    pub fn release_headless_session(&self, session_id: &str, pty_live: bool) -> bool {
        !pty_live && self.forget_session(session_id).is_some()
    }

    pub fn session(&self, session_id: &str) -> Option<BridgeSession> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }

    /// Whether any bound Delegate session acts as `run_id` right now.
    pub fn is_bound_run(&self, run_id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .any(|s| s.run_id == run_id)
    }

    /// Start the loopback listener if it is not already up, and publish where
    /// it is listening to `endpoint_path`. Idempotent: the listener starts once
    /// per process, the file is rewritten each time so a reader never has to
    /// care which spawn wrote it.
    pub fn ensure_server(
        &self,
        endpoint_path: &std::path::Path,
        store: CoordinationStoreState,
        hooks: BridgeHooks,
    ) -> Result<(), String> {
        let mut server = self.server.lock().unwrap();
        if server.is_none() {
            *server = Some(start_bridge_server(
                self.sessions.clone(),
                store,
                Arc::new(hooks),
                MAX_IN_FLIGHT,
            )?);
        }
        let s = server.as_ref().unwrap();
        write_endpoint(
            endpoint_path,
            &BridgeEndpoint {
                port: s.port,
                token: s.token.clone(),
            },
        )
    }
}

/// Where this app's bridge is listening right now. Written atomically every
/// time the listener starts, read by every MCP child on every call — so a
/// restart's new port and token are picked up with nothing to migrate.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct BridgeEndpoint {
    pub port: u16,
    pub token: String,
}

pub fn write_endpoint(path: &std::path::Path, endpoint: &BridgeEndpoint) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create the bridge endpoint directory: {e}"))?;
    }
    let encoded = serde_json::to_vec(endpoint)
        .map_err(|e| format!("Unable to encode the bridge endpoint: {e}"))?;
    // Private: the token is what keeps other local processes off the port.
    crate::durable::write_atomic_private(path, &encoded)
}

pub fn read_endpoint(path: &std::path::Path) -> Result<BridgeEndpoint, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Klide is not running, or has not started coordination yet: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Unreadable bridge endpoint: {e}"))
}

pub fn bridge_url(endpoint: &BridgeEndpoint, session_id: &str) -> String {
    format!(
        "http://127.0.0.1:{}/coord/{}/{session_id}",
        endpoint.port, endpoint.token
    )
}

/// Bind 127.0.0.1 on an ephemeral port. Unlike the status hook server, an
/// authenticated request gets its own thread: an `agent_wait` blocks for up to
/// two minutes and must not hold up a peer's `agent_send` on the same port.
///
/// The accept loop authenticates from the request line and headers alone —
/// the body is never read for a caller that has not proved which session it
/// is — and at most `max_in_flight` requests hold a thread at once.
pub fn start_bridge_server(
    sessions: SessionMap,
    store: CoordinationStoreState,
    hooks: Arc<BridgeHooks>,
    max_in_flight: usize,
) -> Result<BridgeServer, String> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("bind coordination bridge: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "coordination bridge has no IP port".to_string())?;
    let token = crate::delegate::status::fresh_token()?;
    let thread_token = token.clone();
    let in_flight = Arc::new(AtomicUsize::new(0));
    let counter = in_flight.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            // Dropping a tiny_http request drains its unread body into one
            // buffer the size the client *declared* — so a request claiming a
            // huge body is never dropped normally: it is answered and parked.
            if request.body_length().is_some_and(|n| n > MAX_BODY_BYTES) {
                abandon(request, 413, BridgeResponse::err("Bridge request too large."));
                continue;
            }
            let secret = request
                .headers()
                .iter()
                .find(|h| h.field.equiv(SECRET_HEADER))
                .map(|h| h.value.as_str().to_string());
            let authenticated = authenticate(
                request.method().as_str(),
                request.url(),
                secret.as_deref(),
                &thread_token,
                &sessions,
                &store,
                &hooks,
            );
            let Some(slot) = Slot::take(&counter, max_in_flight) else {
                answer(request, 503, BridgeResponse::err("The coordination bridge is busy; retry shortly."), None);
                continue;
            };
            let session = match authenticated {
                Ok(session) => session,
                Err((code, response)) => {
                    answer(request, code, response, Some(slot));
                    continue;
                }
            };
            let store = store.clone();
            let hooks = hooks.clone();
            std::thread::spawn(move || {
                let _slot = slot;
                let mut request = request;
                let mut body = String::new();
                use std::io::Read;
                let _ = request
                    .as_reader()
                    .take(MAX_BODY_BYTES as u64)
                    .read_to_string(&mut body);
                let (code, response) = dispatch(&session, &body, &store, &hooks);
                let _ = request.respond(json_response(code, &response));
            });
        }
    });
    Ok(BridgeServer {
        port,
        token,
        in_flight,
    })
}

/// One serving thread, returned to the pool when dropped.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn take(counter: &Arc<AtomicUsize>, max: usize) -> Option<Slot> {
        counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < max).then_some(n + 1))
            .ok()
            .map(|_| Slot(counter.clone()))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn json_response(code: u16, response: &BridgeResponse) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let payload = serde_json::to_string(response).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    tiny_http::Response::from_string(payload)
        .with_status_code(code)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
        )
}

/// Whether tiny_http already holds this request's whole body in memory, so
/// answering and dropping it on the accept thread cannot block on the socket.
fn body_is_buffered(request: &tiny_http::Request) -> bool {
    let expects_continue = request.headers().iter().any(|h| h.field.equiv("Expect"));
    match request.body_length() {
        None | Some(0) => true,
        Some(n) => n <= BUFFERED_BODY_BYTES && !expects_continue,
    }
}

/// Answer a request the bridge will not serve, without reading its body. A
/// buffered one is answered right here; one with body bytes still on the
/// socket is answered on a counted thread (dropping it drains them), and with
/// no thread free it is parked rather than let a stalled client hold the
/// accept loop.
fn answer(request: tiny_http::Request, code: u16, response: BridgeResponse, slot: Option<Slot>) {
    if body_is_buffered(&request) {
        let _ = request.respond(json_response(code, &response));
        return;
    }
    match slot {
        Some(slot) => {
            std::thread::spawn(move || {
                let _slot = slot;
                let _ = request.respond(json_response(code, &response));
            });
        }
        None => abandon(request, code, response),
    }
}

/// Write the answer, then leak the connection instead of dropping it: tiny_http
/// would otherwise drain the declared body into one allocation of that size,
/// and a claimed exabyte aborts the app. A hostile request costs one parked
/// connection, never the process. No Klide client ever gets here.
fn abandon(request: tiny_http::Request, code: u16, response: BridgeResponse) {
    let stream = request.upgrade("klide-abandoned", json_response(code, &response));
    std::mem::forget(stream);
}

/// Serve one `POST /coord/<token>/<session_id>` carrying a [`BridgeRequest`].
/// Returns the HTTP status and a JSON [`BridgeResponse`] body. Pure apart
/// from the journal, so tests drive it without a socket.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn handle_bridge_request(
    method: &str,
    url: &str,
    secret: Option<&str>,
    body: &str,
    token: &str,
    sessions: &SessionMap,
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
) -> (u16, String) {
    let (code, response) = match authenticate(method, url, secret, token, sessions, store, hooks) {
        Ok(session) => dispatch(&session, body, store, hooks),
        Err(rejected) => rejected,
    };
    (
        code,
        serde_json::to_string(&response).unwrap_or_else(|_| "{\"ok\":false}".to_string()),
    )
}

const RESTART_HINT: &str =
    "Restart the Delegate from Klide to restore its agent tools.";

/// Who is calling, from the request line and the secret header only. The app
/// token says the caller is a child of this app; the session secret says which
/// child. A session this process never bound is rebuilt through
/// [`BridgeHooks::resolve_session`] — and remembered only once the caller has
/// proved it with that session's own secret and the journal still has the Run
/// open.
pub fn authenticate(
    method: &str,
    url: &str,
    secret: Option<&str>,
    token: &str,
    sessions: &SessionMap,
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
) -> Result<BridgeSession, (u16, BridgeResponse)> {
    if method != "POST" {
        return Err((405, BridgeResponse::err("POST only.")));
    }
    let path = url.split('?').next().unwrap_or(url);
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    if segments.len() < 3 || segments[0] != "coord" {
        return Err((404, BridgeResponse::err("Unknown bridge path.")));
    }
    if !same_token(segments[1], token) {
        return Err((403, BridgeResponse::err("Bridge token rejected.")));
    }
    // The session id is `{convoId}:{provider}` and may itself hold separators.
    let session_id = segments[2..].join("/");
    let refused = || {
        (
            401,
            BridgeResponse::err(format!(
                "This Delegate session did not present its own coordination secret. {RESTART_HINT}"
            )),
        )
    };
    // The guard is dropped before the hook runs — it takes the same lock to
    // remember what it found.
    let bound = sessions.lock().unwrap().get(&session_id).cloned();
    if let Some(session) = bound {
        return if secret_matches(secret, &session) {
            Ok(session)
        } else {
            Err(refused())
        };
    }
    let Some(recovered) = (hooks.resolve_session)(&session_id) else {
        return Err((
            404,
            BridgeResponse::err(format!(
                "This Delegate session is not bound to a coordination Run. {RESTART_HINT}"
            )),
        ));
    };
    if !secret_matches(secret, &recovered) {
        return Err(refused());
    }
    if !run_is_open(store, &recovered) {
        return Err((
            404,
            BridgeResponse::err(format!(
                "This Delegate session's Run has ended. {RESTART_HINT}"
            )),
        ));
    }
    sessions
        .lock()
        .unwrap()
        .insert(session_id, recovered.clone());
    Ok(recovered)
}

/// A recovered session may act only as a Run the journal still has open:
/// registered, and not settled as done, failed, or cancelled.
fn run_is_open(store: &CoordinationStoreState, session: &BridgeSession) -> bool {
    coordination::read_snapshot(store, &session.workspace_root)
        .ok()
        .and_then(|snapshot| {
            snapshot
                .runs
                .into_iter()
                .find(|run| run.registration.run_id == session.run_id)
        })
        .is_some_and(|run| {
            !matches!(
                run.state,
                CoordinationRunState::Done
                    | CoordinationRunState::Failed
                    | CoordinationRunState::Cancelled
            )
        })
}

/// Run one authenticated request's body as `session`.
pub fn dispatch(
    session: &BridgeSession,
    body: &str,
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
) -> (u16, BridgeResponse) {
    let request: BridgeRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(e) => return (400, BridgeResponse::err(format!("Bad bridge request: {e}"))),
    };
    let response = execute(store, hooks, session, request);
    let code = if response.ok { 200 } else { 422 };
    (code, response)
}

// ── Delegate lifecycle → journal ────────────────────────────────────────

/// Everything the spawn side knows about a Delegate that the journal wants.
pub struct DelegateRegistration<'a> {
    pub session_id: &'a str,
    pub run_id: &'a str,
    pub workspace_root: &'a str,
    pub task: Option<&'a str>,
    pub parent_run_id: Option<&'a str>,
    pub mission_id: Option<&'a str>,
    pub mission_task_id: Option<&'a str>,
    /// sha256 of the secret minted for this session (see [`mint_session_secret`]).
    pub secret_sha256: &'a str,
}

/// Register the Delegate as a coordination Run and bind its session, so the
/// peers' `agent_list` shows it and its own bridge calls act as it. A
/// respawned session (same conversation) re-registers idempotently and moves
/// back to `working`, the same dance the Harness does per turn.
pub fn register_delegate(
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
    bridge: &CoordinationBridgeState,
    reg: DelegateRegistration<'_>,
) -> Result<(), String> {
    // A PTY may open a Run the Harness already registered — a worker child
    // (`spawn_subagent worker=…`) reopened as a live Claude Code or Codex
    // session, or a Focus thread on a Delegate resumed in a terminal. That Run
    // exists with the Harness's metadata (a parent, a label), so registering
    // it again with the PTY's would be refused as "different metadata" and the
    // session would start without its tools. The Run is the identity; the
    // session is just another door onto it. Keep the existing registration,
    // and only move a Run that is still live back to working — a finished
    // worker stays finished on the board even while its transcript is reopened.
    let existing = coordination::read_snapshot(store, reg.workspace_root)
        .ok()
        .and_then(|snapshot| {
            snapshot
                .runs
                .into_iter()
                .find(|run| run.registration.run_id == reg.run_id)
        });
    let terminal = existing.as_ref().is_some_and(|run| {
        matches!(
            run.state,
            CoordinationRunState::Done
                | CoordinationRunState::Failed
                | CoordinationRunState::Cancelled
        )
    });
    if existing.is_none() {
        apply(
            store,
            hooks,
            reg.workspace_root,
            CoordinationCommand::RegisterRun {
                registration: CoordinationRunRegistration {
                    run_id: reg.run_id.to_string(),
                    worker_kind: CoordinationWorkerKind::Delegate,
                    parent_run_id: reg.parent_run_id.map(str::to_string),
                    mission_id: reg.mission_id.map(str::to_string),
                    mission_task_id: reg.mission_task_id.map(str::to_string),
                    label: reg.task.and_then(coordination::label_from_text),
                },
                initial_state: Some(CoordinationRunState::Working),
            },
        )?;
    }
    if !terminal {
        apply(
            store,
            hooks,
            reg.workspace_root,
            CoordinationCommand::SetRunState {
                actor: CoordinationActor::Run {
                    run_id: reg.run_id.to_string(),
                },
                run_id: reg.run_id.to_string(),
                state: CoordinationRunState::Working,
                reason: Some("delegate session started".to_string()),
            },
        )?;
    }
    bridge.bind_session(
        reg.session_id,
        BridgeSession {
            run_id: reg.run_id.to_string(),
            workspace_root: reg.workspace_root.to_string(),
            terminal: reg.mission_id.is_some(),
            secret_sha256: reg.secret_sha256.to_string(),
        },
    );
    Ok(())
}

/// A status hook post (`working` / `blocked` / `waiting`) becomes the Run's
/// coordination state, so a peer's `agent_list` sees a Delegate idle at its
/// composer as `waiting` — the state the Harness reports between turns.
pub fn note_delegate_status(
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
    bridge: &CoordinationBridgeState,
    session_id: &str,
    status: &str,
) -> Result<(), String> {
    let Some(session) = bridge.session(session_id) else {
        return Ok(());
    };
    let state = match status {
        "working" => CoordinationRunState::Working,
        "blocked" => CoordinationRunState::Blocked,
        "waiting" => CoordinationRunState::Waiting,
        _ => return Ok(()),
    };
    set_state(store, hooks, &session, state, Some(format!("delegate hook: {status}")))
}

/// Process exit settles the Run. A Mission attempt is terminal: `done` on a
/// clean exit, `cancelled` when the operator stopped it, `failed` otherwise.
/// An interactive conversation is not — its CLI exiting is the thread going
/// quiet, so it rests in `waiting` (or `blocked` after an error) exactly as a
/// Harness thread does between turns, and a respawn moves it back to
/// `working`. The session binding is dropped either way — a dead PTY cannot
/// act as anyone.
pub fn settle_delegate(
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
    bridge: &CoordinationBridgeState,
    session_id: &str,
    exit_code: u32,
    stop_requested: bool,
) -> Result<(), String> {
    let Some(session) = bridge.forget_session(session_id) else {
        return Ok(());
    };
    let (state, reason) = match (session.terminal, stop_requested, exit_code) {
        (true, true, _) => (CoordinationRunState::Cancelled, "delegate stopped by operator"),
        (true, false, 0) => (CoordinationRunState::Done, "delegate exited cleanly"),
        (true, false, _) => (CoordinationRunState::Failed, "delegate exited with an error"),
        (false, true, _) => (CoordinationRunState::Waiting, "delegate stopped; conversation can resume"),
        (false, false, 0) => (CoordinationRunState::Waiting, "delegate exited; conversation can resume"),
        (false, false, _) => (CoordinationRunState::Blocked, "delegate exited with an error"),
    };
    set_state(store, hooks, &session, state, Some(reason.to_string()))
}

fn set_state(
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
    session: &BridgeSession,
    state: CoordinationRunState,
    reason: Option<String>,
) -> Result<(), String> {
    apply(
        store,
        hooks,
        &session.workspace_root,
        CoordinationCommand::SetRunState {
            actor: CoordinationActor::Run {
                run_id: session.run_id.clone(),
            },
            run_id: session.run_id.clone(),
            state,
            reason,
        },
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The secret every test session is minted with, unless a test says otherwise.
    const SECRET: &str = "secret-of-convo-1";

    fn sandbox(label: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "klide-bridge-{label}-{}-{}",
            std::process::id(),
            crate::agent::transcripts::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        (dir, root)
    }

    fn harness_peer(store: &CoordinationStoreState, root: &str, run_id: &str) {
        coordination::apply_coordination_command(
            store,
            root,
            CoordinationCommand::RegisterRun {
                registration: CoordinationRunRegistration {
                    run_id: run_id.to_string(),
                    worker_kind: CoordinationWorkerKind::Harness,
                    parent_run_id: None,
                    mission_id: None,
                    mission_task_id: None,
                    label: Some("Fix the parser".to_string()),
                },
                initial_state: Some(CoordinationRunState::Working),
            },
        )
        .unwrap();
    }

    fn bound(root: &str) -> (CoordinationStoreState, CoordinationBridgeState, BridgeSession) {
        let store = CoordinationStoreState::default();
        let bridge = CoordinationBridgeState::default();
        harness_peer(&store, root, "run_kit");
        register_delegate(
            &store,
            &BridgeHooks::silent(),
            &bridge,
            DelegateRegistration {
                session_id: "convo-1:claude-code",
                run_id: "convo-1",
                workspace_root: root,
                task: Some("  refactor   the   pty  host  "),
                parent_run_id: None,
                mission_id: None,
                mission_task_id: None,
                secret_sha256: &secret_sha256(SECRET),
            },
        )
        .unwrap();
        let session = bridge.session("convo-1:claude-code").unwrap();
        (store, bridge, session)
    }

    #[test]
    fn a_delegate_registers_as_a_working_delegate_run_with_the_thread_title_rule() {
        let (dir, root) = sandbox("register");
        let (store, bridge, session) = bound(&root);
        assert_eq!(session.run_id, "convo-1");
        assert!(bridge.is_bound_run("convo-1"));
        let snapshot = coordination::read_snapshot(&store, &root).unwrap();
        let me = snapshot
            .runs
            .iter()
            .find(|r| r.registration.run_id == "convo-1")
            .unwrap();
        assert_eq!(me.registration.worker_kind, CoordinationWorkerKind::Delegate);
        assert_eq!(me.state, CoordinationRunState::Working);
        assert_eq!(me.registration.label.as_deref(), Some("refactor the pty host"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A headless Delegate turn binds `{convo}:{provider}` so the CLI can reach
    /// the journal; the Run letting go must unbind it, or `agent_list` reports
    /// the conversation live forever. A live PTY on the same id keeps its own.
    #[test]
    fn releasing_a_headless_session_unbinds_it_unless_a_pty_holds_it() {
        let bridge = CoordinationBridgeState::default();
        let session = BridgeSession {
            run_id: "convo-9".to_string(),
            workspace_root: "/tmp/ws".to_string(),
            terminal: false,
            secret_sha256: secret_sha256(SECRET),
        };
        bridge.bind_session("convo-9:claude-code", session);
        assert!(!bridge.release_headless_session("convo-9:claude-code", true));
        assert!(bridge.is_bound_run("convo-9"), "a live PTY keeps its binding");
        assert!(bridge.release_headless_session("convo-9:claude-code", false));
        assert!(!bridge.is_bound_run("convo-9"));
        assert!(!bridge.release_headless_session("convo-9:claude-code", false));
    }

    /// The Harness registers a worker child with its parent and its label;
    /// opening that child later as a live Claude Code session must not refuse
    /// the Run as "different metadata" and start the CLI without its tools.
    #[test]
    fn a_pty_reopening_a_harness_registered_run_keeps_it_and_binds_the_session() {
        let (dir, root) = sandbox("reopen");
        let store = CoordinationStoreState::default();
        let bridge = CoordinationBridgeState::default();
        harness_peer(&store, &root, "run_kit");
        // A finished worker child, as the Harness left it.
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::RegisterRun {
                registration: CoordinationRunRegistration {
                    run_id: "sub_run_kit_call_1".to_string(),
                    worker_kind: CoordinationWorkerKind::Delegate,
                    parent_run_id: Some("run_kit".to_string()),
                    mission_id: None,
                    mission_task_id: None,
                    label: Some("Add slugify".to_string()),
                },
                initial_state: Some(CoordinationRunState::Working),
            },
        )
        .unwrap();
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::SetRunState {
                actor: CoordinationActor::Run { run_id: "sub_run_kit_call_1".to_string() },
                run_id: "sub_run_kit_call_1".to_string(),
                state: CoordinationRunState::Done,
                reason: None,
            },
        )
        .unwrap();

        register_delegate(
            &store,
            &BridgeHooks::silent(),
            &bridge,
            DelegateRegistration {
                session_id: "sub_run_kit_call_1:claude-code",
                run_id: "sub_run_kit_call_1",
                workspace_root: &root,
                task: None,
                parent_run_id: None,
                mission_id: None,
                mission_task_id: None,
                secret_sha256: &secret_sha256(SECRET),
            },
        )
        .expect("reopening an existing Run is not an error");

        let session = bridge.session("sub_run_kit_call_1:claude-code").expect("session bound");
        assert_eq!(session.run_id, "sub_run_kit_call_1");
        let snapshot = coordination::read_snapshot(&store, &root).unwrap();
        let child = snapshot
            .runs
            .iter()
            .find(|r| r.registration.run_id == "sub_run_kit_call_1")
            .unwrap();
        assert_eq!(child.registration.parent_run_id.as_deref(), Some("run_kit"), "the Harness's registration stands");
        assert_eq!(child.registration.label.as_deref(), Some("Add slugify"));
        assert_eq!(child.state, CoordinationRunState::Done, "a finished worker stays finished");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_pty_reopening_a_live_run_moves_it_back_to_working() {
        let (dir, root) = sandbox("reopen-live");
        let store = CoordinationStoreState::default();
        let bridge = CoordinationBridgeState::default();
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::RegisterRun {
                registration: CoordinationRunRegistration {
                    run_id: "convo-9".to_string(),
                    worker_kind: CoordinationWorkerKind::Harness,
                    parent_run_id: None,
                    mission_id: None,
                    mission_task_id: None,
                    label: Some("Focus thread".to_string()),
                },
                initial_state: Some(CoordinationRunState::Waiting),
            },
        )
        .unwrap();
        register_delegate(
            &store,
            &BridgeHooks::silent(),
            &bridge,
            DelegateRegistration {
                session_id: "convo-9:codex",
                run_id: "convo-9",
                workspace_root: &root,
                task: Some("something else"),
                parent_run_id: None,
                mission_id: None,
                mission_task_id: None,
                secret_sha256: &secret_sha256(SECRET),
            },
        )
        .unwrap();
        assert!(bridge.is_bound_run("convo-9"));
        let snapshot = coordination::read_snapshot(&store, &root).unwrap();
        let run = snapshot.runs.iter().find(|r| r.registration.run_id == "convo-9").unwrap();
        assert_eq!(run.state, CoordinationRunState::Working);
        assert_eq!(run.registration.worker_kind, CoordinationWorkerKind::Harness, "identity is not rewritten");
        assert_eq!(run.registration.label.as_deref(), Some("Focus thread"), "the first label wins");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn orchestration_receives_only_the_bound_identity() {
        let (dir, root) = sandbox("orchestration-identity");
        let (store, _bridge, session) = bound(&root);
        let mut hooks = BridgeHooks::silent();
        hooks.orchestrate = Some(Box::new(|session, request| {
            Ok(serde_json::json!({"runId":session.run_id,"root":session.workspace_root,"request":request}))
        }));
        let response = execute(&store, &hooks, &session, BridgeRequest::Orchestrate {
            request: crate::missions::orchestration::Request::List {},
        });
        assert!(response.ok);
        let value = response.value.unwrap();
        assert_eq!(value["runId"], session.run_id);
        assert_eq!(value["root"], root);
        assert_eq!(value["request"], serde_json::json!({"action":"list"}));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_shows_the_harness_peer_and_self() {
        let (dir, root) = sandbox("list");
        let (store, _bridge, session) = bound(&root);
        let hooks = BridgeHooks {
            orchestrate: None,
            on_change: Box::new(|_, _| {}),
            is_live: Box::new(|id| id == "run_kit"),
            resolve_session: Box::new(|_| None),
        };
        let response = execute(&store, &hooks, &session, BridgeRequest::List);
        assert!(response.ok, "{response:?}");
        let runs = response.value.unwrap()["runs"].as_array().unwrap().clone();
        let by_id = |id: &str| runs.iter().find(|r| r["runId"] == id).unwrap().clone();
        assert_eq!(by_id("run_kit")["relation"], "peer");
        assert_eq!(by_id("run_kit")["live"], true);
        assert_eq!(by_id("run_kit")["workerKind"], "harness");
        assert_eq!(by_id("convo-1")["relation"], "self");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn send_queues_for_review_and_wait_reads_only_accepted_mail() {
        let (dir, root) = sandbox("send-wait");
        let (store, _bridge, session) = bound(&root);
        let changes = Arc::new(Mutex::new(0usize));
        let counter = changes.clone();
        let hooks = BridgeHooks {
            orchestrate: None,
            on_change: Box::new(move |_, _| *counter.lock().unwrap() += 1),
            is_live: Box::new(|_| false),
            resolve_session: Box::new(|_| None),
        };

        // Delegate → Harness peer: queued, awaiting the peer's review.
        let sent = execute(
            &store,
            &hooks,
            &session,
            BridgeRequest::Send {
                to_run_id: "run_kit".into(),
                body: "Is the merge yours?".into(),
                kind: Some("question".into()),
                reply_to: None,
                correlation_id: None,
                idempotency_key: None,
                wait_for_reply: false,
                timeout_seconds: None,
            },
        );
        assert!(sent.ok, "{sent:?}");
        let value = sent.value.unwrap();
        assert_eq!(value["deliveryState"], "queued");
        let question_id = value["envelopeId"].as_str().unwrap().to_string();
        assert_eq!(*changes.lock().unwrap(), 1, "one change announced per append");

        // Unsolicited words from the Harness peer wait for the Delegate's
        // operator: a wait sees nothing until the card is answered.
        let nudged = coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::SendEnvelope {
                from: CoordinationActor::Run {
                    run_id: "run_kit".into(),
                },
                to_run_id: "convo-1".into(),
                kind: CoordinationEnvelopeKind::Instruction,
                body: "Don't touch pty.rs, I'm in it.".into(),
                reply_to: None,
                correlation_id: None,
                idempotency_key: None,
                source_refs: vec![],
            },
        )
        .unwrap();
        let nudge_id = match &nudged.appended.unwrap().event {
            CoordinationEvent::EnvelopeQueued { envelope } => envelope.id.clone(),
            other => panic!("{other:?}"),
        };
        let waited = execute(
            &store,
            &hooks,
            &session,
            BridgeRequest::Wait {
                from_run_id: Some("run_kit".into()),
                reply_to: None,
                timeout_seconds: Some(1),
            },
        );
        assert!(waited.ok);
        assert_eq!(waited.value.as_ref().unwrap()["timedOut"], true, "{waited:?}");

        // Operator accepts → the wait returns it, delivered and acknowledged.
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::ReviewEnvelope {
                actor: CoordinationActor::Operator,
                run_id: "convo-1".into(),
                envelope_id: nudge_id.clone(),
                accept: true,
            },
        )
        .unwrap();
        let waited = execute(
            &store,
            &hooks,
            &session,
            BridgeRequest::Wait {
                from_run_id: Some("run_kit".into()),
                reply_to: None,
                timeout_seconds: Some(1),
            },
        );
        let value = waited.value.unwrap();
        assert!(value["text"].as_str().unwrap().contains("[instruction"), "{value}");
        let snapshot = coordination::read_snapshot(&store, &root).unwrap();
        let entry = snapshot
            .envelopes
            .iter()
            .find(|e| e.envelope.id == nudge_id)
            .unwrap();
        assert_eq!(entry.delivery_state, CoordinationDeliveryState::Acknowledged);

        // A reply to the Delegate's own question was invited, so the journal
        // accepts it without a card and a wait on that reply returns at once.
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::SendEnvelope {
                from: CoordinationActor::Run {
                    run_id: "run_kit".into(),
                },
                to_run_id: "convo-1".into(),
                kind: CoordinationEnvelopeKind::Answer,
                body: "No — only read-only git here.".into(),
                reply_to: Some(question_id.clone()),
                correlation_id: None,
                idempotency_key: None,
                source_refs: vec![],
            },
        )
        .unwrap();
        let waited = execute(
            &store,
            &hooks,
            &session,
            BridgeRequest::Wait {
                from_run_id: None,
                reply_to: Some(question_id),
                timeout_seconds: Some(1),
            },
        );
        let value = waited.value.unwrap();
        assert!(value["text"].as_str().unwrap().contains("[answer"), "{value}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A waiting Delegate hears accepted mail when it is appended, not on the
    /// next floor poll.
    #[test]
    fn a_waiting_delegate_wakes_on_an_in_process_append() {
        let (dir, root) = sandbox("wait-wake");
        let (store, _bridge, session) = bound(&root);
        let nudged = coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::SendEnvelope {
                from: CoordinationActor::Run {
                    run_id: "run_kit".into(),
                },
                to_run_id: "convo-1".into(),
                kind: CoordinationEnvelopeKind::Instruction,
                body: "Rebase first.".into(),
                reply_to: None,
                correlation_id: None,
                idempotency_key: None,
                source_refs: vec![],
            },
        )
        .unwrap();
        let nudge_id = match &nudged.appended.unwrap().event {
            CoordinationEvent::EnvelopeQueued { envelope } => envelope.id.clone(),
            other => panic!("{other:?}"),
        };

        let (tx, rx) = std::sync::mpsc::channel();
        let waiter_store = store.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let waited = execute(
                &waiter_store,
                &BridgeHooks::silent(),
                &session,
                BridgeRequest::Wait {
                    from_run_id: Some("run_kit".into()),
                    reply_to: None,
                    timeout_seconds: Some(30),
                },
            );
            let _ = tx.send((waited, started.elapsed()));
        });
        std::thread::sleep(Duration::from_millis(100));
        let accepted_at = Instant::now();
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::ReviewEnvelope {
                actor: CoordinationActor::Operator,
                run_id: "convo-1".into(),
                envelope_id: nudge_id,
                accept: true,
            },
        )
        .unwrap();
        let (waited, _) = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("the wait never returned");
        assert!(
            accepted_at.elapsed() < WAIT_POLL,
            "woke on the floor poll, not the append"
        );
        let value = waited.value.unwrap();
        assert!(value["text"].as_str().unwrap().contains("Rebase first."), "{value}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn send_quality_reports_the_journal_state_on_idempotent_retries() {
        let (dir, root) = sandbox("receipt-quality");
        let (store, _bridge, session) = bound(&root);
        let request = BridgeRequest::Send {
            to_run_id: "run_kit".into(),
            body: "Please review".into(),
            kind: None,
            reply_to: None,
            correlation_id: None,
            idempotency_key: Some("receipt-quality".into()),
            wait_for_reply: false,
            timeout_seconds: None,
        };
        let sent = execute(&store, &BridgeHooks::silent(), &session, request.clone())
            .value
            .unwrap();
        let id = sent["envelopeId"].as_str().unwrap();
        for (command, expected) in [
            (
                CoordinationCommand::ReviewEnvelope {
                    actor: CoordinationActor::Operator,
                    run_id: "run_kit".into(),
                    envelope_id: id.into(),
                    accept: true,
                },
                "accepted",
            ),
            (
                CoordinationCommand::MarkEnvelopeDelivered {
                    run_id: "run_kit".into(),
                    envelope_id: id.into(),
                },
                "delivered",
            ),
            (
                CoordinationCommand::AcknowledgeEnvelope {
                    run_id: "run_kit".into(),
                    envelope_id: id.into(),
                },
                "acknowledged",
            ),
        ] {
            coordination::apply_coordination_command(&store, &root, command).unwrap();
            let reply = execute(&store, &BridgeHooks::silent(), &session, request.clone())
                .value
                .unwrap();
            assert_eq!(reply["deliveryState"], expected, "{reply}");
            assert_eq!(reply["envelopeId"], id);
            assert_eq!(
                coordination::read_snapshot(&store, &root)
                    .unwrap()
                    .envelopes
                    .len(),
                1
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn send_quality_keeps_reply_wait_separate_from_delivery() {
        for answer in [false, true] {
            let (dir, root) = sandbox(if answer {
                "receipt-reply"
            } else {
                "receipt-timeout"
            });
            let (store, _bridge, session) = bound(&root);
            let writer = store.clone();
            // Deterministic: the recipient acts immediately after the send is
            // journaled, before the bridge starts waiting. No model or sleeps.
            let hooks = BridgeHooks {
                orchestrate: None,
                on_change: Box::new(move |root, outcome| {
                    let Some(line) = &outcome.appended else {
                        return;
                    };
                    let CoordinationEvent::EnvelopeQueued { envelope } = &line.event else {
                        return;
                    };
                    if envelope.to_run_id != "run_kit" {
                        return;
                    }
                    if answer {
                        coordination::apply_coordination_command(
                            &writer,
                            root,
                            CoordinationCommand::SendEnvelope {
                                from: CoordinationActor::Run {
                                    run_id: "run_kit".into(),
                                },
                                to_run_id: "convo-1".into(),
                                kind: CoordinationEnvelopeKind::Answer,
                                body: "The review is ready.".into(),
                                reply_to: Some(envelope.id.clone()),
                                correlation_id: None,
                                idempotency_key: None,
                                source_refs: vec![],
                            },
                        )
                        .unwrap();
                    } else {
                        for command in [
                            CoordinationCommand::ReviewEnvelope {
                                actor: CoordinationActor::Operator,
                                run_id: "run_kit".into(),
                                envelope_id: envelope.id.clone(),
                                accept: true,
                            },
                            CoordinationCommand::MarkEnvelopeDelivered {
                                run_id: "run_kit".into(),
                                envelope_id: envelope.id.clone(),
                            },
                            CoordinationCommand::AcknowledgeEnvelope {
                                run_id: "run_kit".into(),
                                envelope_id: envelope.id.clone(),
                            },
                        ] {
                            coordination::apply_coordination_command(&writer, root, command).unwrap();
                        }
                    }
                }),
                is_live: Box::new(|_| true),
                resolve_session: Box::new(|_| None),
            };
            let result = execute(
                &store,
                &hooks,
                &session,
                BridgeRequest::Send {
                    to_run_id: "run_kit".into(),
                    body: "Please review".into(),
                    kind: Some("question".into()),
                    reply_to: None,
                    correlation_id: None,
                    idempotency_key: None,
                    wait_for_reply: true,
                    timeout_seconds: Some(1),
                },
            );
            assert!(result.ok, "{result:?}");
            let value = result.value.unwrap();
            if answer {
                // Receipt must not invent an acknowledgement for the sent
                // question just because the recipient supplied an answer.
                assert_eq!(value["deliveryState"], "queued");
                assert_eq!(value["replyStatus"], "received");
                assert_eq!(value["timedOut"], false);
                assert_eq!(value["replies"][0]["deliveryState"], "acknowledged");
                assert!(value["text"]
                    .as_str()
                    .unwrap()
                    .contains("The review is ready."));
            } else {
                assert_eq!(value["deliveryState"], "acknowledged");
                assert_eq!(value["replyStatus"], "timed_out");
                assert_eq!(value["timedOut"], true);
                assert!(value.get("replies").is_none());
            }
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn send_quality_reports_self_acceptance_and_declined_retries() {
        let (dir, root) = sandbox("receipt-declined");
        let (store, _bridge, session) = bound(&root);
        let mut request = BridgeRequest::Send {
            to_run_id: session.run_id.clone(),
            body: "A note".into(),
            kind: None,
            reply_to: None,
            correlation_id: None,
            idempotency_key: Some("note".into()),
            wait_for_reply: false,
            timeout_seconds: None,
        };
        let own = execute(&store, &BridgeHooks::silent(), &session, request.clone())
            .value
            .unwrap();
        assert_eq!(own["deliveryState"], "accepted");
        assert_eq!(own["replyStatus"], "not_requested");
        if let BridgeRequest::Send {
            to_run_id,
            idempotency_key,
            ..
        } = &mut request
        {
            *to_run_id = "run_kit".into();
            *idempotency_key = Some("peer-note".into());
        }
        let sent = execute(&store, &BridgeHooks::silent(), &session, request.clone())
            .value
            .unwrap();
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::ReviewEnvelope {
                actor: CoordinationActor::Operator,
                run_id: "run_kit".into(),
                envelope_id: sent["envelopeId"].as_str().unwrap().into(),
                accept: false,
            },
        )
        .unwrap();
        let retry = execute(&store, &BridgeHooks::silent(), &session, request)
            .value
            .unwrap();
        assert_eq!(retry["deliveryState"], "declined");
        assert_eq!(retry["envelopeId"], sent["envelopeId"]);
        assert_eq!(retry["timedOut"], false);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn publish_then_read_result_and_settle_on_exit() {
        let (dir, root) = sandbox("result");
        let (store, bridge, session) = bound(&root);
        let hooks = BridgeHooks::silent();
        let published = execute(
            &store,
            &hooks,
            &session,
            BridgeRequest::PublishResult {
                status: "succeeded".into(),
                summary: "Merged as 2912f9c.".into(),
            },
        );
        assert!(published.ok, "{published:?}");
        let read = execute(
            &store,
            &hooks,
            &session,
            BridgeRequest::ReadResult {
                run_id: "convo-1".into(),
            },
        );
        assert_eq!(read.value.unwrap()["ready"], true);

        let state_of = |id: &str| {
            coordination::read_snapshot(&store, &root)
                .unwrap()
                .runs
                .iter()
                .find(|r| r.registration.run_id == id)
                .unwrap()
                .state
        };
        note_delegate_status(&store, &hooks, &bridge, "convo-1:claude-code", "waiting").unwrap();
        assert_eq!(state_of("convo-1"), CoordinationRunState::Waiting);
        note_delegate_status(&store, &hooks, &bridge, "convo-1:claude-code", "working").unwrap();

        // An interactive conversation's CLI exiting is the thread going quiet,
        // not the Run ending: it rests in `waiting`, and a respawn (the same
        // registration again) moves it back to `working`.
        settle_delegate(&store, &hooks, &bridge, "convo-1:claude-code", 0, false).unwrap();
        assert!(bridge.session("convo-1:claude-code").is_none());
        assert_eq!(state_of("convo-1"), CoordinationRunState::Waiting);
        // A second exit for a forgotten session is a no-op, not an error.
        settle_delegate(&store, &hooks, &bridge, "convo-1:claude-code", 1, false).unwrap();
        register_delegate(
            &store,
            &hooks,
            &bridge,
            DelegateRegistration {
                session_id: "convo-1:claude-code",
                run_id: "convo-1",
                workspace_root: &root,
                task: None,
                parent_run_id: None,
                mission_id: None,
                mission_task_id: None,
                secret_sha256: &secret_sha256(SECRET),
            },
        )
        .unwrap();
        assert_eq!(state_of("convo-1"), CoordinationRunState::Working);
        assert_eq!(
            state_of("convo-1"),
            CoordinationRunState::Working,
            "re-registration is idempotent and re-enters working"
        );

        // A Mission attempt is terminal: its exit is the attempt's outcome.
        register_delegate(
            &store,
            &hooks,
            &bridge,
            DelegateRegistration {
                session_id: "attempt-7:codex",
                run_id: "attempt-7",
                workspace_root: &root,
                task: Some("run the tests"),
                parent_run_id: None,
                mission_id: Some("m1"),
                mission_task_id: Some("t1"),
                secret_sha256: &secret_sha256(SECRET),
            },
        )
        .unwrap();
        settle_delegate(&store, &hooks, &bridge, "attempt-7:codex", 2, false).unwrap();
        assert_eq!(state_of("attempt-7"), CoordinationRunState::Failed);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_http_door_binds_identity_from_the_session_map_only() {
        let (dir, root) = sandbox("http");
        let (store, bridge, _session) = bound(&root);
        let hooks = BridgeHooks::silent();
        let sessions = bridge.sessions.clone();
        let list = r#"{"op":"list"}"#;
        let (code, _) =
            handle_bridge_request("GET", "/coord/tok/convo-1:claude-code", Some(SECRET), list, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 405);
        let (code, _) =
            handle_bridge_request("POST", "/coord/nope/convo-1:claude-code", Some(SECRET), list, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 403);
        let (code, body) =
            handle_bridge_request("POST", "/coord/tok/stranger:codex", Some(SECRET), list, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 404);
        assert!(body.contains("not bound"));
        let (code, _) =
            handle_bridge_request("POST", "/coord/tok/convo-1:claude-code", Some(SECRET), "{", "tok", &sessions, &store, &hooks);
        assert_eq!(code, 400);
        // A request cannot smuggle an actor: the op vocabulary has no such field.
        let smuggled = r#"{"op":"send","from":{"type":"run","runId":"run_kit"},"toRunId":"run_kit","body":"hi"}"#;
        let (code, body) =
            handle_bridge_request("POST", "/coord/tok/convo-1:claude-code", Some(SECRET), smuggled, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 200, "{body}");
        let snapshot = coordination::read_snapshot(&store, &root).unwrap();
        let envelope = &snapshot.envelopes.last().unwrap().envelope;
        assert_eq!(
            envelope.from,
            CoordinationActor::Run {
                run_id: "convo-1".into()
            }
        );
        let (code, body) =
            handle_bridge_request("POST", "/coord/tok/convo-1:claude-code", Some(SECRET), r#"{"op":"read_result","runId":""}"#, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 422);
        assert!(body.contains("requires runId"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_session_this_process_never_bound_is_recovered_once_and_then_remembered() {
        // What every surviving Delegate looks like after an app restart: the
        // CLI is still running and still calling, and this process's session
        // map has never heard of it.
        let (dir, root) = sandbox("recover");
        let store = CoordinationStoreState::default();
        harness_peer(&store, &root, "run_kit");
        let hooks_root = root.clone();
        let asked = Arc::new(Mutex::new(0usize));
        let counted = asked.clone();
        let hooks = BridgeHooks {
            orchestrate: None,
            on_change: Box::new(|_, _| {}),
            is_live: Box::new(|_| false),
            resolve_session: Box::new(move |session_id| {
                *counted.lock().unwrap() += 1;
                (session_id == "convo-1:claude-code").then(|| BridgeSession {
                    run_id: "convo-1".to_string(),
                    workspace_root: hooks_root.clone(),
                    terminal: false,
                    secret_sha256: secret_sha256(SECRET),
                })
            }),
        };
        // The Run itself is durable, so it is still in the journal; only the
        // in-memory binding was lost.
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::RegisterRun {
                registration: CoordinationRunRegistration {
                    run_id: "convo-1".to_string(),
                    worker_kind: CoordinationWorkerKind::Delegate,
                    parent_run_id: None,
                    mission_id: None,
                    mission_task_id: None,
                    label: None,
                },
                initial_state: Some(CoordinationRunState::Working),
            },
        )
        .unwrap();

        let sessions: SessionMap = Default::default();
        let list = r#"{"op":"list"}"#;
        for _ in 0..2 {
            let (code, body) = handle_bridge_request(
                "POST",
                "/coord/tok/convo-1:claude-code",
                Some(SECRET),
                list,
                "tok",
                &sessions,
                &store,
                &hooks,
            );
            assert_eq!(code, 200, "{body}");
        }
        assert_eq!(
            *asked.lock().unwrap(),
            1,
            "recovered once, then served from the map"
        );
        assert_eq!(
            sessions.lock().unwrap().get("convo-1:claude-code").unwrap().run_id,
            "convo-1"
        );

        // A session nothing on disk vouches for stays unknown.
        let (code, body) = handle_bridge_request(
            "POST",
            "/coord/tok/stranger:codex",
            Some(SECRET),
            list,
            "tok",
            &sessions,
            &store,
            &hooks,
        );
        assert_eq!(code, 404, "{body}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_real_socket_round_trip() {
        let (dir, root) = sandbox("socket");
        let (store, bridge, _session) = bound(&root);
        let server = start_bridge_server(
            bridge.sessions.clone(),
            store.clone(),
            Arc::new(BridgeHooks::silent()),
            MAX_IN_FLIGHT,
        )
        .unwrap();
        let url = bridge_url(
            &BridgeEndpoint {
                port: server.port,
                token: server.token.clone(),
            },
            "convo-1:claude-code",
        );
        let client = test_client();
        let response: BridgeResponse = client
            .post(&url)
            .header(SECRET_HEADER, SECRET)
            .json(&BridgeRequest::List)
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(response.ok);
        assert_eq!(response.value.unwrap()["runs"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Every socket test talks through a client that cannot hang the suite.
    fn test_client() -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap()
    }

    fn second_session(store: &CoordinationStoreState, bridge: &CoordinationBridgeState, root: &str) {
        register_delegate(
            store,
            &BridgeHooks::silent(),
            bridge,
            DelegateRegistration {
                session_id: "convo-2:codex",
                run_id: "convo-2",
                workspace_root: root,
                task: None,
                parent_run_id: None,
                mission_id: None,
                mission_task_id: None,
                secret_sha256: &secret_sha256("secret-of-convo-2"),
            },
        )
        .unwrap();
    }

    /// The loophole this credential closes: every MCP child knows the app
    /// token, so before it a child could post to any other session's path and
    /// act as that Run. Now the path names a session and only that session's
    /// own secret opens it.
    #[test]
    fn a_session_answers_only_to_its_own_secret() {
        let (dir, root) = sandbox("own-secret");
        let (store, bridge, _session) = bound(&root);
        second_session(&store, &bridge, &root);
        let hooks = BridgeHooks::silent();
        let sessions = bridge.sessions.clone();
        let send = r#"{"op":"send","toRunId":"run_kit","body":"as whoever I like"}"#;
        let before = coordination::read_snapshot(&store, &root).unwrap().envelopes.len();
        for secret in [None, Some("guess"), Some("secret-of-convo-2"), Some("")] {
            let (code, body) = handle_bridge_request(
                "POST",
                "/coord/tok/convo-1:claude-code",
                secret,
                send,
                "tok",
                &sessions,
                &store,
                &hooks,
            );
            assert_eq!(code, 401, "{secret:?}: {body}");
            assert!(body.contains("Restart the Delegate"), "{body}");
        }
        assert_eq!(
            coordination::read_snapshot(&store, &root).unwrap().envelopes.len(),
            before,
            "a refused call writes nothing"
        );
        // Each session's own secret still opens its own path, as itself.
        for (path, secret, me) in [
            ("/coord/tok/convo-1:claude-code", SECRET, "convo-1"),
            ("/coord/tok/convo-2:codex", "secret-of-convo-2", "convo-2"),
        ] {
            let (code, body) =
                handle_bridge_request("POST", path, Some(secret), send, "tok", &sessions, &store, &hooks);
            assert_eq!(code, 200, "{body}");
            let snapshot = coordination::read_snapshot(&store, &root).unwrap();
            assert_eq!(
                snapshot.envelopes.last().unwrap().envelope.from,
                CoordinationActor::Run { run_id: me.into() }
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// After a restart the map is empty and the disk vouches for a session by
    /// its secret's hash. A caller who names that session without its secret
    /// must not get the binding — nor leave it behind for the next caller.
    #[test]
    fn a_recovered_session_is_remembered_only_for_its_own_secret() {
        let (dir, root) = sandbox("recover-secret");
        let store = CoordinationStoreState::default();
        harness_peer(&store, &root, "convo-1");
        let hooks_root = root.clone();
        let hooks = BridgeHooks {
            orchestrate: None,
            on_change: Box::new(|_, _| {}),
            is_live: Box::new(|_| false),
            resolve_session: Box::new(move |_| {
                Some(BridgeSession {
                    run_id: "convo-1".to_string(),
                    workspace_root: hooks_root.clone(),
                    terminal: false,
                    secret_sha256: secret_sha256(SECRET),
                })
            }),
        };
        let sessions: SessionMap = Default::default();
        let list = r#"{"op":"list"}"#;
        let path = "/coord/tok/convo-1:claude-code";
        for secret in [None, Some("secret-of-convo-2")] {
            let (code, body) =
                handle_bridge_request("POST", path, secret, list, "tok", &sessions, &store, &hooks);
            assert_eq!(code, 401, "{body}");
            assert!(sessions.lock().unwrap().is_empty(), "nothing was bound");
        }
        let (code, body) =
            handle_bridge_request("POST", path, Some(SECRET), list, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 200, "{body}");
        assert!(sessions.lock().unwrap().contains_key("convo-1:claude-code"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A settled Run stays settled: its secret proves who is calling, not that
    /// the Run may act again.
    #[test]
    fn a_recovered_session_whose_run_has_ended_is_not_bound() {
        let (dir, root) = sandbox("recover-ended");
        let store = CoordinationStoreState::default();
        harness_peer(&store, &root, "attempt-7");
        coordination::apply_coordination_command(
            &store,
            &root,
            CoordinationCommand::SetRunState {
                actor: CoordinationActor::Run { run_id: "attempt-7".into() },
                run_id: "attempt-7".into(),
                state: CoordinationRunState::Done,
                reason: None,
            },
        )
        .unwrap();
        let hooks_root = root.clone();
        let hooks = BridgeHooks {
            orchestrate: None,
            on_change: Box::new(|_, _| {}),
            is_live: Box::new(|_| false),
            resolve_session: Box::new(move |_| {
                Some(BridgeSession {
                    run_id: "attempt-7".to_string(),
                    workspace_root: hooks_root.clone(),
                    terminal: true,
                    secret_sha256: secret_sha256(SECRET),
                })
            }),
        };
        let sessions: SessionMap = Default::default();
        let (code, body) = handle_bridge_request(
            "POST",
            "/coord/tok/attempt-7:codex",
            Some(SECRET),
            r#"{"op":"list"}"#,
            "tok",
            &sessions,
            &store,
            &hooks,
        );
        assert_eq!(code, 404, "{body}");
        assert!(body.contains("has ended"), "{body}");
        assert!(sessions.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_bridge_serves_at_most_its_cap_at_once() {
        let (dir, root) = sandbox("cap");
        let (store, bridge, _session) = bound(&root);
        let server = start_bridge_server(
            bridge.sessions.clone(),
            store.clone(),
            Arc::new(BridgeHooks::silent()),
            2,
        )
        .unwrap();
        let url = bridge_url(
            &BridgeEndpoint {
                port: server.port,
                token: server.token.clone(),
            },
            "convo-1:claude-code",
        );
        let wait = BridgeRequest::Wait {
            from_run_id: None,
            reply_to: None,
            timeout_seconds: Some(3),
        };
        let blocked: Vec<_> = (0..2)
            .map(|_| {
                let (url, wait) = (url.clone(), wait.clone());
                std::thread::spawn(move || {
                    test_client()
                        .post(&url)
                        .header(SECRET_HEADER, SECRET)
                        .json(&wait)
                        .send()
                        .unwrap()
                        .status()
                        .as_u16()
                })
            })
            .collect();
        let deadline = Instant::now() + Duration::from_secs(10);
        while server.in_flight.load(Ordering::SeqCst) < 2 {
            assert!(Instant::now() < deadline, "the two waits never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        let third = test_client()
            .post(&url)
            .header(SECRET_HEADER, SECRET)
            .json(&wait)
            .send()
            .unwrap();
        assert_eq!(third.status().as_u16(), 503);
        for waiter in blocked {
            assert_eq!(waiter.join().unwrap(), 200);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.in_flight.load(Ordering::SeqCst) != 0 {
            assert!(Instant::now() < deadline, "slots come back");
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Raw HTTP, so the test controls exactly what is (not) sent after the
    /// headers.
    fn raw_status(port: u16, head: &str) -> (String, std::net::TcpStream) {
        use std::io::{BufRead, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(10))).unwrap();
        stream.write_all(head.as_bytes()).unwrap();
        let mut line = String::new();
        std::io::BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        (line, stream)
    }

    /// A rejected caller is answered from its headers: the body is never
    /// awaited, a claimed-huge body is never buffered, and neither holds up
    /// the next caller.
    #[test]
    fn a_rejected_caller_is_answered_without_reading_its_body() {
        let (dir, root) = sandbox("no-body");
        let (store, bridge, _session) = bound(&root);
        let server = start_bridge_server(
            bridge.sessions.clone(),
            store.clone(),
            Arc::new(BridgeHooks::silent()),
            MAX_IN_FLIGHT,
        )
        .unwrap();
        let port = server.port;
        let path = "/coord/nope/convo-1:claude-code";
        // Declares an exabyte and sends none of it.
        let (line, _huge) = raw_status(
            port,
            &format!("POST {path} HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000000000000000\r\n\r\n"),
        );
        assert!(line.contains(" 413"), "{line}");
        // Declares more than tiny_http buffers and never sends it.
        let (line, _stalled) = raw_status(
            port,
            &format!("POST {path} HTTP/1.1\r\nHost: x\r\nContent-Length: 4096\r\n\r\n"),
        );
        assert!(line.contains(" 403"), "{line}");
        // Both callers still hold their connections open; the door still works.
        let url = bridge_url(
            &BridgeEndpoint {
                port,
                token: server.token.clone(),
            },
            "convo-1:claude-code",
        );
        let ok: BridgeResponse = test_client()
            .post(&url)
            .header(SECRET_HEADER, SECRET)
            .json(&BridgeRequest::List)
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(ok.ok, "{ok:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
