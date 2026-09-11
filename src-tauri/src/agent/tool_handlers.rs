//! The per-capability tool-call ceremony: what happens between the run
//! loop deciding a call may execute and the uniform emit/append of its
//! result. One handler per Tool capability — Pause (question / subagent /
//! advisor), Command, Network, Write — plus the loop monitor's advisor
//! escalation, which reuses the same pause. Execution itself stays in the
//! registry (tools.rs); mode gating stays in run_core; this module owns
//! only the ceremony: permission gates, pauses, checkpoints, rejection
//! memory.

use super::*;

/// Pause tool (`userAnswerQuestion`): ask the user a typed question and feed
/// their verbatim answer back to the model. "(skipped)" is the sentinel the
/// user can send to decline. Cancelling during the wait bubbles up as
/// The ceremony every Pause tool performs.
///
/// All four of them — question, subagent, advisor, and the advisor escalation the
/// loop monitor triggers — did the same six steps, and the closure that stashes
/// the reply channel was byte-identical in each. What differs is only which args
/// they read, which two events they emit, and what a skipped answer means.
///
/// Note the status: all four report `WaitingForPermission`, even though only one
/// of them is a permission. That is the wire vocabulary being narrower than the
/// states it has to describe (`AgentRunStatus` has no `WaitingForUser`), not a
/// choice worth preserving — but widening it is a wire change with a frontend
/// mirror, so it stays as-is here and is written down instead of re-derived four
/// times.
///
/// `Ok(None)` means the run was cancelled while parked.
async fn run_pause_tool<E, R, S>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
    key_prefix: &str,
    default_answer: &str,
    requested: R,
    resolved: S,
) -> Result<Option<String>, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
    R: FnOnce(&str) -> AgentEvent,
    S: FnOnce(&str, &str) -> AgentEvent,
{
    let request_id = format!("{key_prefix}_{}_{}", ctx.id, call.id);

    let answer = match pause_for_user(
        ctx.sup,
        ctx.id,
        AgentRunStatus::WaitingForPermission,
        requested(&request_id),
        default_answer,
        ctx.cancel,
        emit,
        |handle, tx| {
            *handle.pending_question.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
        PauseOutcome::Cancelled => return Ok(None),
        PauseOutcome::Resolved(answer) => answer,
    };

    emit(resolved(&request_id, &answer))?;
    Ok(Some(answer))
}

/// `Cancelled`.
pub(super) async fn process_pause_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let question = call
        .input
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("(empty question)")
        .to_string();
    let Some(answer) = run_pause_tool(
        ctx,
        call,
        emit,
        "q",
        "(skipped)",
        |request_id| AgentEvent::UserQuestionRequested {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            question: question.clone(),
            ts: now_ms(),
        },
        |request_id, answer| AgentEvent::UserQuestionResolved {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            answer: answer.to_string(),
            ts: now_ms(),
        },
    )
    .await?
    else {
        return Ok(ToolOutcome::Cancelled);
    };

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: if answer == "(skipped)" {
            "[user skipped this question]".to_string()
        } else {
            answer
        },
        metadata: None,
    }))
}

/// Subagent spawn tool (`spawn_subagent`): delegate a focused investigation to
/// a named subagent and feed its report back as this tool's result.
///
/// The harness owns the whole exchange. It resolves the role from the Rust
/// registry, composes the child prompt from *this* run's system prompt, and
/// drives the child Run to completion through the supervisor seam — so the pair
/// survives a panel unmount, a webview reload, and a reattach. It is no longer a
/// Pause tool: nothing here waits on a human, so the parent reports `Paused`
/// rather than borrowing the question pause's `WaitingForPermission` status.
///
/// Cancelling the parent cancels the child too, then bubbles up as `Cancelled`.
pub(super) async fn process_subagent_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let subagent = call
        .input
        .get("subagent")
        .and_then(|v| v.as_str())
        .unwrap_or("explorer")
        .to_string();
    let task = call
        .input
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // An unknown role is a model mistake, not a run failure: name the ones that
    // exist and let it try again.
    let Some(def) = subagents::resolve(&subagent) else {
        return Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content: format!(
                "Unknown subagent \"{subagent}\". Available subagents: {}.",
                subagents::model_selectable_ids().join(", ")
            ),
            metadata: None,
        }));
    };
    // The tool promises the delegate cannot edit. Until now only the schema's
    // `enum` held that line, so a model that named an editing role anyway got
    // one. Refuse here too: a contract worth stating is worth enforcing.
    if !subagents::is_model_selectable(def) {
        return Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content: format!(
                "Subagent \"{}\" makes edits and cannot be delegated to from a run. \
                 Read-only subagents: {}.",
                def.id,
                subagents::model_selectable_ids().join(", ")
            ),
            metadata: None,
        }));
    }

    let request_id = format!("sub_{}_{}", ctx.id, call.id);
    emit(AgentEvent::SubagentRequested {
        run_id: ctx.id.to_string(),
        request_id: request_id.clone(),
        subagent: def.id.to_string(),
        task: task.clone(),
        ts: now_ms(),
    })?;

    let spec = subagents::SubagentRunSpec {
        run_id: request_id.clone(),
        parent_id: ctx.id.to_string(),
        workspace_root: ctx.request.workspace_root.clone(),
        mode: def.mode.clone(),
        provider: ctx.request.provider.clone(),
        // The role may pin a cheaper model; otherwise the child inherits the
        // parent's, so a subagent never silently escalates cost.
        model: def
            .model
            .map(|m| m.to_string())
            .unwrap_or_else(|| ctx.request.model.clone()),
        task: task.clone(),
        system_prompt: subagents::build_system_prompt(def, &base_system_prompt(ctx.request)),
        max_turns: ctx.request.max_turns,
        require_diff_review: ctx.request.require_diff_review,
    };

    set_run_status(ctx.sup, ctx.id, AgentRunStatus::Paused);
    let child = ctx.sup.spawn_subagent(spec);
    let report = tokio::select! {
        // Cancelling the parent must not leave the child running headless.
        _ = ctx.cancel.cancelled() => {
            ctx.sup.with_handle(&request_id, &mut |handle| handle.cancel.cancel());
            return Ok(ToolOutcome::Cancelled);
        }
        result = child => match result {
            Ok(Ok(report)) => report,
            // A child that failed is a tool result the model can react to, not a
            // dead parent run.
            Ok(Err(err)) => format!("Subagent \"{}\" failed: {err}", def.id),
            Err(_) => format!("Subagent \"{}\" ended without reporting.", def.id),
        },
    };
    set_run_status(ctx.sup, ctx.id, AgentRunStatus::Running);

    emit(AgentEvent::SubagentResolved {
        run_id: ctx.id.to_string(),
        request_id,
        result: report.clone(),
        ts: now_ms(),
    })?;

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: report,
        metadata: Some(serde_json::json!({ "subagent": def.id })),
    }))
}

