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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Hard ceiling on one blocking wait, matching the Harness Tool schema.
pub const MAX_WAIT_SECONDS: u64 = 120;
const DEFAULT_WAIT_SECONDS: u64 = 30;
const WAIT_POLL: Duration = Duration::from_millis(400);
const MAX_BODY_BYTES: usize = 256 * 1024;

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
}

pub type SessionMap = Arc<Mutex<HashMap<String, BridgeSession>>>;

/// The five operations a Delegate may perform, mirroring the Harness Tools
/// `agent_list` / `agent_send` / `agent_wait` / `agent_read_result` plus
/// `agent_publish_result` (a Harness Run publishes its result automatically
/// at settle; a Delegate has to say so). This is the wire between the MCP
/// child and the bridge — never exposed beyond loopback.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum BridgeRequest {
    List,
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
pub struct BridgeHooks {
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

fn parse_kind(kind: Option<&str>) -> Result<CoordinationEnvelopeKind, String> {
    match kind.map(str::trim).filter(|k| !k.is_empty()) {
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

fn kind_label(kind: CoordinationEnvelopeKind) -> &'static str {
    match kind {
        CoordinationEnvelopeKind::Instruction => "instruction",
        CoordinationEnvelopeKind::Question => "question",
        CoordinationEnvelopeKind::Answer => "answer",
        CoordinationEnvelopeKind::Progress => "progress",
        CoordinationEnvelopeKind::Handoff => "handoff",
    }
}

fn actor_label(actor: &CoordinationActor) -> String {
    match actor {
        CoordinationActor::Operator => "operator".to_string(),
        CoordinationActor::Run { run_id } => format!("@{run_id}"),
    }
}

/// The same fixed prose the Harness hands its model for delivered mail, so a
/// Delegate and a Harness Run read peers' words in one shape.
pub fn messages_text(inbox: &[CoordinationEnvelopeSnapshot]) -> String {
    let mut text = String::from("Coordination messages received:");
    for entry in inbox {
        let envelope = &entry.envelope;
        text.push_str(&format!(
            "\n\n[{} {} from {}]\n{}",
            kind_label(envelope.kind),
            envelope.id,
            actor_label(&envelope.from),
            envelope.body
        ));
    }
    text
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
            .filter(|entry| {
                let from_ok = match from_run_id {
                    None => true,
                    Some(expected) => matches!(
                        &entry.envelope.from,
                        CoordinationActor::Run { run_id } if run_id == expected
                    ),
                };
                let reply_ok = match reply_to {
                    None => true,
                    Some(id) => entry.envelope.reply_to.as_deref() == Some(id),
                };
                from_ok && reply_ok
            })
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
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(WAIT_POLL);
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
            let kind = parse_kind(kind.as_deref())?;
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
                    "The message was recorded but its envelope could not be resolved."
                        .to_string()
                })?;
            if !wait_for_reply {
                return Ok(serde_json::json!({
                    "envelopeId": envelope.id,
                    "deliveryState": "queued",
                    "text": format!("Message {} queued for @{target}.", envelope.id),
                }));
            }
            match wait_for_messages(
                store,
                hooks,
                session,
                Some(&target),
                Some(&envelope.id),
                clamp_timeout(timeout_seconds),
            )? {
                Some(replies) => Ok(serde_json::json!({
                    "envelopeId": envelope.id,
                    "deliveryState": "acknowledged",
                    "replies": replies,
                    "text": messages_text(&replies),
                })),
                None => Ok(serde_json::json!({
                    "envelopeId": envelope.id,
                    "deliveryState": "queued",
                    "timedOut": true,
                    "text": format!(
                        "Message {} was queued for @{target}; no reply arrived within the wait window.",
                        envelope.id
                    ),
                })),
            }
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
                    "text": messages_text(&messages),
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

/// Bind 127.0.0.1 on an ephemeral port. Unlike the status hook server, each
/// request gets its own thread: an `agent_wait` blocks for up to two minutes
/// and must not hold up a peer's `agent_send` on the same port.
pub fn start_bridge_server(
    sessions: SessionMap,
    store: CoordinationStoreState,
    hooks: Arc<BridgeHooks>,
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
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let sessions = sessions.clone();
            let store = store.clone();
            let hooks = hooks.clone();
            let token = thread_token.clone();
            std::thread::spawn(move || {
                let method = request.method().to_string();
                let url = request.url().to_string();
                let mut body = String::new();
                use std::io::Read;
                let _ = request
                    .as_reader()
                    .take(MAX_BODY_BYTES as u64)
                    .read_to_string(&mut body);
                let (code, payload) =
                    handle_bridge_request(&method, &url, &body, &token, &sessions, &store, &hooks);
                let response = tiny_http::Response::from_string(payload)
                    .with_status_code(code)
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .unwrap(),
                    );
                let _ = request.respond(response);
            });
        }
    });
    Ok(BridgeServer { port, token })
}

