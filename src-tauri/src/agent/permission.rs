//! The Permission engine (CONTEXT.md).
//!
//! One decision path for every command- and network-capability Tool: classify
//! a capability against what's already trusted or already refused, ask the user
//! only when it's genuinely new, emit the request/resolved events, remember the
//! answer at the chosen scope, and persist project-scoped approvals to disk.
//!
//! The two capabilities differ in exactly three places — which run-scoped
//! `HashSet`s they touch, which on-disk allowlist backs the project scope, and
//! the wording shown to the model on refusal. That variation is the `Capability`
//! enum; the policy around it (scope rules, pre-check, the pause ceremony) is
//! shared here. The handlers keep only what is genuinely theirs: parsing the
//! tool call into an invocation, and running the approved command.

use super::tools::{self, NormalizedToolCall, ToolKind};
use super::transcripts::now_ms;
use super::types::{AgentEvent, AgentMode, AgentRunStatus, PermissionRequest, StartRunRequest};
use std::collections::HashSet;
use super::{command_allowlist, network_allowlist};
use super::{pause_for_user, with_run_handle, PauseOutcome, ToolCtx};

/// Which trust namespace a gated Tool draws on. Command-, network- and
/// message-capability tools keep separate run-scoped sets (and, for the first
/// two, separate project allowlists) so trust never bleeds across capability
/// kinds. A message from another agent is keyed by the peer Run it comes from
/// — the receiving side decides who may talk to it — and has no project scope,
/// since a Run id does not outlive the conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capability {
    Command,
    Network,
    Message,
}

/// Where a Run came from. The full-auto rung is a conversation's choice: a
/// Mission attempt or a spawned child takes whatever its request said at start
/// and no live flip reaches it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunLineage {
    Conversation,
    MissionAttempt,
    SubagentChild,
}

/// Why a Tool call is refused before it runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockReason {
    /// The Tool's capability is outside the Run's Mode.
    Mode(ToolKind),
    /// The Tool is turned off for this Run — by a Settings toggle, or by a
    /// caller with no surface to host it (a headless attempt, a child).
    Disabled,
}

/// The facts about a Run that every gate reads: which Mode it is in, which
/// Tools are off, where it came from, and whether its request chose full auto.
/// Built once from the request, so the schemas the model is offered and the
/// dispatch-time check answer from the same place.
#[derive(Clone, Debug)]
pub struct GateSubject {
    pub mode: AgentMode,
    /// Bare Tool names, already narrowed to this Mode.
    pub disabled: HashSet<String>,
    pub lineage: RunLineage,
    pub requested_full_auto: bool,
}

impl GateSubject {
    /// A conversation Run in `mode` with nothing turned off.
    pub fn for_mode(mode: AgentMode) -> Self {
        Self {
            mode,
            disabled: HashSet::new(),
            lineage: RunLineage::Conversation,
            requested_full_auto: false,
        }
    }

    /// Settings store a toggle as `<mode>.<tool>`; headless callers send bare
    /// names. A prefixed entry applies only to its own Mode, a bare one to
    /// every Mode.
    pub fn from_request(request: &StartRunRequest) -> Self {
        let mode_prefix = match request.mode {
            AgentMode::Chat => "chat",
            AgentMode::Plan => "plan",
            AgentMode::Goal => "goal",
        };
        let disabled = request
            .disabled_tools
            .iter()
            .filter_map(|entry| match entry.split_once('.') {
                Some((prefix, name)) if matches!(prefix, "chat" | "plan" | "goal") => {
                    (prefix == mode_prefix).then(|| name.to_string())
                }
                _ => Some(entry.clone()),
            })
            .collect();
        let lineage = if request.parent_id.is_some() {
            RunLineage::SubagentChild
        } else if request.mission_id.is_some() {
            RunLineage::MissionAttempt
        } else {
            RunLineage::Conversation
        };
        Self {
            mode: request.mode.clone(),
            disabled,
            lineage,
            requested_full_auto: request.auto_approve_commands == Some(true),
        }
    }

