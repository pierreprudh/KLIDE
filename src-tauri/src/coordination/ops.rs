//! One core function per coordination operation, two thin doors.
//!
//! A Harness Run reaches the journal through its native `agent_*` Tools
//! (agent/tool_handlers.rs); a Delegate CLI reaches it through the loopback
//! bridge (coordination_bridge.rs) behind `klide mcp coordination`. Both used
//! to assemble the five operations again from the journal's building blocks,
//! and they drifted: which mail a wait marked delivered, the timeout sentence,
//! the shape of a result, what `agent_list` promised. This module is the one
//! place those decisions are made. A door keeps exactly two jobs — bind the
//! actor (the Harness from `ctx.id`, the bridge from the PTY session it
//! authenticated) and wrap the reply in its own transport (`ToolResult`,
//! `BridgeResponse`). Nothing here reads an actor from a request field, and
//! the security rules stay where they are enforced: in the journal core's
//! `event_for_command`, before any event is appended.
//!
//! Delivered means "about to be read". An envelope moves to `delivered` only
//! when its text is being handed to the model. The turn boundary projects
//! every accepted envelope into the turn, so [`take_inbox`] marks them all;
//! a wait hands back only the envelopes that answered it, so [`wait`] marks
//! only those — delivered and then acknowledged in the same call, because
//! returning the text over a tool result *is* the read. Accepted mail a wait
//! did not match stays `accepted` and gets its own delivery later. (The
//! Harness door used to mark everything accepted as delivered on every wait
//! poll, so the journal claimed a Run had read mail its model never saw.)

use super::{
    envelope_answers_wait, inbox_for, relation_label, send_receipt, visible_result_for,
    visible_runs_for, CoordinationActor, CoordinationCommand, CoordinationCommandOutcome,
    CoordinationDeliveryState, CoordinationEnvelope, CoordinationEnvelopeKind,
    CoordinationEnvelopeSnapshot, CoordinationEvent, CoordinationReplyStatus, CoordinationResult,
    CoordinationRunState, CoordinationSendReceipt, CoordinationSnapshot, CoordinationWorkerKind,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::future::Future;
use std::time::{Duration, Instant};

pub const AGENT_LIST: &str = "agent_list";
pub const AGENT_SEND: &str = "agent_send";
pub const AGENT_WAIT: &str = "agent_wait";
pub const AGENT_CANCEL: &str = "agent_cancel";
pub const AGENT_READ_RESULT: &str = "agent_read_result";
/// The five operations, in the order every door lists them.
pub const TOOL_NAMES: [&str; 5] = [AGENT_LIST, AGENT_SEND, AGENT_WAIT, AGENT_CANCEL, AGENT_READ_RESULT];

/// Hard ceiling on one blocking wait; the Tool schemas say the same number.
pub const MAX_WAIT_SECONDS: u64 = 120;
pub const DEFAULT_WAIT_SECONDS: u64 = 30;
/// A waiter is woken by the journal itself when this process appends; this
/// floor only bounds how late it sees an append from another Klide process,
/// which wakes nobody here.
pub const WAIT_FLOOR: Duration = Duration::from_secs(2);

const TIMEOUT_TEXT: &str =
    "No coordination message answering this wait arrived within the wait window.";

/// The Run an operation acts as, already authenticated by the door.
#[derive(Clone, Copy, Debug)]
pub struct Actor<'a> {
    pub run_id: &'a str,
    pub workspace_root: &'a str,
}

impl Actor<'_> {
    fn as_coordination_actor(&self) -> CoordinationActor {
        CoordinationActor::Run {
            run_id: self.run_id.to_string(),
        }
    }
}

/// What the core needs from the process hosting it: the journal's one writer
/// gate and one reader (plus whatever the host announces after a write), and
/// two things only a host knows — whether a Run is around right now, and how
/// to signal the live cancellation of a Run it executes.
pub trait CoordinationHost: Sync {
    fn apply(
        &self,
        workspace_root: &str,
        command: CoordinationCommand,
    ) -> Result<CoordinationCommandOutcome, String>;
    fn snapshot(&self, workspace_root: &str) -> Result<CoordinationSnapshot, String>;
    /// A top-level conversation rests in `waiting` between user turns forever,
    /// so the journal alone cannot say whether a peer is around; the host can.
    fn is_live(&self, run_id: &str) -> bool;
    /// Trigger the live cancellation of `run_id` if this host holds it. The
    /// durable request is always recorded first; this is the local echo.
    /// `false` when nothing local is attached.
    fn signal_cancel(&self, run_id: &str) -> bool;
}

