//! Evidence packet rendering — fold a run's summary + transcript into one
//! Markdown document a human (or a PR comment) can read: what was asked,
//! what changed, what was verified, what was permitted, and why the run
//! stopped. The transcript is the source of truth; nothing here is guessed
//! from UI state.

use super::transcripts::summarize_validation;
use super::types::{AgentContentBlock, AgentEvent, AgentRunSummary};

/// One executed `run_command` (or permission-backed dynamic command): the
/// command line the model asked for and whether it succeeded.
struct CommandRow {
    command: String,
    ok: Option<bool>,
}

/// A permission the run paused on, with the user's decision.
struct PermissionRow {
    label: String,
    decision: String,
}

/// A file the run touched, with how the write was authorized.
struct FileRow {
    path: String,
    decision: String,
}

pub fn render_evidence_markdown(summary: &AgentRunSummary, events: &[AgentEvent]) -> String {
    let validation = summarize_validation(events);

    // ---- walk the transcript once for everything the sections need ----
    let mut goal: Option<String> = None;
    let mut mode: Option<String> = None;
    let mut stop_reason: Option<String> = None;
    let mut last_assistant: Option<String> = None;
    let mut first_ts: Option<i64> = None;
    let mut last_ts: i64 = 0;
    let mut user_turns = 0u32;
    let mut assistant_turns = 0u32;
    let mut tool_counts: Vec<(String, u32)> = Vec::new();
    let mut commands: Vec<CommandRow> = Vec::new();
    let mut permissions: Vec<PermissionRow> = Vec::new();
    let mut files: Vec<FileRow> = Vec::new();
    let mut subagents = 0u32;
    let mut advisor_calls = 0u32;
    // tool_call_id → index into `commands`, so the finish event can fill `ok`.
    let mut command_ix: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    // proposal path → pending, resolved by the next DiffResolved (proposals
    // pause the run, so proposal/resolution pairs never interleave).
    let mut pending_diff_path: Option<String> = None;
    // request payload of the last PermissionRequested, matched to its
    // resolution the same way (the gate pauses the run).
    let mut pending_permission: Option<String> = None;

    for event in events {
        let ts = event_ts(event);
        if first_ts.is_none() && ts > 0 {
            first_ts = Some(ts);
        }
        if ts > last_ts {
            last_ts = ts;
        }
        match event {
            AgentEvent::RunStarted { mode: m, .. } => {
                mode = Some(format!("{m:?}").to_lowercase());
            }
            AgentEvent::UserMessage { text, .. } => {
                user_turns += 1;
                if goal.is_none() {
                    let t = text.trim();
                    if !t.is_empty() {
                        goal = Some(t.to_string());
                    }
                }
            }
            AgentEvent::AssistantMessage { content, .. } => {
                assistant_turns += 1;
                let text: String = content
                    .iter()
                    .filter_map(|b| match b {
                        AgentContentBlock::Text { text } => Some(text.trim()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    last_assistant = Some(text.trim().to_string());
                }
            }
            AgentEvent::ToolCallStarted {
                tool_call_id,
                name,
                input,
                ..
            } => {
                match tool_counts.iter_mut().find(|(n, _)| n == name) {
                    Some((_, c)) => *c += 1,
                    None => tool_counts.push((name.clone(), 1)),
                }
                if let Some(cmd) = input.get("command").and_then(|c| c.as_str()) {
                    command_ix.insert(tool_call_id.clone(), commands.len());
                    commands.push(CommandRow {
                        command: cmd.to_string(),
                        ok: None,
                    });
                }
            }
            AgentEvent::ToolCallFinished {
                tool_call_id,
                result,
                ..
            } => {
                if let Some(&ix) = command_ix.get(tool_call_id) {
                    commands[ix].ok = Some(result.ok);
                }
            }
            AgentEvent::PermissionRequested { request, .. } => {
                pending_permission = Some(permission_label(request));
            }
            AgentEvent::PermissionResolved { decision, .. } => {
                let label = pending_permission
                    .take()
                    .unwrap_or_else(|| "(unknown request)".to_string());
                permissions.push(PermissionRow {
                    label,
                    decision: decision_behavior(decision),
                });
            }
            AgentEvent::DiffProposed { proposal, .. } => {
                pending_diff_path = Some(proposal.path.clone());
            }
            AgentEvent::DiffResolved { decision, .. } => {
                if let Some(path) = pending_diff_path.take() {
                    files.push(FileRow {
                        path,
                        decision: decision_behavior(decision),
                    });
                }
            }
            AgentEvent::FileChanged { path, .. } => {
                // Auto-accepted edits change files without a DiffResolved pair;
                // record them once so the packet never under-reports writes.
                let trimmed = path.trim();
                if !trimmed.is_empty() && !files.iter().any(|f| f.path == trimmed) {
                    files.push(FileRow {
                        path: trimmed.to_string(),
                        decision: "applied".to_string(),
                    });
                }
            }
            AgentEvent::RunResult { result, .. } => {
                stop_reason = Some(
                    result
                        .get("status")
                        .and_then(|s| s.as_str())
                        .unwrap_or("done")
                        .to_string(),
                );
            }
            AgentEvent::RunError { error, .. } => {
                stop_reason = Some(format!("error — {}", error.message));
            }
            AgentEvent::SubagentRequested { .. } => subagents += 1,
            AgentEvent::AdvisorRequested { .. } => advisor_calls += 1,
            _ => {}
        }
    }

    // ---- assemble the document ----
    let mut md = String::new();
    md.push_str(&format!("# Evidence — {}\n\n", summary.title.trim()));

    md.push_str(&format!("- **Run** `{}`\n", summary.id));
    let provider_line = match mode {
        Some(m) => format!("{} · {} · {} mode", summary.provider, summary.model, m),
        None => format!("{} · {}", summary.provider, summary.model),
    };
    md.push_str(&format!("- **Agent** {provider_line}\n"));
    if let Some(project) = summary.project.as_deref().or(summary.cwd.as_deref()) {
        md.push_str(&format!("- **Project** {project}\n"));
    }
    if let Some(branch) = &summary.git_branch {
        match &summary.worktree {
            Some(wt) => md.push_str(&format!("- **Branch** {branch} (worktree `{wt}`)\n")),
            None => md.push_str(&format!("- **Branch** {branch}\n")),
        }
    }
    if let (Some(start), true) = (first_ts, last_ts > 0) {
        let secs = ((last_ts - start).max(0) / 1000) as u64;
        md.push_str(&format!(
            "- **Duration** {} ({} user / {} assistant turns)\n",
            human_duration(secs),
            user_turns,
            assistant_turns
        ));
    }
    if summary.input_tokens > 0 || summary.output_tokens > 0 {
        let cost = summary
            .cost_usd
            .map(|c| format!(" · ${c:.4}"))
            .unwrap_or_default();
        md.push_str(&format!(
            "- **Tokens** {} in / {} out{cost}\n",
            summary.input_tokens, summary.output_tokens
        ));
    }
    let stop = stop_reason.unwrap_or_else(|| summary.status.clone());
    md.push_str(&format!("- **Stopped** {stop}\n\n"));

    if let Some(goal) = goal {
        md.push_str("## Goal\n\n");
        md.push_str(&blockquote(&clip(&goal, 600)));
        md.push_str("\n\n");
    }

    md.push_str(&format!(
        "## Validation — {}\n\n",
        validation.status.to_uppercase()
    ));
    for check in &validation.checks {
        let mark = match check.status.as_str() {
            "passed" => "x",
            _ => " ",
        };
        let evidence = check
            .evidence
            .as_deref()
            .map(|e| format!(" — {e}"))
            .unwrap_or_default();
        let status_note = if check.status == "skipped" {
            " *(skipped)*"
        } else {
            ""
        };
        md.push_str(&format!("- [{mark}] {}{evidence}{status_note}\n", check.label));
    }
    for warning in &validation.warnings {
        md.push_str(&format!("- ⚠ {warning}\n"));
    }
    md.push('\n');

    if !files.is_empty() {
        md.push_str(&format!("## Files changed ({})\n\n", files.len()));
        for f in &files {
            md.push_str(&format!("- `{}` — {}\n", f.path, f.decision));
        }
        md.push('\n');
    }

    if !commands.is_empty() {
        md.push_str(&format!(
            "## Commands ({} run, {} failed)\n\n",
            validation.commands_run, validation.commands_failed
        ));
        for c in &commands {
            let outcome = match c.ok {
                Some(true) => "ok",
                Some(false) => "**failed**",
                None => "no result recorded",
            };
            md.push_str(&format!("- `{}` — {outcome}\n", clip(&c.command, 200)));
        }
        md.push('\n');
    }

    if !permissions.is_empty() {
        md.push_str(&format!(
            "## Permissions ({} approved, {} denied)\n\n",
            validation.permissions_approved, validation.permissions_denied
        ));
        for p in &permissions {
            md.push_str(&format!("- {} — {}\n", clip(&p.label, 200), p.decision));
        }
        md.push('\n');
    }

    if !tool_counts.is_empty() {
        let total: u32 = tool_counts.iter().map(|(_, c)| c).sum();
        let listing = tool_counts
            .iter()
            .map(|(n, c)| format!("{n} ×{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        md.push_str(&format!("## Tool calls ({total})\n\n{listing}\n"));
        if subagents > 0 || advisor_calls > 0 {
            md.push_str(&format!(
                "\nSub-agents spawned: {subagents} · Advisor consultations: {advisor_calls}\n"
            ));
        }
        md.push('\n');
    }

    if let Some(last) = last_assistant {
        md.push_str("## Final report\n\n");
        md.push_str(&blockquote(&clip(&last, 1200)));
        md.push('\n');
    }

    md
}

fn event_ts(event: &AgentEvent) -> i64 {
    match event {
        AgentEvent::RunStarted { ts, .. }
        | AgentEvent::ContextSnapshot { ts, .. }
        | AgentEvent::UserMessage { ts, .. }
        | AgentEvent::AssistantDelta { ts, .. }
        | AgentEvent::AssistantMessage { ts, .. }
        | AgentEvent::ToolCallStarted { ts, .. }
        | AgentEvent::ToolProgress { ts, .. }
        | AgentEvent::ToolCallFinished { ts, .. }
        | AgentEvent::PermissionRequested { ts, .. }
        | AgentEvent::PermissionResolved { ts, .. }
        | AgentEvent::DiffProposed { ts, .. }
        | AgentEvent::DiffResolved { ts, .. }
        | AgentEvent::FileChanged { ts, .. }
        | AgentEvent::RunResult { ts, .. }
        | AgentEvent::RunError { ts, .. }
        | AgentEvent::ContextCompacted { ts, .. }
        | AgentEvent::UserQuestionRequested { ts, .. }
        | AgentEvent::UserQuestionResolved { ts, .. }
        | AgentEvent::SubagentRequested { ts, .. }
        | AgentEvent::SubagentResolved { ts, .. }
        | AgentEvent::AdvisorRequested { ts, .. }
        | AgentEvent::AdvisorResolved { ts, .. }
        | AgentEvent::SteeringInjected { ts, .. } => *ts,
    }
}

/// Best human label for a permission request: the command line when present,
/// else whatever name-ish field the gate's caller put in the payload.
fn permission_label(request: &serde_json::Value) -> String {
    if let Some(cmd) = request
        .get("input")
        .and_then(|i| i.get("command"))
        .and_then(|c| c.as_str())
    {
        return format!("run `{cmd}`");
    }
    for key in ["toolName", "name", "title"] {
        if let Some(v) = request.get(key).and_then(|v| v.as_str()) {
            return v.to_string();
        }
    }
    "(unknown request)".to_string()
}

fn decision_behavior(decision: &serde_json::Value) -> String {
    match decision.get("behavior").and_then(|b| b.as_str()) {
        Some("allow") => "approved".to_string(),
        Some("apply") => "applied via diff review".to_string(),
        Some(other) => other.to_string(),
        None => "denied".to_string(),
    }
}

fn human_duration(secs: u64) -> String {
    if secs >= 3600 {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let clipped: String = text.chars().take(max).collect();
        format!("{clipped}…")
    }
}

fn blockquote(text: &str) -> String {
    text.lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::{AgentUsage, DiffProposal, ToolResult};

    fn base_summary(id: &str) -> AgentRunSummary {
        AgentRunSummary {
            id: id.to_string(),
            path: String::new(),
            source: "klide".to_string(),
            title: "Fix the flaky test".to_string(),
            status: "done".to_string(),
            provider: "ollama".to_string(),
            model: "qwen2.5:7b".to_string(),
            cwd: Some("/tmp/proj".to_string()),
            project: Some("proj".to_string()),
            git_branch: Some("main".to_string()),
            created_ms: 0,
            updated_ms: 0,
            message_count: 2,
            input_tokens: 1200,
            output_tokens: 300,
            files_touched: 1,
            cost_usd: None,
            last_event: None,
            worktree: None,
            validation: None,
            parent_id: None,
        }
    }

    fn full_run_events(id: &str) -> Vec<AgentEvent> {
        vec![
            AgentEvent::RunStarted {
                run_id: id.into(),
                cwd: Some("/tmp/proj".into()),
                mode: crate::agent::types::AgentMode::Goal,
                provider: "ollama".into(),
                model: "qwen2.5:7b".into(),
                ts: 1_000,
            },
            AgentEvent::UserMessage {
                run_id: id.into(),
                message_id: "u1".into(),
                text: "Fix the flaky test in ci.rs".into(),
                attachments: vec![],
                ts: 1_000,
            },
            AgentEvent::ToolCallStarted {
                run_id: id.into(),
                tool_call_id: "t1".into(),
                name: "run_command".into(),
                input: serde_json::json!({ "command": "cargo test" }),
                summary: "run_command".into(),
                ts: 2_000,
            },
            AgentEvent::ToolCallFinished {
                run_id: id.into(),
                tool_call_id: "t1".into(),
                result: ToolResult {
                    ok: true,
                    content: "ok".into(),
                    metadata: None,
                },
                ts: 3_000,
            },
            AgentEvent::DiffProposed {
                run_id: id.into(),
                proposal: DiffProposal {
                    id: "d1".into(),
                    run_id: id.into(),
                    tool_call_id: "t2".into(),
                    path: "src/ci.rs".into(),
                    old_content: String::new(),
                    new_content: String::new(),
                    old_hash: "a".into(),
                    new_hash: "b".into(),
                    unified_diff: String::new(),
                    is_create: false,
                    reason: None,
                },
                ts: 4_000,
            },
            AgentEvent::DiffResolved {
                run_id: id.into(),
                proposal_id: "d1".into(),
                decision: serde_json::json!({ "behavior": "apply" }),
                ts: 5_000,
            },
            AgentEvent::FileChanged {
                run_id: id.into(),
                path: "src/ci.rs".into(),
                old_hash: "a".into(),
                new_hash: "b".into(),
                ts: 5_000,
            },
            AgentEvent::AssistantMessage {
                run_id: id.into(),
                message_id: "a1".into(),
                content: vec![AgentContentBlock::Text {
                    text: "Fixed the race by pinning the port.".into(),
                }],
                usage: Some(AgentUsage {
                    prompt_tokens: Some(1200),
                    completion_tokens: Some(300),
                    ..Default::default()
                }),
                ts: 65_000,
            },
            AgentEvent::RunResult {
                run_id: id.into(),
                result: serde_json::json!({ "status": "done" }),
                ts: 65_000,
            },
        ]
    }

    #[test]
    fn packet_contains_all_sections_for_a_full_run() {
        let id = "r1";
        let md = render_evidence_markdown(&base_summary(id), &full_run_events(id));

        assert!(md.starts_with("# Evidence — Fix the flaky test"), "got: {md}");
        assert!(md.contains("ollama · qwen2.5:7b · goal mode"));
        assert!(md.contains("- **Stopped** done"));
        assert!(md.contains("## Goal"));
        assert!(md.contains("> Fix the flaky test in ci.rs"));
        assert!(md.contains("## Validation — PASSED"));
        assert!(md.contains("## Files changed (1)"));
        assert!(md.contains("`src/ci.rs` — applied via diff review"));
        assert!(md.contains("## Commands (1 run, 0 failed)"));
        assert!(md.contains("`cargo test` — ok"));
        assert!(md.contains("## Tool calls (1)"));
        assert!(md.contains("run_command ×1"));
        assert!(md.contains("## Final report"));
        assert!(md.contains("> Fixed the race by pinning the port."));
        assert!(md.contains("- **Duration** 1m 4s (1 user / 1 assistant turns)"));
        assert!(md.contains("- **Tokens** 1200 in / 300 out"));
    }

    #[test]
    fn unverified_run_carries_the_warning() {
        let id = "r2";
        // A write with no validation command → the packet must say so.
        let events = vec![
            AgentEvent::DiffResolved {
                run_id: id.into(),
                proposal_id: "d1".into(),
                decision: serde_json::json!({ "behavior": "apply" }),
                ts: 1_000,
            },
            AgentEvent::FileChanged {
                run_id: id.into(),
                path: "src/a.rs".into(),
                old_hash: "a".into(),
                new_hash: "b".into(),
                ts: 1_000,
            },
        ];
        let md = render_evidence_markdown(&base_summary(id), &events);
        assert!(md.contains("## Validation — UNVERIFIED"), "got: {md}");
        assert!(md.contains("without a recorded validation command"));
    }

    #[test]
    fn permission_rows_pair_request_with_decision() {
        let id = "r3";
        let events = vec![
            AgentEvent::PermissionRequested {
                run_id: id.into(),
                request: serde_json::json!({ "input": { "command": "npm test" } }),
                ts: 1_000,
            },
            AgentEvent::PermissionResolved {
                run_id: id.into(),
                request_id: "p1".into(),
                decision: serde_json::json!({ "behavior": "deny" }),
                ts: 2_000,
            },
        ];
        let md = render_evidence_markdown(&base_summary(id), &events);
        assert!(md.contains("## Permissions (0 approved, 1 denied)"), "got: {md}");
        assert!(md.contains("- run `npm test` — deny"));
    }

    #[test]
    fn error_run_reports_stop_reason() {
        let id = "r4";
        let events = vec![AgentEvent::RunError {
            run_id: id.into(),
            error: crate::agent::types::AgentError {
                code: "provider".into(),
                message: "connection refused".into(),
                detail: None,
                retryable: true,
            },
            ts: 1_000,
        }];
        let md = render_evidence_markdown(&base_summary(id), &events);
        assert!(md.contains("- **Stopped** error — connection refused"), "got: {md}");
    }

    #[test]
    fn empty_transcript_still_renders_header_and_validation() {
        let md = render_evidence_markdown(&base_summary("r5"), &[]);
        assert!(md.contains("# Evidence — Fix the flaky test"));
        assert!(md.contains("## Validation — SKIPPED"));
        // No files/commands/permissions sections when there's nothing to show.
        assert!(!md.contains("## Files changed"));
        assert!(!md.contains("## Commands"));
    }
}
