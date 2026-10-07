//! A Delegate's permission prompt, answered in Klide.
//!
//! A headless Claude Code turn has no terminal to ask in, so until now any
//! call its own permission layer did not pre-approve was simply refused —
//! `gh pr list` came back "This command requires approval" and the turn moved
//! on without it. The one thing that reaches the operator per call is Claude
//! Code's `--permission-prompt-tool`: it names an MCP tool, and every prompt
//! becomes a call to that tool with `{tool_name, input, tool_use_id}` whose
//! single text block must read `{"behavior":"allow"|"deny",…}` back.
//!
//! Klide already runs an MCP server inside every Delegate session
//! (`klide mcp coordination`), so the prompt tool is one more tool on it.
//! The MCP child relays the call over loopback to the bridge, the bridge
//! binds the Run from the session (never from a request field), and this
//! module raises **the same card the Harness shows for its own
//! `run_command`** — same `PermissionRequested` event, same `pending_permission`
//! slot, same `agent_resolve_permission` answer, same scopes. "For this
//! project" writes the project command allowlist, which the next headless turn
//! carries as `--allowedTools`, so a project that only ever used Delegates
//! finally builds one.
//!
//! What is deliberately *not* here: the Harness does not run the command — the
//! CLI does, under its own sandbox, once told yes. Klide answers the question;
//! it does not take over the loop.
//!
//! The run loop cannot be asked from outside — its event writer (sequence,
//! transcript, broadcast) is a closure local to the loop. So while a Delegate
//! turn is in flight the loop installs an [`OutOfBandPort`] on the Run's handle:
//! the same sequence counter, the same channel, the same runs dir. A gate
//! raised here writes exactly what the loop would have written.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::ipc::Channel;

use super::permission::{Capability, FULL_AUTO_DECISION};
use super::transcripts::now_ms;
use super::types::{AgentEvent, PermissionRequest};
use super::{AgentRunStatus, RunSupervisor};

/// The MCP tool's name on Klide's server. Claude Code addresses it as
/// `mcp__klide__permission`.
pub const TOOL: &str = "permission";

/// One prompt Claude Code raised: what it wants to call and with what.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegatePermissionAsk {
    pub tool_name: String,
    pub input: Value,
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

/// How a gate raised outside the run loop writes to the Run as the loop would:
/// the loop's own sequence counter (shared with its stream log, so indices
/// never collide), its event channel, and the runs dir its transcript lives in.
/// Installed by the loop for the span of a Delegate turn, removed after.
pub struct OutOfBandPort {
    pub sequence: Arc<Mutex<u64>>,
    pub on_event: Channel<AgentEvent>,
    pub runs_dir: PathBuf,
}

impl OutOfBandPort {
    /// Append, broadcast, advance — the loop's `emit`, verbatim in order.
    fn emit(&self, sup: &dyn RunSupervisor, run_id: &str, event: AgentEvent) -> Result<(), String> {
        let mut seq = self.sequence.lock().map_err(|_| "Transcript sequence unavailable")?;
        super::transcripts::append_event(&self.runs_dir, run_id, *seq, &event)?;
        sup.broadcast(run_id, *seq, &event);
        *seq += 1;
        let _ = self.on_event.send(event);
        Ok(())
    }
}

/// The answer Claude Code reads, as the text of one block.
fn allow(input: &Value) -> Value {
    json!({ "text": json!({ "behavior": "allow", "updatedInput": input }).to_string() })
}

fn deny(message: &str) -> Value {
    json!({ "text": json!({ "behavior": "deny", "message": message }).to_string() })
}

/// What the Run's handle already knows before any card goes up.
#[derive(Debug, PartialEq, Eq)]
enum Standing {
    /// The full-auto rung covers commands: answered by policy, recorded as such.
    FullAuto,
    /// Approved for this run earlier (an identical command).
    Approved,
    /// Rejected earlier this run; not asked again.
    Rejected,
    Ask,
}