/// Why a park returned. A door decides what a pause looks like; the core
/// decides when to pause and for how long.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Parked {
    /// The journal moved (or may have); read it again.
    Woken,
    /// The pause elapsed; read it again, the deadline decides.
    Elapsed,
    /// The Run was cancelled while waiting.
    Cancelled,
}

/// How a door blocks between two reads of the journal. The Harness parks on
/// the async `watch` wake beside its cancellation token; the bridge's request
/// thread parks on the journal's condvar. Both wakes are the same
/// `Journal::announce`.
pub trait Park: Send {
    /// Return within `pause`, or as soon as the journal has announced a next
    /// `seq` other than `seen_next_seq` (the cursor of the snapshot the core
    /// just read).
    fn park(&mut self, pause: Duration, seen_next_seq: u64)
        -> impl Future<Output = Parked> + Send;
}

/// A door that never cancels a wait: the bridge, and tests.
pub struct NeverCancelled<'a> {
    store: &'a super::CoordinationStoreState,
    workspace_root: &'a str,
}

impl<'a> NeverCancelled<'a> {
    pub fn new(store: &'a super::CoordinationStoreState, workspace_root: &'a str) -> Self {
        Self {
            store,
            workspace_root,
        }
    }
}

impl Park for NeverCancelled<'_> {
    fn park(&mut self, pause: Duration, seen_next_seq: u64)
        -> impl Future<Output = Parked> + Send {
        // Blocks the calling thread here, before the future exists: this park
        // is for plain threads, driven by [`block_on`].
        let parked = match super::wait_for_change(self.store, self.workspace_root, seen_next_seq, pause) {
            Ok(()) => Parked::Woken,
            Err(_) => Parked::Elapsed,
        };
        async move { parked }
    }
}

/// Drive a core operation to completion on a plain thread. Only for a
/// [`Park`] that blocks synchronously (the bridge's): such a future never
/// returns `Pending`, so no runtime is needed — and none may be assumed, a
/// bridge request thread has none.
pub fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    loop {
        if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        // Unreachable with a synchronous park; a spin here would be a bug in
        // the door, not a wait, so yield rather than burn the core.
        std::thread::yield_now();
    }
}

/// An operation that can be interrupted by the Run's cancellation.
#[derive(Debug)]
pub enum Settled<T> {
    Done(T),
    Cancelled,
}

// ── Requests ────────────────────────────────────────────────────────────

fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    trimmed(args.get(key).and_then(Value::as_str))
}

fn timeout_arg(args: &Value) -> Option<u64> {
    args.get("timeoutSeconds").and_then(Value::as_u64)
}

/// The one clamp: absent → 30 s, then 1..=120.
pub fn clamp_timeout(seconds: Option<u64>) -> Duration {
    Duration::from_secs(
        seconds
            .unwrap_or(DEFAULT_WAIT_SECONDS)
            .clamp(1, MAX_WAIT_SECONDS),
    )
}