fn coordination_tool_error(message: impl Into<String>) -> ToolOutcome {
    ToolOutcome::Produced(ToolResult {
        ok: false,
        content: message.into(),
        metadata: None,
    })
}

fn coordination_timeout_seconds(input: &serde_json::Value) -> u64 {
    input
        .get("timeoutSeconds")
        .and_then(|value| value.as_u64())
        .unwrap_or(30)
        .clamp(1, 120)
}

fn coordination_envelope_kind(
    input: &serde_json::Value,
) -> Result<CoordinationEnvelopeKind, String> {
    match input
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("instruction")
    {
        "instruction" => Ok(CoordinationEnvelopeKind::Instruction),
        "question" => Ok(CoordinationEnvelopeKind::Question),
        "answer" => Ok(CoordinationEnvelopeKind::Answer),
        "progress" => Ok(CoordinationEnvelopeKind::Progress),
        "handoff" => Ok(CoordinationEnvelopeKind::Handoff),
        other => Err(format!("Unknown coordination message kind `{other}`.")),
    }
}

fn coordination_messages_text(inbox: &[CoordinationEnvelopeSnapshot]) -> String {
    let mut text = String::from("Coordination messages received:");
    for entry in inbox {
        let envelope = &entry.envelope;
        text.push_str(&format!(
            "\n\n- envelopeId: {}\n  kind: {}\n  from: {}\n  body: {}",
            envelope.id,
            coordination_kind_label(envelope.kind),
            coordination_actor_label(&envelope.from),
            envelope.body
        ));
    }
    text
}

async fn wait_for_coordination_messages(
    ctx: &ToolCtx<'_>,
    workspace_root: &str,
    from_run_id: Option<&str>,
    reply_to: Option<&str>,
    timeout_seconds: u64,
) -> Result<Option<Vec<CoordinationEnvelopeSnapshot>>, ToolOutcome> {
    set_run_status(ctx.sup, ctx.id, AgentRunStatus::Paused);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_seconds);
    loop {
        let inbox = match load_coordination_inbox(ctx.sup, workspace_root, ctx.id) {
            Ok(inbox) => inbox,
            Err(error) => {
                set_run_status(ctx.sup, ctx.id, AgentRunStatus::Running);
                return Err(coordination_tool_error(error));
            }
        };
        let matched = inbox
            .into_iter()
            .filter(|entry| {
                let sender_matches = from_run_id.map_or(true, |expected| {
                    matches!(
                        &entry.envelope.from,
                        CoordinationActor::Run { run_id } if run_id == expected
                    )
                });
                let reply_matches = reply_to.map_or(true, |expected| {
                    entry.envelope.reply_to.as_deref() == Some(expected)
                });
                sender_matches && reply_matches
            })
            .collect::<Vec<_>>();
        if !matched.is_empty() {
            if let Err(error) =
                acknowledge_coordination_inbox(ctx.sup, workspace_root, ctx.id, &matched)
            {
                set_run_status(ctx.sup, ctx.id, AgentRunStatus::Running);
                return Err(coordination_tool_error(error));
            }
            set_run_status(ctx.sup, ctx.id, AgentRunStatus::Running);
            return Ok(Some(matched));
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            set_run_status(ctx.sup, ctx.id, AgentRunStatus::Running);
            return Ok(None);
        }
        let pause = std::cmp::min(
            std::time::Duration::from_millis(250),
            deadline.saturating_duration_since(now),
        );
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                set_run_status(ctx.sup, ctx.id, AgentRunStatus::Running);
                return Err(ToolOutcome::Cancelled);
            }
            _ = tokio::time::sleep(pause) => {}
        }
    }
}