/// Serve one `POST /coord/<token>/<session_id>` carrying a [`BridgeRequest`].
/// Returns the HTTP status and a JSON [`BridgeResponse`] body. Pure apart
/// from the journal, so tests drive it without a socket.
pub fn handle_bridge_request(
    method: &str,
    url: &str,
    body: &str,
    token: &str,
    sessions: &SessionMap,
    store: &CoordinationStoreState,
    hooks: &BridgeHooks,
) -> (u16, String) {
    let respond = |code: u16, response: BridgeResponse| {
        (
            code,
            serde_json::to_string(&response).unwrap_or_else(|_| "{\"ok\":false}".to_string()),
        )
    };
    if method != "POST" {
        return respond(405, BridgeResponse::err("POST only."));
    }
    let path = url.split('?').next().unwrap_or(url);
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    if segments.len() < 3 || segments[0] != "coord" {
        return respond(404, BridgeResponse::err("Unknown bridge path."));
    }
    if segments[1] != token {
        return respond(403, BridgeResponse::err("Bridge token rejected."));
    }
    // The session id is `{convoId}:{provider}` and may itself hold separators.
    let session_id = segments[2..].join("/");
    // Bound in this process, or rebuilt from disk for a session that outlived
    // the app. The guard is dropped before the hook runs — it takes the same
    // lock to remember what it found.
    let bound = sessions.lock().unwrap().get(&session_id).cloned();
    let session = match bound {
        Some(session) => session,
        None => match (hooks.resolve_session)(&session_id) {
            Some(recovered) => {
                sessions
                    .lock()
                    .unwrap()
                    .insert(session_id.clone(), recovered.clone());
                recovered
            }
            None => {
                return respond(
                    404,
                    BridgeResponse::err(
                        "This Delegate session is not bound to a coordination Run.",
                    ),
                )
            }
        },
    };
    let request: BridgeRequest = match serde_json::from_str(body) {
        Ok(request) => request,
        Err(e) => return respond(400, BridgeResponse::err(format!("Bad bridge request: {e}"))),
    };
    let response = execute(store, hooks, &session, request);
    let code = if response.ok { 200 } else { 422 };
    respond(code, response)
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
    bridge.bind_session(
        reg.session_id,
        BridgeSession {
            run_id: reg.run_id.to_string(),
            workspace_root: reg.workspace_root.to_string(),
            terminal: reg.mission_id.is_some(),
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

    #[test]
    fn list_shows_the_harness_peer_and_self() {
        let (dir, root) = sandbox("list");
        let (store, _bridge, session) = bound(&root);
        let hooks = BridgeHooks {
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
            handle_bridge_request("GET", "/coord/tok/convo-1:claude-code", list, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 405);
        let (code, _) =
            handle_bridge_request("POST", "/coord/nope/convo-1:claude-code", list, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 403);
        let (code, body) =
            handle_bridge_request("POST", "/coord/tok/stranger:codex", list, "tok", &sessions, &store, &hooks);
        assert_eq!(code, 404);
        assert!(body.contains("not bound"));
        let (code, _) =
            handle_bridge_request("POST", "/coord/tok/convo-1:claude-code", "{", "tok", &sessions, &store, &hooks);
        assert_eq!(code, 400);
        // A request cannot smuggle an actor: the op vocabulary has no such field.
        let smuggled = r#"{"op":"send","from":{"type":"run","runId":"run_kit"},"toRunId":"run_kit","body":"hi"}"#;
        let (code, body) =
            handle_bridge_request("POST", "/coord/tok/convo-1:claude-code", smuggled, "tok", &sessions, &store, &hooks);
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
            handle_bridge_request("POST", "/coord/tok/convo-1:claude-code", r#"{"op":"read_result","runId":""}"#, "tok", &sessions, &store, &hooks);
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
            on_change: Box::new(|_, _| {}),
            is_live: Box::new(|_| false),
            resolve_session: Box::new(move |session_id| {
                *counted.lock().unwrap() += 1;
                (session_id == "convo-1:claude-code").then(|| BridgeSession {
                    run_id: "convo-1".to_string(),
                    workspace_root: hooks_root.clone(),
                    terminal: false,
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
        )
        .unwrap();
        let url = bridge_url(
            &BridgeEndpoint {
                port: server.port,
                token: server.token.clone(),
            },
            "convo-1:claude-code",
        );
        let client = reqwest::blocking::Client::new();
        let response: BridgeResponse = client
            .post(&url)
            .json(&BridgeRequest::List)
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert!(response.ok);
        assert_eq!(response.value.unwrap()["runs"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