    /// May this Tool run in this Run at all? `kind` is `None` for a name the
    /// registry does not know; that call goes on to the unknown-tool path.
    pub fn permits(&self, name: &str, kind: Option<ToolKind>) -> Result<(), BlockReason> {
        if self.disabled.contains(name) {
            return Err(BlockReason::Disabled);
        }
        // consult_advisor is side-effect free, so Plan may escalate too.
        if name == tools::ADVISOR_TOOL && self.mode != AgentMode::Chat {
            return Ok(());
        }
        let Some(kind) = kind else { return Ok(()) };
        let mission_ok = name != tools::MISSION_ORCHESTRATE_TOOL || self.mode == AgentMode::Goal;
        if mission_ok && tools::tool_allowed_in_mode(&self.mode, kind) {
            Ok(())
        } else {
            Err(BlockReason::Mode(kind))
        }
    }

    /// Is the run on the full-auto rung right now? `live` is the rung flipped
    /// while the Run works, which only a conversation honors.
    pub fn full_auto(&self, live: Option<bool>) -> bool {
        match (self.lineage, live) {
            (RunLineage::Conversation, Some(live)) => live,
            _ => self.requested_full_auto,
        }
    }

    /// The rung silences commands and nothing else.
    pub fn rung_covers(&self, cap: Capability) -> bool {
        cap == Capability::Command
    }
}

/// Everything the engine remembers about this run's approvals and rejections,
/// across every gated capability — commands, network targets, and rejected
/// edits. One value on the run handle instead of five loose sets, so the
/// "remembers per-run approvals/rejections" half of the engine is testable
/// without a supervisor.
#[derive(Default)]
pub struct TrustMemory {
    /// Commands approved with scope "run"/"project" earlier in this run —
    /// re-running an identical command skips the prompt.
    approved_commands: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Commands rejected this run: proposing the same one again is
    /// auto-declined, not re-asked.
    rejected_commands: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Network targets approved for this run (`web_search`, `host:docs.rs`).
    approved_network: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Network targets rejected this run.
    rejected_network: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Peer Runs whose messages this run's user lets in for the rest of the run.
    approved_messages: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Peer Runs whose messages this run's user refused; later ones are
    /// declined without a card.
    rejected_messages: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Edit proposals rejected this run, keyed `<path>::<new_hash>`. Write has
    /// no approved set: a write approval is the diff decision itself and is
    /// never remembered across proposals — only a rejection sticks, so one
    /// "Reject" stops the byte-identical re-proposal.
    rejected_edits: std::sync::Mutex<std::collections::HashSet<String>>,
    /// "Validate all" from the diff card: every later edit this run applies
    /// without pausing — the mid-run counterpart of starting the run with
    /// `require_diff_review: false`. One-way for the run's life; the surface
    /// flips its rung alongside so later turns arrive already auto-accepting.
    edits_auto_apply: std::sync::atomic::AtomicBool,
    /// The command half of the Goal policy, changed while this run is live.
    /// `None` keeps what the run request said; `Some(true)` is the full-auto
    /// rung chosen mid-run, `Some(false)` is stepping back down from it. The
    /// rung is per conversation, and a conversation's live Run is part of it —
    /// so a flip reaches the Run that is asking, not only the next one.
    commands_policy: std::sync::Mutex<Option<bool>>,
    /// Which capability the stashed permission sender is waiting on, while a
    /// card is up. A policy change answers the card it silences (a command)
    /// and leaves every other card standing — a dispatch, a network target, a
    /// peer's message are never swept up by the command rung.
    pending_permission_capability: std::sync::Mutex<Option<Capability>>,
}

impl TrustMemory {
    /// The live override of the run request's `auto_approve_commands`.
    pub fn commands_policy(&self) -> Option<bool> {
        *self.commands_policy.lock().unwrap()
    }

    pub fn set_commands_policy(&self, auto_approve: bool) {
        *self.commands_policy.lock().unwrap() = Some(auto_approve);
    }

    /// Record (or clear) what the pending permission card is about.
    pub fn note_pending_capability(&self, cap: Option<Capability>) {
        *self.pending_permission_capability.lock().unwrap() = cap;
    }

    pub fn pending_capability(&self) -> Option<Capability> {
        *self.pending_permission_capability.lock().unwrap()
    }

    pub fn approved(&self, cap: Capability, key: &str) -> bool {
        match cap {
            Capability::Command => self.approved_commands.lock().unwrap().contains(key),
            Capability::Network => self.approved_network.lock().unwrap().contains(key),
            Capability::Message => self.approved_messages.lock().unwrap().contains(key),
        }
    }