/// Answer one prompt for the Run bound to the calling session. Blocks the
/// calling (bridge) thread until the operator answers, the run stops, or the
/// handle already knows. Returns the bridge value whose `text` is the JSON
/// Claude Code expects.
pub(crate) fn answer(
    sup: &dyn RunSupervisor,
    run_id: &str,
    workspace_root: &str,
    ask: DelegatePermissionAsk,
) -> Result<Value, String> {
    // Only a shell command has a Klide capability and a project store behind
    // it. Any other prompt (a file outside the workspace, a web fetch) is put
    // to the operator as a plain question with no "for this project".
    let command = (ask.tool_name == "Bash")
        .then(|| ask.input.get("command").and_then(Value::as_str))
        .flatten()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    let cap = command.as_ref().map(|_| Capability::Command);

    let mut port: Option<OutOfBandPort> = None;
    let mut standing = Standing::Ask;
    let found = sup.with_handle(run_id, &mut |h| {
        port = h.out_of_band.lock().ok().and_then(|p| {
            p.as_ref().map(|p| OutOfBandPort {
                sequence: p.sequence.clone(),
                on_event: p.on_event.clone(),
                runs_dir: p.runs_dir.clone(),
            })
        });
        if let Some(cmd) = command.as_deref() {
            standing = if h.subject.full_auto(h.trust.commands_policy()) && h.subject.rung_covers(Capability::Command) {
                Standing::FullAuto
            } else if h.trust.approved(Capability::Command, cmd) {
                Standing::Approved
            } else if h.trust.rejected(Capability::Command, cmd) {
                Standing::Rejected
            } else {
                Standing::Ask
            };
        }
    });
    if !found {
        return Ok(deny("Klide has no live Run for this session, so nobody can answer."));
    }
    let Some(port) = port else {
        // A session the Harness is not turning right now (a Workbench TUI
        // panel, say): the CLI's own prompt is the one to answer.
        return Ok(deny("Klide is not driving this turn; answer the prompt in the CLI."));
    };
    let ts = now_ms();
    let request_id = format!(
        "perm_{run_id}_{}",
        ask.tool_use_id.clone().filter(|id| !id.is_empty()).unwrap_or_else(|| format!("delegate-{ts}"))
    );

    match standing {
        Standing::Approved => return Ok(allow(&ask.input)),
        Standing::Rejected => return Ok(deny("The user rejected this command earlier in this run.")),
        Standing::FullAuto => {
            // Same pair the Harness writes when the rung answers before a card.
            let request = card(run_id, &request_id, workspace_root, &ask, command.as_deref());
            port.emit(sup, run_id, AgentEvent::PermissionRequested { run_id: run_id.to_string(), request, ts })?;
            let decision: Value = serde_json::from_str(FULL_AUTO_DECISION).unwrap_or(Value::Null);
            port.emit(sup, run_id, AgentEvent::PermissionResolved { run_id: run_id.to_string(), request_id, decision, ts: now_ms() })?;
            return Ok(allow(&ask.input));
        }
        Standing::Ask => {}
    }
    // The project allowlist, read now rather than from the turn's
    // `--allowedTools`: a rule approved a moment ago on this very card holds
    // for the rest of the turn, and a pattern the flag could not carry still counts.
    if let Some(cmd) = command.as_deref() {
        if let Ok(rules) = super::command_allowlist::list(&port.runs_dir, workspace_root) {
            if super::command_allowlist::match_rule(&rules, cmd, cmd).is_some() {
                return Ok(allow(&ask.input));
            }
        }
    }

    // The card. Sender in place before the event, so a fast answer cannot
    // race past it — the order `pause_for_user` keeps.
    let request = card(run_id, &request_id, workspace_root, &ask, command.as_deref());
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let mut tx = Some(tx);
    sup.with_handle(run_id, &mut |h| {
        if let Some(tx) = tx.take() {
            if let Ok(mut slot) = h.pending_permission.lock() {
                *slot = Some(tx);
            }
            h.trust.note_pending_capability(cap);
        }
    });
    sup.set_status(run_id, AgentRunStatus::WaitingForPermission);
    port.emit(sup, run_id, AgentEvent::PermissionRequested { run_id: run_id.to_string(), request, ts })?;

    // The bridge runs each request on its own plain thread, so a blocking wait
    // is the right shape here. A stopped run retires its handle, which drops
    // the sender: that reads as a deny, never as a hang.
    let reply = rx.blocking_recv();
    sup.set_status(run_id, AgentRunStatus::Running);
    sup.with_handle(run_id, &mut |h| h.trust.note_pending_capability(None));
    let decision: Value = reply
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({ "behavior": "deny" }));
    // Best effort: after a Stop the transcript may already be sealed.
    let _ = port.emit(
        sup,
        run_id,
        AgentEvent::PermissionResolved { run_id: run_id.to_string(), request_id, decision: decision.clone(), ts: now_ms() },
    );

    if decision.get("behavior").and_then(Value::as_str) != Some("allow") {
        if let Some(cmd) = command.as_deref() {
            sup.with_handle(run_id, &mut |h| h.trust.remember_rejected(Capability::Command, cmd));
        }
        let message = decision
            .get("message")
            .and_then(Value::as_str)
            .filter(|m| !m.trim().is_empty())
            .unwrap_or("The user declined this in Klide.");
        return Ok(deny(message));
    }
    if let Some(cmd) = command.as_deref() {
        let scope = decision.get("scope").and_then(Value::as_str).unwrap_or("once");
        if scope == "run" || scope == "project" {
            sup.with_handle(run_id, &mut |h| h.trust.remember_approved(Capability::Command, cmd));
        }
        if scope == "project" {
            let rule = decision.get("pattern").and_then(Value::as_str).filter(|p| !p.trim().is_empty()).unwrap_or(cmd);
            // The command still runs on a failed write — the answer was yes —
            // but the failure is said, not swallowed.
            if let Err(e) = super::command_allowlist::add_rule(&port.runs_dir, workspace_root, rule) {
                eprintln!("delegate permission: could not remember `{rule}` for the project: {e}");
            }
        }
    }
    Ok(allow(&ask.input))
}

