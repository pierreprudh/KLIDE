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

use super::tools::NormalizedToolCall;
use super::transcripts::now_ms;
use super::types::{AgentEvent, AgentRunStatus};
use super::{command_allowlist, network_allowlist};
use super::{pause_for_user, with_run_handle, AgentRunHandle, PauseOutcome, ToolCtx};

/// Which trust namespace a gated Tool draws on. Command- and network-capability
/// tools keep separate run-scoped sets and separate project allowlists so trust
/// never bleeds across capability kinds.
#[derive(Clone, Copy)]
pub enum Capability {
    Command,
    Network,
}

/// What the pre-check concluded before any prompt is shown.
pub enum Precheck {
    /// Already trusted — a run-scoped approval or the project allowlist covers
    /// it. Run it without asking.
    Execute,
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
    fn run_approved(&self, h: &AgentRunHandle, key: &str) -> bool {
        match self {
            Capability::Command => h.approved_commands.lock().unwrap().contains(key),
            Capability::Network => h.approved_network.lock().unwrap().contains(key),
        }
    }

    fn run_rejected(&self, h: &AgentRunHandle, key: &str) -> bool {
        match self {
            Capability::Command => h.rejected_commands.lock().unwrap().contains(key),
            Capability::Network => h.rejected_network.lock().unwrap().contains(key),
        }
    }

    fn remember_approved(&self, h: &AgentRunHandle, key: &str) {
        match self {
            Capability::Command => {
                h.approved_commands.lock().unwrap().insert(key.to_string());
            }
            Capability::Network => {
                h.approved_network.lock().unwrap().insert(key.to_string());
            }
        }
    }

    fn remember_rejected(&self, h: &AgentRunHandle, key: &str) {
        match self {
            Capability::Command => {
                h.rejected_commands.lock().unwrap().insert(key.to_string());
            }
            Capability::Network => {
                h.rejected_network.lock().unwrap().insert(key.to_string());
            }
        }
    }

    /// Persist a project-scoped approval to the on-disk allowlist. `persist`
    /// is the value to store (a command string, or a network target); for the
    /// command capability the user may have widened it to a wildcard `pattern`.
    fn persist_project(&self, root: &str, persist: &str, pattern: Option<&str>) {
        let result = match self {
            Capability::Command => {
                let pattern = pattern.unwrap_or(persist);
                if pattern.contains('*') || pattern.contains('?') {
                    command_allowlist::add_rule(root, pattern)
                } else {
                    command_allowlist::add(root, pattern)
                }
            }
            Capability::Network => network_allowlist::add(root, persist),
        };
        if let Err(err) = result {
            eprintln!("failed to persist project {} allowlist: {err}", self.noun());
        }
    }

    fn noun(&self) -> &'static str {
        match self {
            Capability::Command => "command",
            Capability::Network => "network",
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
/// command-specific). Falls back to `Ask` whenever the run handle is missing.
pub fn precheck(ctx: &ToolCtx<'_>, cap: Capability, run_key: &str, project_ok: bool) -> Precheck {
    let (run_ok, run_no) = with_run_handle(ctx.app, ctx.id, |h| {
        (cap.run_approved(h, run_key), cap.run_rejected(h, run_key))
    })
    .unwrap_or((false, false));

    if run_ok || project_ok {
        Precheck::Execute
    } else if run_no {
        Precheck::AutoReject(cap.already_refused())
    } else {
        Precheck::Ask
    }
}

/// The pause ceremony: flip to waiting, stash the permission oneshot, emit the
/// request, await the decision (or cancellation), emit the resolved event, and
/// hand back the normalized verdict. Identical for both capabilities — only the
/// `request` JSON the caller built differs.
pub async fn run_gate<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    request: serde_json::Value,
    emit: &mut E,
) -> Result<GateDecision, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let decision = match pause_for_user(
        ctx.app,
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
            *handle.pending_permission.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
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
/// is the bare command). A `Cancelled` decision records nothing.
pub fn record(
    ctx: &ToolCtx<'_>,
    cap: Capability,
    run_key: &str,
    persist: &str,
    decision: &GateDecision,
) {
    match decision {
        GateDecision::Approved { scope, pattern } => {
            if scope == "run" || scope == "project" {
                with_run_handle(ctx.app, ctx.id, |h| cap.remember_approved(h, run_key));
            }
            if scope == "project" {
                if let Some(root) = ctx.request.workspace_root.as_deref() {
                    cap.persist_project(root, persist, pattern.as_deref());
                }
            }
        }
        GateDecision::Rejected => {
            with_run_handle(ctx.app, ctx.id, |h| cap.remember_rejected(h, run_key));
        }
        GateDecision::Cancelled => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> String {
        let dir =
            std::env::temp_dir().join(format!("klide-permission-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn command_project_persist_routes_exact_vs_wildcard() {
        let root = temp_workspace("cmd-persist");
        // An exact command lands in the `commands` list verbatim.
        Capability::Command.persist_project(&root, "cargo test", None);
        // A widened pattern lands as a wildcard rule, matching a family.
        Capability::Command.persist_project(&root, "cargo build", Some("cargo *"));

        let stored = command_allowlist::list(&root).unwrap();
        assert!(stored.contains(&"cargo test".to_string()));
        assert!(stored.contains(&"cargo *".to_string()));
        let matched = command_allowlist::match_rule(&stored, "cargo run", "cargo run")
            .expect("wildcard covers the family");
        assert_eq!(matched.pattern, "cargo *");
        assert!(!matched.exact);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn network_project_persist_writes_the_target() {
        let root = temp_workspace("net-persist");
        Capability::Network.persist_project(&root, "host:docs.rs", None);
        assert!(network_allowlist::is_allowed(&root, "host:docs.rs").unwrap());
        assert!(!network_allowlist::is_allowed(&root, "host:example.com").unwrap());
        let _ = std::fs::remove_dir_all(root);
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