/// Native coordination Tools. The current Run id is always the actor; no Tool
/// argument can impersonate another Run. The same durable command path serves
/// Harness state, Mission Control, and future identity-bound adapters.
pub(super) async fn process_coordination_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    _emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let Some(workspace_root) = ctx.request.workspace_root.as_deref() else {
        return Ok(coordination_tool_error(
            "Agent coordination requires a workspace-rooted Run.",
        ));
    };
    let Some(flavor) = tools::coordination_flavor(&call.name) else {
        return Ok(coordination_tool_error(format!(
            "Unknown coordination Tool: {}",
            call.name
        )));
    };

    let outcome = match flavor {
        tools::CoordinationFlavor::List => {
            let snapshot = match ctx.sup.coordination_snapshot(workspace_root) {
                Ok(snapshot) => snapshot,
                Err(error) => return Ok(coordination_tool_error(error)),
            };
            let visible = match crate::coordination::visible_runs_for(&snapshot, ctx.id) {
                Ok(visible) => visible,
                Err(error) => return Ok(coordination_tool_error(error)),
            };
            let rows = visible
                .into_iter()
                .map(|run| {
                    let run_id = run.registration.run_id.as_str();
                    // A top-level conversation sits in `waiting` between user
                    // turns forever, so the journal alone cannot say whether a
                    // peer is around. The live handle can: a message to a live
                    // peer lands at its next turn; one to an idle peer waits
                    // until its user speaks again.
                    let live = ctx.sup.is_live(run_id);
                    serde_json::json!({
                        "runId": run_id,
                        "relation": crate::coordination::relation_label(&snapshot, ctx.id, run_id),
                        "state": run.state,
                        "live": live,
                        "workerKind": run.registration.worker_kind,
                        "label": run.registration.label,
                        "missionId": run.registration.mission_id,
                        "cancelRequested": run.cancel_request.is_some(),
                    })
                })
                .collect::<Vec<_>>();
            ToolOutcome::Produced(ToolResult {
                ok: true,
                content: serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".to_string()),
                metadata: Some(serde_json::json!({ "runs": rows })),
            })
        }
        tools::CoordinationFlavor::Send => {
            let target = call
                .input
                .get("toRunId")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            let body = call
                .input
                .get("body")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            if target.is_empty() || body.is_empty() {
                return Ok(coordination_tool_error(
                    "agent_send requires non-empty toRunId and body.",
                ));
            }
            let kind = match coordination_envelope_kind(&call.input) {
                Ok(kind) => kind,
                Err(error) => return Ok(coordination_tool_error(error)),
            };
            let reply_to = call
                .input
                .get("replyTo")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let correlation_id = call
                .input
                .get("correlationId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let idempotency_key = call
                .input
                .get("idempotencyKey")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let sent = match ctx.sup.coordination_apply(
                workspace_root,
                CoordinationCommand::SendEnvelope {
                    from: CoordinationActor::Run {
                        run_id: ctx.id.to_string(),
                    },
                    to_run_id: target.to_string(),
                    kind,
                    body: body.to_string(),
                    reply_to,
                    correlation_id,
                    idempotency_key: idempotency_key.clone(),
                    source_refs: vec![],
                },
            ) {
                Ok(outcome) => outcome,
                Err(error) => return Ok(coordination_tool_error(error)),
            };
            let envelope = sent
                .appended
                .as_ref()
                .and_then(|line| match &line.event {
                    crate::coordination::CoordinationEvent::EnvelopeQueued { envelope } => {
                        Some(envelope.clone())
                    }
                    _ => None,
                })
                .or_else(|| {
                    sent.snapshot.envelopes.iter().rev().find_map(|entry| {
                        let envelope = &entry.envelope;
                        (envelope.from
                            == (CoordinationActor::Run {
                                run_id: ctx.id.to_string(),
                            })
                            && envelope.to_run_id == target
                            && envelope.idempotency_key == idempotency_key)
                            .then(|| envelope.clone())
                    })
                });
            let Some(envelope) = envelope else {
                return Ok(coordination_tool_error(
                    "The message was recorded but its envelope could not be resolved.",
                ));
            };
            if call
                .input
                .get("waitForReply")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                match wait_for_coordination_messages(
                    ctx,
                    workspace_root,
                    Some(target),
                    Some(&envelope.id),
                    coordination_timeout_seconds(&call.input),
                )
                .await
                {
                    Ok(Some(messages)) => ToolOutcome::Produced(ToolResult {
                        ok: true,
                        content: coordination_messages_text(&messages),
                        metadata: Some(serde_json::json!({
                            "envelopeId": envelope.id,
                            "deliveryState": "acknowledged",
                            "replies": messages,
                        })),
                    }),
                    Ok(None) => ToolOutcome::Produced(ToolResult {
                        ok: true,
                        content: format!(
                            "Message {} was queued for @{target}; no reply arrived within the wait window.",
                            envelope.id
                        ),
                        metadata: Some(serde_json::json!({
                            "envelopeId": envelope.id,
                            "deliveryState": "queued",
                            "timedOut": true,
                        })),
                    }),
                    Err(outcome) => outcome,
                }
            } else {
                ToolOutcome::Produced(ToolResult {
                    ok: true,
                    content: format!("Message {} queued for @{target}.", envelope.id),
                    metadata: Some(serde_json::json!({
                        "envelopeId": envelope.id,
                        "deliveryState": "queued",
                    })),
                })
            }
        }
        tools::CoordinationFlavor::Wait => {
            let from_run_id = call
                .input
                .get("fromRunId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let reply_to = call
                .input
                .get("replyTo")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            match wait_for_coordination_messages(
                ctx,
                workspace_root,
                from_run_id,
                reply_to,
                coordination_timeout_seconds(&call.input),
            )
            .await
            {
                Ok(Some(messages)) => ToolOutcome::Produced(ToolResult {
                    ok: true,
                    content: coordination_messages_text(&messages),
                    metadata: Some(serde_json::json!({ "messages": messages })),
                }),
                Ok(None) => ToolOutcome::Produced(ToolResult {
                    ok: true,
                    content: "No matching coordination message arrived within the wait window."
                        .to_string(),
                    metadata: Some(serde_json::json!({ "timedOut": true })),
                }),
                Err(outcome) => outcome,
            }
        }
        tools::CoordinationFlavor::Cancel => {
            let target = call
                .input
                .get("runId")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            if target.is_empty() {
                return Ok(coordination_tool_error("agent_cancel requires runId."));
            }
            let reason = call
                .input
                .get("reason")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if let Err(error) = ctx.sup.coordination_apply(
                workspace_root,
                CoordinationCommand::RequestCancel {
                    actor: CoordinationActor::Run {
                        run_id: ctx.id.to_string(),
                    },
                    run_id: target.to_string(),
                    reason,
                },
            ) {
                return Ok(coordination_tool_error(error));
            }
            let live = ctx
                .sup
                .with_handle(target, &mut |handle| handle.cancel.cancel());
            ToolOutcome::Produced(ToolResult {
                ok: true,
                content: if live {
                    format!("Cancellation requested for @{target}; its live token was signalled.")
                } else {
                    format!(
                        "Cancellation requested for @{target}; no live local handle was attached."
                    )
                },
                metadata: Some(serde_json::json!({ "runId": target, "live": live })),
            })
        }
        tools::CoordinationFlavor::ReadResult => {
            let target = call
                .input
                .get("runId")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            if target.is_empty() {
                return Ok(coordination_tool_error("agent_read_result requires runId."));
            }
            let snapshot = match ctx.sup.coordination_snapshot(workspace_root) {
                Ok(snapshot) => snapshot,
                Err(error) => return Ok(coordination_tool_error(error)),
            };
            match crate::coordination::visible_result_for(&snapshot, ctx.id, target) {
                Ok(Some(result)) => ToolOutcome::Produced(ToolResult {
                    ok: true,
                    content: serde_json::to_string_pretty(&result)
                        .unwrap_or_else(|_| result.summary.clone()),
                    metadata: Some(serde_json::json!({ "result": result })),
                }),
                Ok(None) => ToolOutcome::Produced(ToolResult {
                    ok: true,
                    content: format!("@{target} has not published a result yet."),
                    metadata: Some(serde_json::json!({ "runId": target, "ready": false })),
                }),
                Err(error) => coordination_tool_error(error),
            }
        }
    };
    Ok(outcome)
}