    pub fn rejected(&self, cap: Capability, key: &str) -> bool {
        match cap {
            Capability::Command => self.rejected_commands.lock().unwrap().contains(key),
            Capability::Network => self.rejected_network.lock().unwrap().contains(key),
            Capability::Message => self.rejected_messages.lock().unwrap().contains(key),
        }
    }

    pub fn remember_approved(&self, cap: Capability, key: &str) {
        let set = match cap {
            Capability::Command => &self.approved_commands,
            Capability::Network => &self.approved_network,
            Capability::Message => &self.approved_messages,
        };
        set.lock().unwrap().insert(key.to_string());
    }

    pub fn remember_rejected(&self, cap: Capability, key: &str) {
        let set = match cap {
            Capability::Command => &self.rejected_commands,
            Capability::Network => &self.rejected_network,
            Capability::Message => &self.rejected_messages,
        };
        set.lock().unwrap().insert(key.to_string());
    }

    pub fn write_rejected(&self, edit_key: &str) -> bool {
        self.rejected_edits.lock().unwrap().contains(edit_key)
    }

    pub fn remember_write_rejection(&self, edit_key: &str) {
        self.rejected_edits
            .lock()
            .unwrap()
            .insert(edit_key.to_string());
    }

    pub fn edits_auto_applied(&self) -> bool {
        self.edits_auto_apply
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn remember_edits_auto_apply(&self) {
        self.edits_auto_apply
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Was this exact edit (path + resulting content hash) already rejected this
/// run? The Write capability's rejection memory lives in the engine like the
/// other capabilities'; the diff ceremony itself stays with the Write handler.
pub fn write_already_rejected(ctx: &ToolCtx<'_>, edit_key: &str) -> bool {
    with_run_handle(ctx.sup, ctx.id, |h| h.trust.write_rejected(edit_key)).unwrap_or(false)
}

pub fn remember_write_rejection(ctx: &ToolCtx<'_>, edit_key: &str) {
    with_run_handle(ctx.sup, ctx.id, |h| {
        h.trust.remember_write_rejection(edit_key)
    });
}

/// Has "Validate all" been chosen earlier in this run? Later edits then apply
/// without pausing, exactly as if the run had started with review off.
/// Whether this Run is on the full-auto rung right now — the live flip when
/// its lineage lets one count, else the request's own choice.
pub fn full_auto(ctx: &ToolCtx<'_>) -> bool {
    with_run_handle(ctx.sup, ctx.id, |h| h.subject.full_auto(h.trust.commands_policy()))
        .unwrap_or(ctx.request.auto_approve_commands == Some(true))
}

pub fn edits_auto_applied(ctx: &ToolCtx<'_>) -> bool {
    with_run_handle(ctx.sup, ctx.id, |h| h.trust.edits_auto_applied()).unwrap_or(false)
}

pub fn remember_edits_auto_apply(ctx: &ToolCtx<'_>) {
    with_run_handle(ctx.sup, ctx.id, |h| h.trust.remember_edits_auto_apply());
}

/// The decision a command card receives when the rung silences it, so the
/// transcript says the policy answered, not the user.
pub const FULL_AUTO_DECISION: &str = "{\"behavior\":\"allow\",\"scope\":\"once\",\"via\":\"full_auto\"}";

/// Apply a rung flip to a live run: remember the command policy, and when it
/// is full auto and a *command* card is up, answer that card. Returns whether
/// a card was answered. Any other pending card — a dispatch, a network target,
/// a peer's message — is left for the user, as the full-auto rung excludes
/// them by design. Refused for a Mission attempt or a spawned child: the rung
/// is a conversation's, and theirs was fixed by the request that started them.
pub fn apply_command_policy(
    handle: &super::AgentRunHandle,
    auto_approve: bool,
) -> Result<bool, String> {
    if handle.subject.lineage != RunLineage::Conversation {
        return Err(format!(
            "The command policy belongs to a conversation; this Run is a {:?}.",
            handle.subject.lineage
        ));
    }
    handle.trust.set_commands_policy(auto_approve);
    if !auto_approve || handle.trust.pending_capability() != Some(Capability::Command) {
        return Ok(false);
    }
    let sender = handle.pending_permission.lock().unwrap().take();
    Ok(match sender {
        Some(tx) => {
            handle.trust.note_pending_capability(None);
            tx.send(FULL_AUTO_DECISION.to_string()).is_ok()
        }
        None => false,
    })
}

/// How long an approved command lives. A background shell outlasts the turn
/// and a watch outlasts the run, so neither is the same approval as the
/// foreground command it spells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandShape {
    Foreground,
    Background,
    Watch,
}

/// What a command approval is for: the command, where it runs, and its shape.
/// A foreground key reads `cwd :: command` (just `command` at the Workspace
/// root) — the spelling the project allowlist stores. The other shapes add a
/// suffix, so a foreground approval never covers them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandKey {
    cwd: Option<String>,
    command: String,
    pub shape: CommandShape,
}

impl CommandKey {
    pub fn new(root: &str, cwd: &str, command: &str, shape: CommandShape) -> Self {
        Self {
            cwd: (cwd != root).then(|| cwd.to_string()),
            command: command.to_string(),
            shape,
        }
    }