/// The one kind parser. A reply is an answer: with `replyTo` set, an omitted
/// kind means answer; otherwise instruction.
pub fn parse_kind(kind: Option<&str>, is_reply: bool) -> Result<CoordinationEnvelopeKind, String> {
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SendRequest {
    pub to_run_id: String,
    pub body: String,
    pub kind: Option<String>,
    pub reply_to: Option<String>,
    pub correlation_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub wait_for_reply: bool,
    pub timeout_seconds: Option<u64>,
}

impl SendRequest {
    pub fn from_json(args: &Value) -> Self {
        Self {
            to_run_id: str_arg(args, "toRunId").unwrap_or_default(),
            body: str_arg(args, "body").unwrap_or_default(),
            kind: str_arg(args, "kind"),
            reply_to: str_arg(args, "replyTo"),
            correlation_id: str_arg(args, "correlationId"),
            idempotency_key: str_arg(args, "idempotencyKey"),
            wait_for_reply: args
                .get("waitForReply")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            timeout_seconds: timeout_arg(args),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WaitRequest {
    pub from_run_id: Option<String>,
    pub reply_to: Option<String>,
    pub timeout_seconds: Option<u64>,
}

impl WaitRequest {
    pub fn from_json(args: &Value) -> Self {
        Self {
            from_run_id: str_arg(args, "fromRunId"),
            reply_to: str_arg(args, "replyTo"),
            timeout_seconds: timeout_arg(args),
        }
    }
}

/// The five operations, as one door or the other received them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Operation {
    List,
    Send(SendRequest),
    Wait(WaitRequest),
    Cancel {
        run_id: String,
        reason: Option<String>,
    },
    ReadResult {
        run_id: String,
    },
}

impl Operation {
    /// A Tool call by name and JSON arguments. `None` for a name that is not
    /// one of the five.
    pub fn from_tool_call(name: &str, args: &Value) -> Option<Self> {
        Some(match name {
            AGENT_LIST => Self::List,
            AGENT_SEND => Self::Send(SendRequest::from_json(args)),
            AGENT_WAIT => Self::Wait(WaitRequest::from_json(args)),
            AGENT_CANCEL => Self::Cancel {
                run_id: str_arg(args, "runId").unwrap_or_default(),
                reason: str_arg(args, "reason"),
            },
            AGENT_READ_RESULT => Self::ReadResult {
                run_id: str_arg(args, "runId").unwrap_or_default(),
            },
            _ => return None,
        })
    }

    /// Whether this operation may block on the journal — a door that has a
    /// status to show (the Harness's `paused`) asks before performing it.
    pub fn may_block(&self) -> bool {
        match self {
            Self::Wait(_) => true,
            Self::Send(request) => request.wait_for_reply,
            _ => false,
        }
    }
}

// ── Results and their one rendering ─────────────────────────────────────

/// One row of `agent_list`, as both doors return it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerRow {
    pub run_id: String,
    pub relation: &'static str,
    pub state: CoordinationRunState,
    pub live: bool,
    pub worker_kind: CoordinationWorkerKind,
    pub label: Option<String>,
    pub mission_id: Option<String>,
    pub cancel_requested: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    Delivered(Vec<CoordinationEnvelopeSnapshot>),
    TimedOut,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelOutcome {
    pub run_id: String,
    /// Whether the host held the Run and signalled its live cancellation.
    pub live: bool,
}

/// What a door hands its caller: the text the model reads, and the structured
/// value beside it (Harness Tool metadata, MCP `structuredContent`). Same text
/// through both doors — the only differences a model can see between being a
/// Harness Run and a Delegate are in what its CLI does with the value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpReply {
    pub text: String,
    pub value: Value,
}

impl OpReply {
    fn list(rows: &[PeerRow]) -> Self {
        Self {
            text: serde_json::to_string_pretty(rows).unwrap_or_else(|_| "[]".to_string()),
            value: json!({ "runs": rows }),
        }
    }

    fn send(receipt: CoordinationSendReceipt) -> Result<Self, String> {
        Ok(Self {
            text: receipt.text.clone(),
            value: serde_json::to_value(receipt)
                .map_err(|error| format!("Unable to encode send receipt: {error}"))?,
        })
    }

    fn wait(outcome: &WaitOutcome) -> Result<Self, String> {
        Ok(match outcome {
            WaitOutcome::Delivered(messages) => Self {
                // Another agent's words: fenced like every delivery.
                text: crate::agent::delivery::render_mail(messages)?,
                value: json!({ "messages": messages, "timedOut": false }),
            },
            WaitOutcome::TimedOut => Self {
                text: TIMEOUT_TEXT.to_string(),
                value: json!({ "messages": [], "timedOut": true }),
            },
        })
    }

    fn cancel(outcome: &CancelOutcome) -> Self {
        Self {
            text: if outcome.live {
                format!(
                    "Cancellation requested for @{}; its live cancellation was signalled.",
                    outcome.run_id
                )
            } else {
                format!(
                    "Cancellation requested for @{}; no live local handle was attached, the request is recorded.",
                    outcome.run_id
                )
            },
            value: json!(outcome),
        }
    }

    /// A result is handed over as its JSON record rather than prose: status,
    /// summary, artifacts and source references are exactly what the reader
    /// acts on, and a rewording (the bridge used to lowercase a sentence)
    /// loses the artifact list and mangles the summary's casing.
    fn read_result(run_id: &str, result: Option<&CoordinationResult>) -> Self {
        match result {
            Some(result) => Self {
                text: serde_json::to_string_pretty(result)
                    .unwrap_or_else(|_| result.summary.clone()),
                value: json!({ "ready": true, "runId": run_id, "result": result }),
            },
            None => Self {
                text: format!("@{run_id} has not published a result yet."),
                value: json!({ "ready": false, "runId": run_id }),
            },
        }
    }
}

// ── The operations ──────────────────────────────────────────────────────

/// Every Run registered in this Workspace's journal, labelled relative to the
/// actor. Visibility is the journal core's (`visible_runs_for`); liveness is
/// the host's.
pub fn list(host: &dyn CoordinationHost, actor: Actor<'_>) -> Result<Vec<PeerRow>, String> {
    let snapshot = host.snapshot(actor.workspace_root)?;
    Ok(visible_runs_for(&snapshot, actor.run_id)?
        .into_iter()
        .map(|run| {
            let run_id = run.registration.run_id;
            PeerRow {
                relation: relation_label(&snapshot, actor.run_id, &run_id),
                state: run.state,
                live: host.is_live(&run_id),
                worker_kind: run.registration.worker_kind,
                label: run.registration.label,
                mission_id: run.registration.mission_id,
                cancel_requested: run.cancel_request.is_some(),
                run_id,
            }
        })
        .collect())
}

/// The envelope a send produced — the appended one, or on an idempotent retry
/// that appended nothing, the one the journal already holds for this route
/// and key.
fn envelope_from_outcome(
    outcome: &CoordinationCommandOutcome,
    from: &CoordinationActor,
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
                (&envelope.from == from
                    && envelope.to_run_id == target
                    && envelope.idempotency_key == *idempotency_key)
                    .then(|| envelope.clone())
            })
        })
}