/// Advisor consult tool (`consult_advisor`): a Pause tool that escalates one
/// hard decision to a stronger advisor model. The loop emits `AdvisorRequested`
/// and parks on the shared question oneshot; the frontend asks a bigger model
/// (or a Claude Code session) the executor's question and resolves through
/// `agent_resolve_question` with the advice, which becomes this tool's result.
/// Distinct from `spawn_subagent`: the advisor gives *guidance*, not a nested
/// agentic run — the executor stays in control and applies the advice itself.
/// Cancelling during the wait bubbles up as `Cancelled`.
/// Sentinel the frontend prepends when an advisor consult fails (no key,
/// provider unreachable, empty reply). The shared question oneshot only carries
/// a string, so this marker is how a failure crosses back — process_advisor_tool
/// strips it and returns a NOT-ok tool result. Keep in sync with the same
/// constant in AiPanel's runAdvisorConsult.
pub(super) const ADVISOR_ERROR_PREFIX: &str = "[advisor:error] ";

pub(super) async fn process_advisor_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let question = call
        .input
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Fold optional `context` into the question so the advisor sees one
    // self-contained prompt — the frontend forwards this verbatim.
    let question = match call.input.get("context").and_then(|v| v.as_str()) {
        Some(c) if !c.trim().is_empty() => format!("{question}\n\nContext:\n{}", c.trim()),
        _ => question,
    };
    let Some(advice) = run_pause_tool(
        ctx,
        call,
        emit,
        "adv",
        // A closed channel is a failure, not advice — mark it so below.
        ADVISOR_ERROR_PREFIX,
        |request_id| AgentEvent::AdvisorRequested {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            question: question.clone(),
            ts: now_ms(),
        },
        |request_id, advice| AgentEvent::AdvisorResolved {
            run_id: ctx.id.to_string(),
            request_id: request_id.to_string(),
            advice: advice.to_string(),
            ts: now_ms(),
        },
    )
    .await?
    else {
        return Ok(ToolOutcome::Cancelled);
    };

    // A failed consult (no key, provider down, empty reply) is prefixed with
    // ADVISOR_ERROR_PREFIX by the frontend. Surface it as a NOT-ok tool result
    // so the executor treats it as a failure, not as guidance it should follow.
    if let Some(msg) = advice.strip_prefix(ADVISOR_ERROR_PREFIX) {
        return Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content: format!("Advisor consult failed: {}", msg.trim()),
            metadata: Some(serde_json::json!({ "advisor": true })),
        }));
    }

    Ok(ToolOutcome::Produced(ToolResult {
        ok: true,
        content: format!("Advisor guidance:\n{advice}"),
        metadata: Some(serde_json::json!({ "advisor": true })),
    }))
}

/// Outcome of an auto-escalated advisor consult (see `steer_via_advisor`).
pub(super) enum AdvisorSteer {
    /// The advisor answered; inject this guidance into the next turn.
    Advice(String),
    /// No advisor configured, or the consult failed — fall back to the plain
    /// steering nudge so the run still gets a course-correction.
    FallbackNudge,
    /// The user cancelled while the consult was parked; the caller settles the
    /// run and returns (only it can leave the loop).
    Cancelled,
}

/// Consult a stronger advisor *without* a model-initiated tool call: the loop
/// monitor detected a stuck failure loop and is escalating on the executor's
/// behalf. Emits the same `AdvisorRequested`/`AdvisorResolved` pause the
/// `consult_advisor` tool uses, so any run-owner (AI panel or headless mission)
/// services it unchanged. A closed channel or an `ADVISOR_ERROR_PREFIX` reply
/// (no advisor configured, provider down) degrades to `FallbackNudge`.
pub(super) async fn steer_via_advisor<E>(
    sup: &dyn RunSupervisor,
    id: &str,
    request_id: String,
    question: String,
    cancel: &CancellationToken,
    emit: &mut E,
) -> Result<AdvisorSteer, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let advice = match pause_for_user(
        sup,
        id,
        AgentRunStatus::WaitingForPermission,
        AgentEvent::AdvisorRequested {
            run_id: id.to_string(),
            request_id: request_id.clone(),
            question,
            ts: now_ms(),
        },
        ADVISOR_ERROR_PREFIX,
        cancel,
        emit,
        |handle, tx| {
            *handle.pending_question.lock().unwrap() = Some(tx);
        },
    )
    .await?
    {
        PauseOutcome::Cancelled => return Ok(AdvisorSteer::Cancelled),
        PauseOutcome::Resolved(advice) => advice,
    };

    emit(AgentEvent::AdvisorResolved {
        run_id: id.to_string(),
        request_id,
        advice: advice.clone(),
        ts: now_ms(),
    })?;

    if advice.strip_prefix(ADVISOR_ERROR_PREFIX).is_some() {
        return Ok(AdvisorSteer::FallbackNudge);
    }
    Ok(AdvisorSteer::Advice(advice))
}

/// The most recent tool result text in the provider message stream, truncated —
/// the error the advisor most needs to see when a failure loop is escalated.
pub(super) fn last_tool_output(messages: &[serde_json::Value]) -> Option<String> {
    messages.iter().rev().find_map(|m| {
        if m.get("role").and_then(|r| r.as_str()) == Some("tool") {
            m.get("content")
                .and_then(|c| c.as_str())
                .map(|s| s.chars().take(800).collect::<String>())
        } else {
            None
        }
    })
}