    /// The key without its shape: what the project allowlist matches on.
    pub fn foreground_key(&self) -> String {
        match &self.cwd {
            Some(cwd) => format!("{cwd} :: {}", self.command),
            None => self.command.clone(),
        }
    }
}

impl std::fmt::Display for CommandKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let base = self.foreground_key();
        match self.shape {
            CommandShape::Foreground => write!(f, "{base}"),
            CommandShape::Background => write!(f, "{base} [background]"),
            CommandShape::Watch => write!(f, "{base} [watch]"),
        }
    }
}

/// Why a gated call may run without asking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trusted {
    /// Approved for this run earlier.
    Run,
    /// The project allowlist covers it.
    Project,
    /// The full-auto rung silences it.
    FullAuto,
}

/// What the pre-check concluded before any prompt is shown.
pub enum Precheck {
    Execute(Trusted),
    /// Already refused this run. Return this canned message to the model so it
    /// changes course, and never re-ask for the same key.
    AutoReject(&'static str),
    /// Genuinely new. Ask the user.
    Ask,
}

/// The user's answer to a gate prompt, normalized out of the decision JSON.
pub enum GateDecision {
    Approved {
        scope: String,
        /// The allowlist pattern the user chose, if they widened it (command
        /// capability only). Falls back to the literal key when absent.
        pattern: Option<String>,
    },
    Rejected,
    /// The user cancelled the whole run while the prompt was up.
    Cancelled,
}

impl Capability {
    /// Persist a project-scoped approval to the on-disk allowlist. `persist`
    /// is the value to store (a command string, or a network target); for the
    /// command capability the user may have widened it to a wildcard `pattern`.
    fn persist_project(
        &self,
        runs_dir: &std::path::Path,
        root: &str,
        persist: &str,
        pattern: Option<&str>,
    ) {
        let result = match self {
            Capability::Command => {
                let pattern = pattern.unwrap_or(persist);
                if pattern.contains('*') || pattern.contains('?') {
                    command_allowlist::add_rule(runs_dir, root, pattern)
                } else {
                    command_allowlist::add(runs_dir, root, pattern)
                }
            }
            Capability::Network => network_allowlist::add(runs_dir, root, persist),
            // A peer Run id names one conversation; nothing durable to add to.
            Capability::Message => return,
        };
        if let Err(err) = result {
            eprintln!("failed to persist project {} allowlist: {err}", self.noun());
        }
    }

    fn noun(&self) -> &'static str {
        match self {
            Capability::Command => "command",
            Capability::Network => "network",
            Capability::Message => "message",
        }
    }

    /// Shown to the model when an identical key was already refused this run.
    fn already_refused(&self) -> &'static str {
        match self {
            Capability::Command => {
                "You already proposed this exact command and the user rejected it. \
Do not run it again — take a different approach or ask the user what they'd prefer."
            }
            Capability::Network => {
                "You already proposed this exact network target and the user rejected it. \
Do not use it again — take a different approach or ask the user what they'd prefer."
            }
            // The receiving side's review never reaches the model: a declined
            // message is simply not delivered. Kept for the engine's shape.
            Capability::Message => "Messages from this agent were refused for this run.",
        }
    }

    /// Shown to the model when the user rejects this fresh prompt.
    pub fn rejected_message(&self) -> &'static str {
        match self {
            Capability::Command => {
                "Rejected by user: command not run. Do not propose this exact \
command again — take a different approach or ask the user what they'd prefer."
            }
            Capability::Network => {
                "Rejected by user: network request not run. Do not propose this exact \
network target again — take a different approach or ask the user what they'd prefer."
            }
            Capability::Message => "Rejected by user: message from this agent not delivered.",
        }
    }
}