/// Queue one envelope for the receiving side's review and report what the
/// journal says about it; with `waitForReply`, block for the answer first.
pub async fn send<P: Park>(
    host: &dyn CoordinationHost,
    actor: Actor<'_>,
    request: &SendRequest,
    park: &mut P,
) -> Result<Settled<CoordinationSendReceipt>, String> {
    let target = request.to_run_id.trim().to_string();
    let body = request.body.trim().to_string();
    if target.is_empty() || body.is_empty() {
        return Err("agent_send requires non-empty toRunId and body.".into());
    }
    let reply_to = trimmed(request.reply_to.as_deref());
    let kind = parse_kind(request.kind.as_deref(), reply_to.is_some())?;
    let idempotency_key = trimmed(request.idempotency_key.as_deref());
    let from = actor.as_coordination_actor();
    let outcome = host.apply(
        actor.workspace_root,
        CoordinationCommand::SendEnvelope {
            from: from.clone(),
            to_run_id: target.clone(),
            kind,
            body,
            reply_to,
            correlation_id: trimmed(request.correlation_id.as_deref()),
            idempotency_key: idempotency_key.clone(),
            source_refs: vec![],
        },
    )?;
    let envelope = envelope_from_outcome(&outcome, &from, &target, &idempotency_key)
        .ok_or_else(|| "The message was recorded but its envelope could not be resolved.".to_string())?;
    let (reply_status, replies, snapshot) = if request.wait_for_reply {
        let waited = wait(
            host,
            actor,
            &WaitRequest {
                from_run_id: Some(target),
                reply_to: Some(envelope.id.clone()),
                timeout_seconds: request.timeout_seconds,
            },
            park,
        )
        .await?;
        // Waiting moved mail to delivered and acknowledged, so the receipt has
        // to read the journal after it, not before.
        let snapshot = host.snapshot(actor.workspace_root)?;
        match waited {
            Settled::Cancelled => return Ok(Settled::Cancelled),
            Settled::Done(WaitOutcome::Delivered(replies)) => {
                (CoordinationReplyStatus::Received, replies, snapshot)
            }
            Settled::Done(WaitOutcome::TimedOut) => {
                (CoordinationReplyStatus::TimedOut, vec![], snapshot)
            }
        }
    } else {
        // Nothing has touched the journal since the send, and the command
        // already handed back the post-command snapshot — including on the
        // idempotent retry that appended nothing, which is exactly the state
        // this receipt reports.
        (CoordinationReplyStatus::NotRequested, vec![], outcome.snapshot)
    };
    Ok(Settled::Done(send_receipt(
        &snapshot,
        &envelope.id,
        reply_status,
        &replies,
    )?))
}