/// Command tool (`run_command` and dynamic command-capability tools): run a
/// shell command, but only after the user approves it through the permission
/// gate. Approvals/rejections are remembered per-run (and project-scoped ones
/// persist to the on-disk allowlist) so an identical command doesn't re-prompt.
/// Cancelling during the approval wait bubbles up as `Cancelled`.
/// The four options every command/network gate offers, declared once so the
/// optionId / behavior / scope wire contract can't drift between capabilities.
/// Only the run/project labels differ ("Approve for this run" vs "Approve
/// target for this run"). Serde owns the field names now, so the frontend
/// mirror can't disagree with them by hand.
pub(super) fn standard_gate_options(run_label: &str, project_label: &str) -> Vec<PermissionOption> {
    let option = |id: &str, label: &str, behavior: &str, scope: Option<&str>| PermissionOption {
        option_id: id.to_string(),
        label: label.to_string(),
        behavior: behavior.to_string(),
        scope: scope.map(str::to_string),
    };
    vec![
        option("allow_once", "Approve", "allow", Some("once")),
        option("allow_run", run_label, "allow", Some("run")),
        option("allow_project", project_label, "allow", Some("project")),
        option("deny", "Reject", "deny", None),
    ]
}

/// The choices on an incoming-message gate: let this one in, or every message
/// from this peer for the rest of the run. No project scope — a peer Run id
/// names one conversation.
pub(super) fn message_gate_options() -> Vec<PermissionOption> {
    standard_gate_options("Approve messages from this agent for this run", "")
        .into_iter()
        .filter(|option| option.option_id != "allow_project")
        .collect()
}

/// The receiving side's review of another agent's words, before they reach
/// this Run's model. Runs at the turn boundary, right before the inbox is
/// loaded: every envelope still queued for this Run is put to the user on the
/// same card as a shell command, and the answer is written to the journal as
/// an accept or a decline. "For this run" is remembered per sending peer, so
/// a peer once welcomed keeps talking without a prompt and a peer once refused
/// is declined silently. Full auto accepts everything, as it runs commands.
/// Returns `true` when the user cancelled the run while a card was up.
pub(super) async fn review_coordination_inbox<E>(
    ctx: &ToolCtx<'_>,
    workspace_root: &str,
    emit: &mut E,
) -> Result<bool, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let snapshot = ctx.sup.coordination_snapshot(workspace_root)?;
    let awaiting = crate::coordination::awaiting_review_for(&snapshot, ctx.id)?;
    let full_auto = ctx.request.auto_approve_commands == Some(true);
    for entry in awaiting {
        let envelope = &entry.envelope;
        let peer = match &envelope.from {
            CoordinationActor::Run { run_id } => run_id.as_str(),
            CoordinationActor::Operator => "operator",
        };
        let accept =
            match permission::precheck(ctx, permission::Capability::Message, peer, full_auto) {
                permission::Precheck::Execute => true,
                permission::Precheck::AutoReject(_) => false,
                permission::Precheck::Ask => {
                    let peer_label = snapshot
                        .runs
                        .iter()
                        .find(|run| run.registration.run_id == peer)
                        .and_then(|run| run.registration.label.clone());
                    let kind_label = format!("{:?}", envelope.kind).to_ascii_lowercase();
                    // Not a Tool call, but the gate needs a call id to pair the
                    // request with its resolution; the envelope id is that.
                    let call = NormalizedToolCall {
                        id: format!("inbox_{}", envelope.id),
                        name: "agent_inbox".to_string(),
                        input: serde_json::json!({}),
                    };
                    let perm = PermissionRequest {
                        id: permission::request_id(ctx, &call),
                        run_id: ctx.id.to_string(),
                        tool_call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        input: serde_json::json!({
                            "envelopeId": envelope.id,
                            "fromRunId": peer,
                            "peerLabel": peer_label,
                            "kind": kind_label,
                            "body": envelope.body,
                            "replyTo": envelope.reply_to,
                        }),
                        summary: format!(
                            "{kind_label} from @{}",
                            peer_label.as_deref().unwrap_or(peer)
                        ),
                        reason:
                            "Another agent wrote this; approve it to let this conversation read it."
                                .to_string(),
                        options: message_gate_options(),
                    };
                    let decision = match permission::run_gate(ctx, &call, perm, emit).await? {
                        permission::GateDecision::Cancelled => return Ok(true),
                        decision => decision,
                    };
                    permission::record(ctx, permission::Capability::Message, peer, peer, &decision);
                    matches!(decision, permission::GateDecision::Approved { .. })
                }
            };
        ctx.sup.coordination_apply(
            workspace_root,
            CoordinationCommand::ReviewEnvelope {
                actor: CoordinationActor::Run {
                    run_id: ctx.id.to_string(),
                },
                run_id: ctx.id.to_string(),
                envelope_id: envelope.id.clone(),
                accept,
            },
        )?;
    }
    Ok(false)
}

/// Run an approved command, then say what it left behind.
///
/// A write tool's edit arrives as `FileChanged` with a checkpoint behind it. A
/// file a *command* produces — a deck, a PDF, a generated report — has neither,
/// and until this it reached no surface at all. So the command is bracketed by
/// a read of the workspace's dirty set, and whatever appeared or changed in
/// between is announced as `ArtifactProduced`.
///
/// Best-effort by construction: no repo (or a git that will not answer) means
/// no detection, never a failed tool call. Ignored paths never appear, so a
/// `npm install` and a build into an ignored `dist/` stay silent.
async fn run_command_announcing_artifacts<E>(
    ctx: &ToolCtx<'_>,
    root: &str,
    cwd: &str,
    command: &str,
    timeout_secs: u64,
    emit: &mut E,
) -> Result<ToolResult, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let repo = repo_top(root).await;
    let before = match &repo {
        Some(top) => dirty_set(top).await,
        None => None,
    };
    let result = run_command_capture_in(root, cwd, command, timeout_secs).await;
    let (Some(top), Some(before)) = (repo, before) else {
        return Ok(result);
    };
    let Some(after) = dirty_set(&top).await else {
        return Ok(result);
    };
    for file in artifacts::produced(&before, &after) {
        let bytes = tokio::fs::metadata(top.join(&file.path))
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);
        emit(AgentEvent::ArtifactProduced {
            run_id: ctx.id.to_string(),
            path: file.path,
            bytes,
            created: file.created,
            ts: now_ms(),
        })?;
    }
    Ok(result)
}