/// The id that ties a `PermissionRequested` event to its `PermissionResolved`
/// twin. Deterministic from the run + tool call so the request JSON's `id` and
/// the resolved event always agree.
pub fn request_id(ctx: &ToolCtx<'_>, call: &NormalizedToolCall) -> String {
    format!("perm_{}_{}", ctx.id, call.id)
}

/// Classify a capability before prompting. `run_key` is the run-scoped trust
/// key; `project_ok` is the caller's project-allowlist verdict (kept in the
/// handler because the command capability's wildcard/external-path nuance is
/// command-specific). The full-auto rung is read here, off the Run's subject,
/// and outranks a remembered rejection — escalating is the override. Falls
/// back to `Ask` whenever the run handle is missing.
pub fn precheck(ctx: &ToolCtx<'_>, cap: Capability, run_key: &str, project_ok: bool) -> Precheck {
    let (run_ok, run_no, full_auto) = with_run_handle(ctx.sup, ctx.id, |h| {
        (
            h.trust.approved(cap, run_key),
            h.trust.rejected(cap, run_key),
            h.subject.rung_covers(cap) && h.subject.full_auto(h.trust.commands_policy()),
        )
    })
    .unwrap_or((false, false, false));

    if run_ok {
        Precheck::Execute(Trusted::Run)
    } else if project_ok {
        Precheck::Execute(Trusted::Project)
    } else if full_auto {
        Precheck::Execute(Trusted::FullAuto)
    } else if run_no {
        Precheck::AutoReject(cap.already_refused())
    } else {
        Precheck::Ask
    }
}

/// The rung answered this card before it went up. Record the same pair a flip
/// under an open card records, so the transcript tells full auto from an
/// allowlist hit.
pub fn record_full_auto<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    request: PermissionRequest,
    emit: &mut E,
) -> Result<(), String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    emit(AgentEvent::PermissionRequested {
        run_id: ctx.id.to_string(),
        request,
        ts: now_ms(),
    })?;
    emit(AgentEvent::PermissionResolved {
        run_id: ctx.id.to_string(),
        request_id: request_id(ctx, call),
        decision: serde_json::from_str(FULL_AUTO_DECISION).expect("a JSON literal"),
        ts: now_ms(),
    })
}

/// The pause ceremony: flip to waiting, stash the permission oneshot, emit the
/// request, await the decision (or cancellation), emit the resolved event, and
/// hand back the normalized verdict. Identical for every capability — only the
/// `request` JSON the caller built differs. `cap` names what the card is about
/// (`None` for a gate outside the capability namespaces, like a dispatch), so a
/// rung flipped while the card is up knows whether it may answer it.
pub async fn run_gate<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    cap: Option<Capability>,
    request: PermissionRequest,
    emit: &mut E,
) -> Result<GateDecision, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let outcome = pause_for_user(
        ctx.sup,
        ctx.id,
        AgentRunStatus::WaitingForPermission,
        AgentEvent::PermissionRequested {
            run_id: ctx.id.to_string(),
            request,
            ts: now_ms(),
        },
        "{\"behavior\":\"deny\"}",
        ctx.cancel,
        emit,
        |handle, tx| {
            handle.trust.note_pending_capability(cap);
            *handle.pending_permission.lock().unwrap() = Some(tx);
        },
    )
    .await;
    // The card is down whichever way the pause ended.
    with_run_handle(ctx.sup, ctx.id, |h| h.trust.note_pending_capability(None));
    let decision = match outcome? {
        PauseOutcome::Cancelled => return Ok(GateDecision::Cancelled),
        PauseOutcome::Resolved(decision) => decision,
    };

    let decision_val: serde_json::Value =
        serde_json::from_str(&decision).unwrap_or(serde_json::json!({ "behavior": "deny" }));
    let allowed = decision_val.get("behavior").and_then(|b| b.as_str()) == Some("allow");
    let scope = decision_val
        .get("scope")
        .and_then(|s| s.as_str())
        .unwrap_or("once")
        .to_string();

    emit(AgentEvent::PermissionResolved {
        run_id: ctx.id.to_string(),
        request_id: request_id(ctx, call),
        decision: decision_val.clone(),
        ts: now_ms(),
    })?;

    Ok(if allowed {
        GateDecision::Approved {
            scope,
            pattern: decision_val
                .get("pattern")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        }
    } else {
        GateDecision::Rejected
    })
}