/// Block until accepted mail answering the request arrives for the actor, or
/// the (clamped) timeout passes. Matched mail is marked delivered and then
/// acknowledged in the same call: handing the text back is the read.
/// Accepted mail that did not match is left exactly as it was.
pub async fn wait<P: Park>(
    host: &dyn CoordinationHost,
    actor: Actor<'_>,
    request: &WaitRequest,
    park: &mut P,
) -> Result<Settled<WaitOutcome>, String> {
    let from_run_id = trimmed(request.from_run_id.as_deref());
    let reply_to = trimmed(request.reply_to.as_deref());
    let deadline = Instant::now() + clamp_timeout(request.timeout_seconds);
    loop {
        let snapshot = host.snapshot(actor.workspace_root)?;
        let matched = inbox_for(&snapshot, actor.run_id)?
            .into_iter()
            .filter(|entry| {
                envelope_answers_wait(entry, from_run_id.as_deref(), reply_to.as_deref())
            })
            .collect::<Vec<_>>();
        if !matched.is_empty() {
            for entry in &matched {
                if entry.delivery_state == CoordinationDeliveryState::Accepted {
                    host.apply(
                        actor.workspace_root,
                        CoordinationCommand::MarkEnvelopeDelivered {
                            run_id: actor.run_id.to_string(),
                            envelope_id: entry.envelope.id.clone(),
                        },
                    )?;
                }
            }
            acknowledge(host, actor, &matched)?;
            return Ok(Settled::Done(WaitOutcome::Delivered(matched)));
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(Settled::Done(WaitOutcome::TimedOut));
        }
        let pause = WAIT_FLOOR.min(deadline.saturating_duration_since(now));
        if park.park(pause, snapshot.next_seq).await == Parked::Cancelled {
            return Ok(Settled::Cancelled);
        }
    }
}

/// Record a cancellation request in the journal (the core checks that the
/// actor may: itself or a direct child), then echo it to the live Run if the
/// host holds one.
pub fn cancel(
    host: &dyn CoordinationHost,
    actor: Actor<'_>,
    run_id: &str,
    reason: Option<&str>,
) -> Result<CancelOutcome, String> {
    let target = run_id.trim();
    if target.is_empty() {
        return Err("agent_cancel requires runId.".into());
    }
    host.apply(
        actor.workspace_root,
        CoordinationCommand::RequestCancel {
            actor: actor.as_coordination_actor(),
            run_id: target.to_string(),
            reason: trimmed(reason),
        },
    )?;
    Ok(CancelOutcome {
        run_id: target.to_string(),
        live: host.signal_cancel(target),
    })
}

/// The result a visible Run published, or `None` while it has not.
pub fn read_result(
    host: &dyn CoordinationHost,
    actor: Actor<'_>,
    run_id: &str,
) -> Result<Option<CoordinationResult>, String> {
    let target = run_id.trim();
    if target.is_empty() {
        return Err("agent_read_result requires runId.".into());
    }
    let snapshot = host.snapshot(actor.workspace_root)?;
    visible_result_for(&snapshot, actor.run_id, target)
}

/// Run one operation as the actor and render its reply. `Err` is a readable
/// line for the caller (a Tool error, an MCP tool error) — never a crash.
pub async fn perform<P: Park>(
    host: &dyn CoordinationHost,
    actor: Actor<'_>,
    operation: &Operation,
    park: &mut P,
) -> Result<Settled<OpReply>, String> {
    Ok(Settled::Done(match operation {
        Operation::List => OpReply::list(&list(host, actor)?),
        Operation::Send(request) => match send(host, actor, request, park).await? {
            Settled::Done(receipt) => OpReply::send(receipt)?,
            Settled::Cancelled => return Ok(Settled::Cancelled),
        },
        Operation::Wait(request) => match wait(host, actor, request, park).await? {
            Settled::Done(outcome) => OpReply::wait(&outcome)?,
            Settled::Cancelled => return Ok(Settled::Cancelled),
        },
        Operation::Cancel { run_id, reason } => {
            OpReply::cancel(&cancel(host, actor, run_id, reason.as_deref())?)
        }
        Operation::ReadResult { run_id } => {
            OpReply::read_result(run_id.trim(), read_result(host, actor, run_id)?.as_ref())
        }
    }))
}

// ── The turn boundary ───────────────────────────────────────────────────