/// The repository the workspace belongs to. Porcelain paths are relative to
/// this, not to the workspace or the command's cwd, so it is what both the
/// status read and the size read are anchored on.
async fn repo_top(root: &str) -> Option<std::path::PathBuf> {
    let out = tokio::process::Command::new("git")
        .args(["-C", root, "rev-parse", "--show-toplevel"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let top = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!top.is_empty()).then(|| std::path::PathBuf::from(top))
}

async fn dirty_set(top: &std::path::Path) -> Option<std::collections::BTreeMap<String, String>> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(top)
        // `-uall`: without it git collapses a wholly-untracked directory into
        // one `?? decks/` entry, and the deck inside it — the whole point —
        // never gets named.
        .args(["status", "--porcelain", "-uall"])
        .output()
        .await
        .ok()?;
    out.status
        .success()
        .then(|| artifacts::parse_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

pub(super) async fn process_command_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root_value = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };

    // The registry resolves which command actually runs (builtin shell input
    // vs a dynamic tool's template) — tool identity is its data, not ours.
    // Default 180s; configurable for long builds.
    let invocation = match tools::command_invocation(
        call,
        root_value,
        ctx.request.command_timeout_secs.unwrap_or(180),
    ) {
        Ok(invocation) => invocation,
        Err(result) => return Ok(ToolOutcome::Produced(result)),
    };
    let tools::CommandInvocation {
        tool_name: permission_tool_name,
        command,
        cwd,
        timeout_secs,
        summary: permission_summary,
        reason,
    } = invocation;

    let approval_key = if cwd == root_value {
        command.clone()
    } else {
        format!("{cwd} :: {command}")
    };
    let preflight = preflight_command(root_value, &cwd, &command);
    // Wildcard allowlist rules are intentionally narrower than exact approvals:
    // if a wildcard command references outside-workspace paths, ask again so the
    // path is visible to the user instead of hidden behind a broad pattern. That
    // nuance is command-specific, so the project verdict is computed here and
    // handed to the engine as a plain bool.
    let matched_rule =
        command_allowlist::match_rule(&ctx.request.command_allowlist, &command, &approval_key);
    let project_ok = matched_rule
        .as_ref()
        .map(|rule| rule.exact || preflight.external_paths.is_empty())
        .unwrap_or(false);
    // The full-auto rung: the user chose to run this conversation's commands
    // without prompts. Same trust as a project-allowlist hit, but scoped to
    // the run request — nothing is persisted, and a rejection remembered from
    // before the user escalated no longer blocks (escalating IS the override).
    let full_auto = ctx.request.auto_approve_commands == Some(true);

    match permission::precheck(
        ctx,
        permission::Capability::Command,
        &approval_key,
        project_ok || full_auto,
    ) {
        permission::Precheck::Execute => {
            return Ok(ToolOutcome::Produced(
                run_command_announcing_artifacts(
                    ctx,
                    root_value,
                    &cwd,
                    &command,
                    timeout_secs,
                    emit,
                )
                .await?,
            ));
        }
        permission::Precheck::AutoReject(msg) => {
            return Ok(ToolOutcome::Produced(ToolResult {
                ok: false,
                content: msg.to_string(),
                metadata: None,
            }));
        }
        permission::Precheck::Ask => {}
    }

    let external_paths = preflight.external_paths.clone();
    let mut permission_reason = reason;
    if !external_paths.is_empty() {
        permission_reason.push_str(" It references paths outside the workspace: ");
        permission_reason.push_str(&external_paths.join(", "));
        permission_reason.push('.');
    }
    if let Some(rule) = matched_rule.as_ref() {
        permission_reason.push_str(&format!(
            " Project rule `{}` matched, but this command still needs approval.",
            rule.pattern
        ));
    }

    let perm = PermissionRequest {
        id: permission::request_id(ctx, call),
        run_id: ctx.id.to_string(),
        tool_call_id: call.id.clone(),
        tool_name: permission_tool_name.to_string(),
        input: serde_json::json!({
            "command": command,
            "cwd": cwd,
            "externalPaths": external_paths,
            "matchedAllowRule": matched_rule.as_ref().map(|rule| rule.pattern.clone())
        }),
        summary: permission_summary,
        reason: permission_reason,
        options: standard_gate_options("Approve for this run", "Approve for this project"),
    };

    let decision = match permission::run_gate(ctx, call, perm, emit).await? {
        permission::GateDecision::Cancelled => return Ok(ToolOutcome::Cancelled),
        decision => decision,
    };
    permission::record(
        ctx,
        permission::Capability::Command,
        &approval_key,
        &command,
        &decision,
    );

    let result = match decision {
        permission::GateDecision::Approved { .. } => {
            run_command_announcing_artifacts(ctx, root_value, &cwd, &command, timeout_secs, emit)
                .await?
        }
        _ => ToolResult {
            ok: false,
            content: permission::Capability::Command
                .rejected_message()
                .to_string(),
            metadata: None,
        },
    };
    Ok(ToolOutcome::Produced(result))
}

pub(super) struct NetworkInvocation {
    pub(super) target: String,
    pub(super) summary: String,
    pub(super) reason: String,
    pub(super) input: serde_json::Value,
}