/// Remember a gate decision. `run_key` is what the run-scoped sets and pre-check
/// match on; `persist` is what a project-scoped approval writes to disk (they
/// differ for commands: the run key may carry a cwd prefix, the persisted value
/// is the bare command). `None` keeps a project-scoped answer to this run — the
/// project allowlist is a foreground contract, so a background command is
/// never written to it. A `Cancelled` decision records nothing.
pub fn record(
    ctx: &ToolCtx<'_>,
    cap: Capability,
    run_key: &str,
    persist: Option<&str>,
    decision: &GateDecision,
) {
    match decision {
        GateDecision::Approved { scope, pattern } => {
            if scope == "run" || scope == "project" {
                with_run_handle(ctx.sup, ctx.id, |h| h.trust.remember_approved(cap, run_key));
            }
            if scope == "project" {
                if let (Some(root), Some(persist)) = (ctx.request.workspace_root.as_deref(), persist) {
                    cap.persist_project(ctx.runs_dir, root, persist, pattern.as_deref());
                }
            }
        }
        GateDecision::Rejected => {
            with_run_handle(ctx.sup, ctx.id, |h| h.trust.remember_rejected(cap, run_key));
        }
        GateDecision::Cancelled => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn temp_workspace(name: &str) -> (String, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("klide-permission-{name}-{}", std::process::id()));
        let runs_dir = std::env::temp_dir().join(format!(
            "klide-permission-runs-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&runs_dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&runs_dir).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.name=Klide",
                "-c",
                "user.email=test@klide.local",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ])
            .current_dir(&dir)
            .status()
            .unwrap();
        (dir.to_string_lossy().to_string(), runs_dir)
    }

    #[test]
    fn command_project_persist_routes_exact_vs_wildcard() {
        let (root, runs_dir) = temp_workspace("cmd-persist");
        // An exact command lands in the `commands` list verbatim.
        Capability::Command.persist_project(&runs_dir, &root, "cargo test", None);
        // A widened pattern lands as a wildcard rule, matching a family.
        Capability::Command.persist_project(&runs_dir, &root, "cargo build", Some("cargo *"));

        let stored = command_allowlist::list(&runs_dir, &root).unwrap();
        assert!(stored.contains(&"cargo test".to_string()));
        assert!(stored.contains(&"cargo *".to_string()));
        let matched = command_allowlist::match_rule(&stored, "cargo run", "cargo run")
            .expect("wildcard covers the family");
        assert_eq!(matched.pattern, "cargo *");
        assert!(!matched.exact);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }

    #[test]
    fn network_project_persist_writes_the_target() {
        let (root, runs_dir) = temp_workspace("net-persist");
        Capability::Network.persist_project(&runs_dir, &root, "host:docs.rs", None);
        assert!(network_allowlist::is_allowed(&runs_dir, &root, "host:docs.rs").unwrap());
        assert!(!network_allowlist::is_allowed(&runs_dir, &root, "host:example.com").unwrap());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(runs_dir);
    }

    #[test]
    fn trust_memory_keeps_capabilities_separate() {
        let trust = TrustMemory::default();
        trust.remember_approved(Capability::Command, "cargo test");
        trust.remember_rejected(Capability::Network, "host:evil.example");

        assert!(trust.approved(Capability::Command, "cargo test"));
        // Trust never bleeds across capability kinds: the same key in the
        // other namespace stays unknown.
        assert!(!trust.approved(Capability::Network, "cargo test"));
        assert!(trust.rejected(Capability::Network, "host:evil.example"));
        assert!(!trust.rejected(Capability::Command, "host:evil.example"));
        assert!(!trust.approved(Capability::Command, "cargo build"));
    }

    #[test]
    fn trust_memory_write_rejection_sticks_and_stays_its_own_namespace() {
        let trust = TrustMemory::default();
        assert!(!trust.write_rejected("src/a.rs::abc123"));
        trust.remember_write_rejection("src/a.rs::abc123");
        assert!(trust.write_rejected("src/a.rs::abc123"));
        // A revised edit hashes differently and prompts normally.
        assert!(!trust.write_rejected("src/a.rs::def456"));
        // Edit keys never read as commands or network targets.
        assert!(!trust.rejected(Capability::Command, "src/a.rs::abc123"));
        assert!(!trust.rejected(Capability::Network, "src/a.rs::abc123"));
    }

    fn subject_request(mode: &str, disabled: &[&str]) -> StartRunRequest {
        let mut request = super::super::test_support::test_request("/workspace", &[]);
        request.mode = serde_json::from_value(serde_json::json!(mode)).unwrap();
        request.disabled_tools = disabled.iter().map(|d| d.to_string()).collect();
        request
    }

    #[test]
    fn a_mode_prefixed_toggle_applies_only_to_its_own_mode() {
        let toggles = ["goal.write_file", "plan.grep", "web_fetch"];
        let goal = GateSubject::from_request(&subject_request("goal", &toggles));
        assert_eq!(
            goal.disabled,
            HashSet::from(["write_file".to_string(), "web_fetch".to_string()])
        );
        let plan = GateSubject::from_request(&subject_request("plan", &toggles));
        assert_eq!(
            plan.disabled,
            HashSet::from(["grep".to_string(), "web_fetch".to_string()])
        );
    }

    #[test]
    fn permits_refuses_a_disabled_tool_and_an_out_of_mode_one() {
        let goal = GateSubject::from_request(&subject_request("goal", &["spawn_subagent"]));
        assert_eq!(
            goal.permits("spawn_subagent", Some(ToolKind::Pause)),
            Err(BlockReason::Disabled)
        );
        assert_eq!(goal.permits("run_command", Some(ToolKind::Command)), Ok(()));
        let plan = GateSubject::for_mode(AgentMode::Plan);
        assert_eq!(
            plan.permits("run_command", Some(ToolKind::Command)),
            Err(BlockReason::Mode(ToolKind::Command))
        );
        assert_eq!(plan.permits(tools::ADVISOR_TOOL, Some(ToolKind::Pause)), Ok(()));
        assert!(plan
            .permits(tools::MISSION_ORCHESTRATE_TOOL, Some(ToolKind::Coordination))
            .is_err());
        assert_eq!(plan.permits("made_up", None), Ok(()));
    }

    #[test]
    fn lineage_decides_whether_a_live_flip_counts() {
        let conversation = GateSubject::from_request(&subject_request("goal", &[]));
        assert_eq!(conversation.lineage, RunLineage::Conversation);
        assert!(conversation.full_auto(Some(true)));
        assert!(!conversation.full_auto(None));

        let mut child_request = subject_request("goal", &[]);
        child_request.parent_id = Some("parent".into());
        child_request.auto_approve_commands = Some(true);
        let child = GateSubject::from_request(&child_request);
        assert_eq!(child.lineage, RunLineage::SubagentChild);
        assert!(child.full_auto(Some(false)), "the request's own choice stands");

        let mut attempt_request = subject_request("goal", &[]);
        attempt_request.mission_id = Some("mission".into());
        let attempt = GateSubject::from_request(&attempt_request);
        assert_eq!(attempt.lineage, RunLineage::MissionAttempt);
        assert!(!attempt.full_auto(Some(true)), "no flip reaches a Mission attempt");
    }

    #[test]
    fn the_rung_covers_commands_only() {
        let subject = GateSubject::for_mode(AgentMode::Goal);
        assert!(subject.rung_covers(Capability::Command));
        assert!(!subject.rung_covers(Capability::Network));
        assert!(!subject.rung_covers(Capability::Message));
    }

    #[test]
    fn refusal_wording_is_capability_specific() {
        assert!(Capability::Command
            .rejected_message()
            .contains("command not run"));
        assert!(Capability::Network
            .rejected_message()
            .contains("network request not run"));
        assert!(Capability::Command
            .already_refused()
            .contains("exact command"));
        assert!(Capability::Network
            .already_refused()
            .contains("exact network target"));
    }
}