/// Everything accepted for the actor, marked delivered: the Harness projects
/// all of it into the turn it is about to run. Delivered-but-unacknowledged
/// entries come back too, so a failed provider request retries the same
/// semantic delivery at the next boundary instead of losing it.
pub fn take_inbox(
    host: &dyn CoordinationHost,
    actor: Actor<'_>,
) -> Result<Vec<CoordinationEnvelopeSnapshot>, String> {
    let snapshot = host.snapshot(actor.workspace_root)?;
    let inbox = inbox_for(&snapshot, actor.run_id)?;
    for entry in &inbox {
        if entry.delivery_state == CoordinationDeliveryState::Accepted {
            host.apply(
                actor.workspace_root,
                CoordinationCommand::MarkEnvelopeDelivered {
                    run_id: actor.run_id.to_string(),
                    envelope_id: entry.envelope.id.clone(),
                },
            )?;
        }
    }
    Ok(inbox)
}

/// The model has read these: a successful provider request at the boundary,
/// or a wait handing them back.
pub fn acknowledge(
    host: &dyn CoordinationHost,
    actor: Actor<'_>,
    entries: &[CoordinationEnvelopeSnapshot],
) -> Result<(), String> {
    for entry in entries {
        host.apply(
            actor.workspace_root,
            CoordinationCommand::AcknowledgeEnvelope {
                run_id: actor.run_id.to_string(),
                envelope_id: entry.envelope.id.clone(),
            },
        )?;
    }
    Ok(())
}

// ── The one schema source ───────────────────────────────────────────────

/// The five Tools in MCP shape (`name`, `description`, `inputSchema`, and
/// for `agent_send` the bundled `outputSchema`). The Harness registry
/// (agent/tools.rs) rewraps each as a function schema; the MCP server
/// (mcp_server.rs) lists them as they are. One text, two doors.
pub fn tools() -> Vec<Value> {
    let timeout = json!({
        "type": "integer", "minimum": 1, "maximum": MAX_WAIT_SECONDS,
        "description": format!("Maximum wait in seconds. Defaults to {DEFAULT_WAIT_SECONDS}.")
    });
    let tools = vec![
        json!({
            "name": AGENT_LIST,
            "description": "List the agents working on this project right now — Klide Harness Runs and Delegate CLI sessions alike, every Run registered in this Workspace — with each one's Run id, its relation to you (self, parent, child, mission_peer, peer), durable state, whether it is live, its worker kind and a label. Use the runId with agent_send. Runs in other Workspaces are never shown.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": AGENT_SEND,
            "description": "Send a durable instruction, question, answer, progress update, or handoff to another agent by Run id. The recipient's operator reviews it before the agent reads it; delivery happens at the recipient's next safe moment. Set waitForReply to block for the answer to this exact message. deliveryState reports the sent message; replyStatus reports whether this call received a reply or timed out. A timeout does not cancel the message.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "toRunId": { "type": "string", "description": "Exact target Run id from agent_list." },
                    "body": { "type": "string", "description": "The message." },
                    "kind": { "type": "string", "enum": ["instruction", "question", "answer", "progress", "handoff"], "description": "Defaults to instruction, or answer when replyTo is set." },
                    "replyTo": { "type": "string", "description": "Envelope id being answered. A reply is kind answer, one per message; you must be its original recipient and send back to its original sender." },
                    "correlationId": { "type": "string", "description": "Optional stable id grouping a multi-message exchange." },
                    "idempotencyKey": { "type": "string", "description": "Optional retry key. Reusing it with different intent is rejected." },
                    "waitForReply": { "type": "boolean", "description": "When true, wait for a reply to this exact envelope before returning." },
                    "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": MAX_WAIT_SECONDS, "description": format!("Wait ceiling in seconds when waitForReply is true. Defaults to {DEFAULT_WAIT_SECONDS}.") }
                },
                "required": ["toRunId", "body"],
                "additionalProperties": false
            },
            "outputSchema": serde_json::from_str::<Value>(include_str!("../../../schemas/klide-coordination-send-receipt.schema.json"))
                .expect("bundled send receipt schema is valid JSON")
        }),
        json!({
            "name": AGENT_WAIT,
            "description": "Wait for a durable message other agents sent to you — only ones your operator has approved. Optionally narrow to one sender or one reply. Returns after the first matching delivery or the timeout; approved mail that did not match stays waiting for its own delivery. You remain cancellable while waiting.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "fromRunId": { "type": "string", "description": "Only wait for this sender." },
                    "replyTo": { "type": "string", "description": "Only wait for a reply to this envelope id." },
                    "timeoutSeconds": timeout
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": AGENT_CANCEL,
            "description": "Request cancellation of yourself or one of your direct children. The durable request is recorded before any live cancellation is signalled.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "runId": { "type": "string", "description": "Target Run id." },
                    "reason": { "type": "string", "description": "Optional concise cancellation reason." }
                },
                "required": ["runId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": AGENT_READ_RESULT,
            "description": "Read the structured result another agent published, or learn that it has not published one yet.",
            "inputSchema": {
                "type": "object",
                "properties": { "runId": { "type": "string", "description": "Target Run id from agent_list." } },
                "required": ["runId"],
                "additionalProperties": false
            }
        }),
    ];
    debug_assert_eq!(
        tools.iter().map(|tool| tool["name"].as_str().unwrap_or("")).collect::<Vec<_>>(),
        TOOL_NAMES,
        "the schema source and TOOL_NAMES list the same operations in the same order"
    );
    tools
}