const NETWORK_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Web Tools use reqwest's blocking client because the registry's read seam is
/// synchronous. Keep that work off the async Harness thread: reqwest panics if
/// its blocking runtime is dropped from an async context. Join failures and a
/// DNS/request that outlives the bound become ordinary Tool errors, allowing
/// the Harness to emit ToolCallFinished and continue the Run.
async fn execute_network_tool(root: &str, call: &NormalizedToolCall, run_id: &str) -> ToolResult {
    let root = root.to_string();
    let call = call.clone();
    let run_id = run_id.to_string();
    let task = tokio::task::spawn_blocking(move || execute_read_only_tool(&root, &call, &run_id));

    match tokio::time::timeout(NETWORK_TOOL_TIMEOUT, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => ToolResult {
            ok: false,
            content: format!("Network tool failed unexpectedly: {error}"),
            metadata: None,
        },
        Err(_) => ToolResult {
            ok: false,
            content: format!(
                "Network tool timed out after {} seconds.",
                NETWORK_TOOL_TIMEOUT.as_secs()
            ),
            metadata: None,
        },
    }
}

pub(super) fn network_invocation(
    call: &NormalizedToolCall,
) -> Result<NetworkInvocation, ToolResult> {
    match call.name.as_str() {
        "web_search" => {
            let query = call
                .input
                .get("query")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ToolResult {
                    ok: false,
                    content: "web_search requires a query.".to_string(),
                    metadata: None,
                })?;
            Ok(NetworkInvocation {
                target: "web_search".to_string(),
                summary: format!("web_search {query}"),
                reason: "The agent wants to search the web.".to_string(),
                input: serde_json::json!({
                    "query": query,
                    "target": "web_search"
                }),
            })
        }
        "web_fetch" => {
            let url = call
                .input
                .get("url")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ToolResult {
                    ok: false,
                    content: "web_fetch requires a url.".to_string(),
                    metadata: None,
                })?;
            let parsed = reqwest::Url::parse(url).map_err(|e| ToolResult {
                ok: false,
                content: format!("web_fetch requires a valid URL: {e}"),
                metadata: None,
            })?;
            let host = parsed.host_str().ok_or_else(|| ToolResult {
                ok: false,
                content: "web_fetch URL must include a host.".to_string(),
                metadata: None,
            })?;
            let host = host.to_ascii_lowercase();
            Ok(NetworkInvocation {
                target: format!("host:{host}"),
                summary: format!("web_fetch {host}"),
                reason: format!("The agent wants to fetch content from {host}."),
                input: serde_json::json!({
                    "url": url,
                    "host": host,
                    "target": format!("host:{host}")
                }),
            })
        }
        _ => Ok(NetworkInvocation {
            target: format!("tool:{}", call.name),
            summary: call.name.clone(),
            reason: "The agent wants to use a network-capability tool.".to_string(),
            input: serde_json::json!({
                "target": format!("tool:{}", call.name)
            }),
        }),
    }
}

pub(super) async fn process_network_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root_value = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };
    let invocation = match network_invocation(call) {
        Ok(invocation) => invocation,
        Err(result) => return Ok(ToolOutcome::Produced(result)),
    };
    let target = invocation.target.clone();
    let project_ok =
        network_allowlist::is_allowed(ctx.runs_dir, root_value, &target).unwrap_or(false);

    match permission::precheck(ctx, permission::Capability::Network, &target, project_ok) {
        permission::Precheck::Execute => {
            return Ok(ToolOutcome::Produced(
                execute_network_tool(root_value, call, ctx.id).await,
            ));
        }
        permission::Precheck::AutoReject(msg) => {
            return Ok(ToolOutcome::Produced(ToolResult {
                ok: false,
                content: msg.to_string(),
                metadata: None,
            }));
        }
        permission::Precheck::Ask => {}
    }

    let perm = PermissionRequest {
        id: permission::request_id(ctx, call),
        run_id: ctx.id.to_string(),
        tool_call_id: call.id.clone(),
        tool_name: call.name.clone(),
        input: invocation.input.clone(),
        summary: invocation.summary.clone(),
        reason: invocation.reason.clone(),
        options: standard_gate_options(
            "Approve target for this run",
            "Approve target for this project",
        ),
    };

    let decision = match permission::run_gate(ctx, call, perm, emit).await? {
        permission::GateDecision::Cancelled => return Ok(ToolOutcome::Cancelled),
        decision => decision,
    };
    permission::record(
        ctx,
        permission::Capability::Network,
        &target,
        &target,
        &decision,
    );

    let result = match decision {
        permission::GateDecision::Approved { .. } => {
            execute_network_tool(root_value, call, ctx.id).await
        }
        _ => ToolResult {
            ok: false,
            content: permission::Capability::Network
                .rejected_message()
                .to_string(),
            metadata: None,
        },
    };
    Ok(ToolOutcome::Produced(result))
}

/// Write tool (`write_file`, `create_file`): preview the edit as a diff, pass it
/// through the diff-review gate (or auto-apply when review is off), and on
/// "apply" write the file, save a checkpoint for rollback, and run the
/// optional test-after-edit command. A byte-identical re-proposal of an
/// already-rejected change is auto-declined. Cancelling during review bubbles
/// up as `Cancelled`.
/// Parse a resolved diff decision. The channel carries either a bare behavior
/// string ("apply" / "reject" — also the pause's cancellation default) or the
/// frontend's full decision JSON `{"behavior": "...", "note": "...", "scope":
/// "..."}` where `note` is the user's review feedback and `scope: "run"` is
/// "Validate all" — apply this edit and every later one this run. Tolerates
/// every shape; unknown shapes read as a plain rejection.
pub(super) fn parse_diff_decision(raw: &str) -> (String, Option<String>, bool) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(obj) = value.as_object() {
            let behavior = obj
                .get("behavior")
                .and_then(|b| b.as_str())
                .unwrap_or("reject")
                .to_string();
            let note = obj
                .get("note")
                .and_then(|n| n.as_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string);
            let apply_all =
                behavior == "apply" && obj.get("scope").and_then(|s| s.as_str()) == Some("run");
            return (behavior, note, apply_all);
        }
        if let Some(s) = value.as_str() {
            return (s.to_string(), None, false);
        }
    }
    (raw.to_string(), None, false)
}