/// The request the card renders. A shell command carries `command` + `cwd`,
/// which is what makes the surface draw the `$` card with its scope choices;
/// anything else carries the CLI's own tool name and input, and offers no
/// project scope because Klide has no store for it.
fn card(run_id: &str, request_id: &str, workspace_root: &str, ask: &DelegatePermissionAsk, command: Option<&str>) -> PermissionRequest {
    let subject = crate::delegate::summarize_call(&ask.tool_name, &ask.input);
    let options = super::tool_handlers::standard_gate_options("Approve for this run", "Approve for this project")
        .into_iter()
        .filter(|option| command.is_some() || option.option_id != "allow_project")
        .collect();
    let input = match command {
        Some(cmd) => json!({
            "command": cmd,
            "cwd": workspace_root,
            "externalPaths": [],
            "delegateTool": ask.tool_name,
        }),
        None => json!({
            "delegateTool": ask.tool_name,
            "delegateInput": ask.input,
        }),
    };
    PermissionRequest {
        id: request_id.to_string(),
        run_id: run_id.to_string(),
        tool_call_id: ask.tool_use_id.clone().unwrap_or_default(),
        tool_name: ask.tool_name.clone(),
        input,
        summary: format!("The agent asks to run {subject}"),
        reason: "The CLI asked before acting. A headless turn has no terminal of its own, so the question comes here; the CLI runs it under its own sandbox once told yes. Approving for this project also lets later turns run it without asking.".to_string(),
        options,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::test_support::{make_handle, FakeSupervisor};
    use crate::agent::types::AgentEvent;
    use std::sync::mpsc;

    fn ask(command: &str) -> DelegatePermissionAsk {
        DelegatePermissionAsk {
            tool_name: "Bash".into(),
            input: json!({ "command": command, "description": "list PRs" }),
            tool_use_id: Some("toolu_1".into()),
        }
    }

    fn port(runs_dir: &std::path::Path) -> (OutOfBandPort, mpsc::Receiver<AgentEvent>) {
        let (tx, rx) = mpsc::channel();
        let on_event = Channel::new(move |msg: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = msg {
                if let Ok(event) = serde_json::from_str::<AgentEvent>(&json) {
                    let _ = tx.send(event);
                }
            }
            Ok(())
        });
        (OutOfBandPort { sequence: Arc::new(Mutex::new(7)), on_event, runs_dir: runs_dir.to_path_buf() }, rx)
    }

    fn runs_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-permission-relay-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn behavior(value: &Value) -> Value {
        serde_json::from_str(value["text"].as_str().unwrap()).unwrap()
    }

    /// Drive one relay on its own thread, answering the card with `reply`
    /// once it is up — the operator, as `agent_resolve_permission` would be.
    fn relay_with_answer(sup: Arc<FakeSupervisor>, runs_dir: &std::path::Path, ask: DelegatePermissionAsk, reply: &str) -> (Value, Vec<AgentEvent>) {
        let (port, events) = port(runs_dir);
        sup.with_handle("run-1", &mut |h| *h.out_of_band.lock().unwrap() = Some(OutOfBandPort {
            sequence: port.sequence.clone(), on_event: port.on_event.clone(), runs_dir: port.runs_dir.clone(),
        }));
        let worker = {
            let sup = sup.clone();
            std::thread::spawn(move || answer(&*sup, "run-1", "/ws", ask))
        };
        // Wait for the card, then answer it.
        let first = events.recv_timeout(std::time::Duration::from_secs(5)).expect("a card");
        assert!(matches!(first, AgentEvent::PermissionRequested { .. }));
        let mut sent = false;
        for _ in 0..200 {
            sup.with_handle("run-1", &mut |h| {
                if let Some(tx) = h.pending_permission.lock().unwrap().take() {
                    tx.send(reply.to_string()).unwrap();
                    sent = true;
                }
            });
            if sent { break; }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(sent, "the sender was stashed before the event");
        let value = worker.join().unwrap().unwrap();
        let mut all = vec![first];
        while let Ok(event) = events.recv_timeout(std::time::Duration::from_millis(200)) {
            all.push(event);
        }
        (value, all)
    }

    #[test]
    fn the_operator_answers_the_cli_through_the_same_card() {
        let dir = runs_dir("once");
        let sup = Arc::new(FakeSupervisor::with_run("run-1"));
        let (value, events) = relay_with_answer(sup.clone(), &dir, ask("gh pr list"), r#"{"behavior":"allow","scope":"once"}"#);
        let decision = behavior(&value);
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"]["command"], "gh pr list");
        // The card was the Harness's command card: `$ gh pr list`, with the
        // CLI's tool named beside it, and the pair of events in the transcript.
        match &events[0] {
            AgentEvent::PermissionRequested { request, .. } => {
                assert_eq!(request.id, "perm_run-1_toolu_1");
                assert_eq!(request.input["command"], "gh pr list");
                assert_eq!(request.input["delegateTool"], "Bash");
                assert!(request.options.iter().any(|o| o.option_id == "allow_project"));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(&events[1], AgentEvent::PermissionResolved { request_id, .. } if request_id == "perm_run-1_toolu_1"));
        // Both lines are on disk, at the loop's own sequence numbers.
        let transcript = std::fs::read_to_string(dir.join("run-1.jsonl")).unwrap_or_default();
        assert!(transcript.contains("permission_requested") || transcript.contains("PermissionRequested"), "{transcript}");
        // Status went back to Running and the capability note was cleared.
        sup.with_handle("run-1", &mut |h| {
            assert_eq!(h.status, AgentRunStatus::Running);
            assert_eq!(h.trust.pending_capability(), None);
        });
        // Once is once: the same command asks again.
        sup.with_handle("run-1", &mut |h| assert!(!h.trust.approved(Capability::Command, "gh pr list")));
    }

    #[test]
    fn a_deny_is_remembered_and_told_to_the_cli() {
        let dir = runs_dir("deny");
        let sup = Arc::new(FakeSupervisor::with_run("run-1"));
        let (value, _) = relay_with_answer(sup.clone(), &dir, ask("rm -rf build"), r#"{"behavior":"deny"}"#);
        let decision = behavior(&value);
        assert_eq!(decision["behavior"], "deny");
        assert_eq!(decision["message"], "The user declined this in Klide.");
        // Asked again this run: declined without a card.
        let value = answer(&*sup, "run-1", "/ws", ask("rm -rf build")).unwrap();
        assert_eq!(behavior(&value)["behavior"], "deny");
        assert!(behavior(&value)["message"].as_str().unwrap().contains("earlier in this run"));
    }

    #[test]
    fn approved_for_the_run_skips_the_next_card() {
        let dir = runs_dir("run-scope");
        let sup = Arc::new(FakeSupervisor::with_run("run-1"));
        let (value, _) = relay_with_answer(sup.clone(), &dir, ask("npm test"), r#"{"behavior":"allow","scope":"run"}"#);
        assert_eq!(behavior(&value)["behavior"], "allow");
        let value = answer(&*sup, "run-1", "/ws", ask("npm test")).unwrap();
        assert_eq!(behavior(&value)["behavior"], "allow");
    }

    #[test]
    fn full_auto_answers_a_command_without_a_card_and_says_so() {
        let dir = runs_dir("full-auto");
        let sup = Arc::new(FakeSupervisor::with_run("run-1"));
        let (port, events) = port(&dir);
        let mut port = Some(port);
        sup.with_handle("run-1", &mut |h| {
            *h.out_of_band.lock().unwrap() = port.take();
            h.trust.set_commands_policy(true);
        });
        let value = answer(&*sup, "run-1", "/ws", ask("cargo build")).unwrap();
        assert_eq!(behavior(&value)["behavior"], "allow");
        let first = events.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        let second = events.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert!(matches!(first, AgentEvent::PermissionRequested { .. }));
        assert!(matches!(second, AgentEvent::PermissionResolved { decision, .. } if decision["via"] == "full_auto"));
    }

    #[test]
    fn no_run_or_no_turn_in_flight_is_a_deny_that_explains() {
        let sup = FakeSupervisor::with_run("run-1");
        let value = answer(&sup, "run-9", "/ws", ask("ls")).unwrap();
        assert!(behavior(&value)["message"].as_str().unwrap().contains("no live Run"));
        // A bound handle with no port: the Harness isn't turning this session.
        let value = answer(&sup, "run-1", "/ws", ask("ls")).unwrap();
        assert!(behavior(&value)["message"].as_str().unwrap().contains("not driving this turn"));
        let _ = make_handle();
    }

    #[test]
    fn a_non_shell_prompt_offers_no_project_scope() {
        let dir = runs_dir("fetch");
        let sup = Arc::new(FakeSupervisor::with_run("run-1"));
        let fetch = DelegatePermissionAsk { tool_name: "WebFetch".into(), input: json!({ "url": "https://docs.rs" }), tool_use_id: None };
        let (value, events) = relay_with_answer(sup, &dir, fetch, r#"{"behavior":"allow","scope":"once"}"#);
        assert_eq!(behavior(&value)["behavior"], "allow");
        match &events[0] {
            AgentEvent::PermissionRequested { request, .. } => {
                assert!(request.input.get("command").is_none());
                assert_eq!(request.input["delegateInput"]["url"], "https://docs.rs");
                assert!(request.options.iter().all(|o| o.option_id != "allow_project"));
                assert!(request.id.starts_with("perm_run-1_delegate-"));
            }
            other => panic!("{other:?}"),
        }
    }
}