/// One of the five by name. Panics on any other name: the callers are the
/// two registries, and a typo there is a build-time mistake.
pub fn tool(name: &str) -> Value {
    tools()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .unwrap_or_else(|| panic!("`{name}` is not a coordination Tool"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::{
        apply_coordination_command, read_snapshot, CoordinationRunRegistration,
        CoordinationStoreState,
    };

    struct StoreHost {
        store: CoordinationStoreState,
        live: Vec<&'static str>,
    }

    impl CoordinationHost for StoreHost {
        fn apply(&self, root: &str, command: CoordinationCommand) -> Result<CoordinationCommandOutcome, String> {
            apply_coordination_command(&self.store, root, command)
        }
        fn snapshot(&self, root: &str) -> Result<CoordinationSnapshot, String> {
            read_snapshot(&self.store, root)
        }
        fn is_live(&self, run_id: &str) -> bool {
            self.live.contains(&run_id)
        }
        fn signal_cancel(&self, run_id: &str) -> bool {
            self.live.contains(&run_id)
        }
    }

    fn sandbox(label: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "klide-coord-ops-{label}-{}-{}",
            std::process::id(),
            crate::agent::transcripts::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        (dir, root)
    }

    fn register(host: &StoreHost, root: &str, run_id: &str) {
        host.apply(
            root,
            CoordinationCommand::RegisterRun {
                registration: CoordinationRunRegistration {
                    run_id: run_id.into(),
                    worker_kind: CoordinationWorkerKind::Harness,
                    parent_run_id: None,
                    mission_id: None,
                    mission_task_id: None,
                    label: None,
                },
                initial_state: Some(CoordinationRunState::Working),
            },
        )
        .unwrap();
    }

    fn accepted_mail(host: &StoreHost, root: &str, from: &str, to: &str, body: &str) -> String {
        let outcome = host
            .apply(
                root,
                CoordinationCommand::SendEnvelope {
                    from: CoordinationActor::Run { run_id: from.into() },
                    to_run_id: to.into(),
                    kind: CoordinationEnvelopeKind::Instruction,
                    body: body.into(),
                    reply_to: None,
                    correlation_id: None,
                    idempotency_key: None,
                    source_refs: vec![],
                },
            )
            .unwrap();
        let id = match outcome.appended.unwrap().event {
            CoordinationEvent::EnvelopeQueued { envelope } => envelope.id,
            other => panic!("{other:?}"),
        };
        host.apply(
            root,
            CoordinationCommand::ReviewEnvelope {
                actor: CoordinationActor::Operator,
                run_id: to.into(),
                envelope_id: id.clone(),
                accept: true,
            },
        )
        .unwrap();
        id
    }

    fn state_of(host: &StoreHost, root: &str, id: &str) -> CoordinationDeliveryState {
        host.snapshot(root)
            .unwrap()
            .envelopes
            .into_iter()
            .find(|e| e.envelope.id == id)
            .unwrap()
            .delivery_state
    }

    /// The delivered rule: a wait marks only what it hands back.
    #[test]
    fn a_wait_marks_delivered_only_the_mail_it_returns() {
        let (dir, root) = sandbox("wait-marks");
        let host = StoreHost { store: CoordinationStoreState::default(), live: vec![] };
        for id in ["me", "a", "b"] {
            register(&host, &root, id);
        }
        let from_a = accepted_mail(&host, &root, "a", "me", "from a");
        let from_b = accepted_mail(&host, &root, "b", "me", "from b");
        let actor = Actor { run_id: "me", workspace_root: &root };
        let mut park = NeverCancelled::new(&host.store, &root);
        let outcome = block_on(wait(
            &host,
            actor,
            &WaitRequest { from_run_id: Some("b".into()), reply_to: None, timeout_seconds: Some(1) },
            &mut park,
        ))
        .unwrap();
        let Settled::Done(WaitOutcome::Delivered(got)) = outcome else { panic!("{outcome:?}") };
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].envelope.id, from_b);
        assert_eq!(state_of(&host, &root, &from_b), CoordinationDeliveryState::Acknowledged);
        assert_eq!(
            state_of(&host, &root, &from_a),
            CoordinationDeliveryState::Accepted,
            "mail the wait did not hand back is untouched"
        );
        // The turn boundary takes everything that is left, and marks it all.
        let inbox = take_inbox(&host, actor).unwrap();
        assert_eq!(inbox.iter().map(|e| e.envelope.id.as_str()).collect::<Vec<_>>(), [from_a.as_str()]);
        assert_eq!(state_of(&host, &root, &from_a), CoordinationDeliveryState::Delivered);
        acknowledge(&host, actor, &inbox).unwrap();
        assert_eq!(state_of(&host, &root, &from_a), CoordinationDeliveryState::Acknowledged);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_wait_with_nothing_matching_times_out_with_the_one_sentence() {
        let (dir, root) = sandbox("wait-timeout");
        let host = StoreHost { store: CoordinationStoreState::default(), live: vec![] };
        register(&host, &root, "me");
        let actor = Actor { run_id: "me", workspace_root: &root };
        let mut park = NeverCancelled::new(&host.store, &root);
        let started = Instant::now();
        let reply = block_on(perform(
            &host,
            actor,
            &Operation::Wait(WaitRequest { timeout_seconds: Some(1), ..Default::default() }),
            &mut park,
        ))
        .unwrap();
        let Settled::Done(reply) = reply else { panic!("{reply:?}") };
        assert_eq!(reply.text, TIMEOUT_TEXT);
        assert_eq!(reply.value["timedOut"], true);
        assert!(started.elapsed() >= Duration::from_secs(1));
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn one_kind_parser_and_one_clamp() {
        assert_eq!(parse_kind(None, true).unwrap(), CoordinationEnvelopeKind::Answer);
        assert_eq!(parse_kind(None, false).unwrap(), CoordinationEnvelopeKind::Instruction);
        assert_eq!(parse_kind(Some(" handoff "), false).unwrap(), CoordinationEnvelopeKind::Handoff);
        assert_eq!(parse_kind(Some(""), true).unwrap(), CoordinationEnvelopeKind::Answer);
        assert!(parse_kind(Some("shout"), false).is_err());
        assert_eq!(clamp_timeout(None), Duration::from_secs(30));
        assert_eq!(clamp_timeout(Some(0)), Duration::from_secs(1));
        assert_eq!(clamp_timeout(Some(900)), Duration::from_secs(120));
    }

    #[test]
    fn a_tool_call_parses_into_one_operation_and_unknown_names_into_none() {
        let send = Operation::from_tool_call(
            AGENT_SEND,
            &json!({ "toRunId": " run_b ", "body": " hi ", "replyTo": "", "waitForReply": true, "timeoutSeconds": 7 }),
        )
        .unwrap();
        assert_eq!(
            send,
            Operation::Send(SendRequest {
                to_run_id: "run_b".into(),
                body: "hi".into(),
                wait_for_reply: true,
                timeout_seconds: Some(7),
                ..Default::default()
            })
        );
        assert!(send.may_block());
        assert!(!Operation::from_tool_call(AGENT_SEND, &json!({})).unwrap().may_block());
        assert!(Operation::from_tool_call(AGENT_WAIT, &json!({})).unwrap().may_block());
        assert_eq!(
            Operation::from_tool_call(AGENT_CANCEL, &json!({ "runId": "x", "reason": " " })),
            Some(Operation::Cancel { run_id: "x".into(), reason: None })
        );
        assert_eq!(Operation::from_tool_call("agent_publish_result", &json!({})), None);
        assert_eq!(Operation::from_tool_call("mission_orchestrate", &json!({})), None);
    }

    #[test]
    fn the_schema_source_names_the_five_in_order() {
        let names: Vec<String> = tools().iter().map(|t| t["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, TOOL_NAMES);
        for tool in tools() {
            assert!(tool["description"].as_str().unwrap().len() > 40);
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
        assert_eq!(tool(AGENT_SEND)["outputSchema"]["title"], "Klide agent_send receipt");
    }
}