pub(super) async fn process_write_tool<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let root = match ctx.request.workspace_root.as_deref() {
        Some(root) => root,
        None => return Ok(ToolOutcome::Produced(no_workspace_result())),
    };

    let proposal = match execute_write_tool_preview(root, call, ctx.id) {
        Ok(p) => p,
        Err(error_result) => return Ok(ToolOutcome::Produced(error_result)),
    };

    // Identical to a change the user already rejected this run? (Same path +
    // same resulting content.) Auto-decline without a second diff prompt so one
    // "Reject" sticks; tell the model to change course rather than re-surfacing
    // the same diff.
    let edit_key = format!("{}::{}", proposal.path, proposal.new_hash);
    let already_rejected = permission::write_already_rejected(ctx, &edit_key);
    if already_rejected {
        return Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content: format!(
                "You already proposed this exact change to {} and the user rejected it. \
Do not propose it again — take a different approach or ask the user what they'd prefer.",
                proposal.path
            ),
            metadata: None,
        }));
    }

    // Auto-accept — the run started with review off, or "Validate all" was
    // chosen at an earlier diff this run: apply without pausing. Still emit
    // the proposed diff so the edit stays visible in the conversation, and
    // the checkpoint written below keeps it revertable — which is what makes
    // auto-accept safe. Otherwise pause for diff review.
    let decision =
        if ctx.request.require_diff_review == Some(false) || permission::edits_auto_applied(ctx) {
            emit(AgentEvent::DiffProposed {
                run_id: ctx.id.to_string(),
                proposal: proposal.clone(),
                ts: now_ms(),
            })?;
            "apply".to_string()
        } else {
            match pause_for_user(
                ctx.sup,
                ctx.id,
                AgentRunStatus::WaitingForDiff,
                AgentEvent::DiffProposed {
                    run_id: ctx.id.to_string(),
                    proposal: proposal.clone(),
                    ts: now_ms(),
                },
                "reject",
                ctx.cancel,
                emit,
                |handle, tx| {
                    *handle.pending_diff.lock().unwrap() = Some(tx);
                },
            )
            .await?
            {
                PauseOutcome::Cancelled => return Ok(ToolOutcome::Cancelled),
                PauseOutcome::Resolved(decision) => decision,
            }
        };

    let (behavior, note, apply_all) = parse_diff_decision(&decision);
    // "Validate all": this approval covers every later edit of the run, so the
    // next proposal auto-applies instead of pausing. Recorded before the event
    // so the transcript's decision says what was actually granted.
    if apply_all {
        permission::remember_edits_auto_apply(ctx);
    }
    let mut decision_obj = serde_json::json!({ "behavior": behavior });
    if let Some(n) = &note {
        decision_obj["note"] = serde_json::json!(n);
    }
    if apply_all {
        decision_obj["scope"] = serde_json::json!("run");
    }
    emit(AgentEvent::DiffResolved {
        run_id: ctx.id.to_string(),
        proposal_id: proposal.id.clone(),
        decision: decision_obj.clone(),
        ts: now_ms(),
    })?;

    if behavior == "apply" {
        match apply_write(root, &proposal) {
            Ok(result) => {
                let mut tool_result = result;
                // Save checkpoint for rollback. Serialize through
                // CheckpointEntry so the saved shape always matches what
                // agent_list_checkpoints deserializes.
                // Through the same two helpers the readers use. The writer used
                // to rebuild both paths by hand, 1130 lines from the functions
                // that define them, so the checkpoint format had two spellers.
                let checkpoint_dir = checkpoint_dir(ctx.runs_dir, ctx.id);
                let _ = std::fs::create_dir_all(&checkpoint_dir);
                let checkpoint_file = checkpoint_file(ctx.runs_dir, ctx.id, &proposal.tool_call_id);
                let entry = CheckpointEntry {
                    tool_call_id: proposal.tool_call_id.clone(),
                    path: proposal.path.clone(),
                    old_content: proposal.old_content.clone(),
                    new_content: proposal.new_content.clone(),
                    is_create: proposal.is_create,
                    workspace_root: root.to_string(),
                    ts: now_ms(),
                };
                if let Ok(json) = serde_json::to_string(&entry) {
                    let _ = std::fs::write(&checkpoint_file, json);
                }
                let timeout_secs = ctx
                    .request
                    .command_timeout_secs
                    .unwrap_or(180)
                    .clamp(1, 1800);
                run_test_after_edit(
                    root,
                    ctx.request.test_after_edit_command.as_deref(),
                    timeout_secs,
                    &mut tool_result,
                )
                .await;
                emit(AgentEvent::FileChanged {
                    run_id: ctx.id.to_string(),
                    path: proposal.path.clone(),
                    old_hash: proposal.old_hash.clone(),
                    new_hash: proposal.new_hash.clone(),
                    ts: now_ms(),
                })?;
                Ok(ToolOutcome::Produced(tool_result))
            }
            Err(result) => Ok(ToolOutcome::Produced(result)),
        }
    } else {
        // Remember this rejection so a byte-identical re-proposal is
        // auto-declined above instead of prompting again. (A revised edit
        // addressing the feedback hashes differently, so it prompts normally.)
        permission::remember_write_rejection(ctx, &edit_key);
        let verb = if proposal.is_create {
            "created"
        } else {
            "changed"
        };
        let content = match note {
            // Review feedback turns the rejection into steering: tell the
            // model to revise toward the note instead of abandoning course.
            Some(note) => format!(
                "The user reviewed this change to {} and rejected it with feedback:\n\
{note}\n\n\
The file was not {verb}. Revise the change to address the feedback (or ask \
the user if it's unclear) — do not re-propose the same edit unchanged.",
                proposal.path
            ),
            None => format!(
                "Rejected by user: {} was not {verb}. Do not propose this exact change again — \
take a different approach or ask the user what they'd prefer.",
                proposal.path
            ),
        };
        Ok(ToolOutcome::Produced(ToolResult {
            ok: false,
            content,
            metadata: None,
        }))
    }
}
