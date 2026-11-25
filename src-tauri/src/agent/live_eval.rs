//! Opt-in, paid smoke evaluation of the production loop and provider adapter.
//! This synthetic file task is not Terminal-Bench and does not measure shell use.
use super::test_support::{test_request, FakeSupervisor};
use super::*;

#[tokio::test]
#[ignore = "Paid OpenRouter request; run explicitly with OPENROUTER_API_KEY"]
async fn openrouter_flash_smoke() {
    assert!(
        std::env::var("OPENROUTER_API_KEY").is_ok(),
        "Set OPENROUTER_API_KEY"
    );
    let base = PathBuf::from(
        std::env::var("KLIDE_EVAL_OUTPUT_DIR")
            .expect("Set KLIDE_EVAL_OUTPUT_DIR to a private evaluation results directory"),
    )
    .join(format!("flash-{}-{}", now_ms(), std::process::id()));
    let workspace = base.join("workspace");
    let runs = base.join("runs");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&runs).unwrap();
    std::fs::write(
        workspace.join("orders.json"),
        r#"[
      {"customer":"Ada","status":"paid","cents":1250},
      {"customer":"Lin","status":"cancelled","cents":9000},
      {"customer":"Ada","status":"refunded","cents":250},
      {"customer":"Lin","status":"paid","cents":500},
      {"customer":"Ada","status":"paid","cents":100},
      {"customer":"Zoe","status":"paid","cents":0}
    ]"#,
    )
    .unwrap();
    let root = workspace.to_str().unwrap();
    let mut request = test_request(root, &[]);
    request.provider = "openrouter".into();
    request.model = "deepseek/deepseek-v4.1-flash".into();
    request.max_turns = Some(4);
    request.system_prompt = Some(format!(
        "You are Klide's coding agent. Workspace: {root}. Complete the task using the available file tools. Edits in this disposable evaluation workspace are pre-approved. Be concise."
    ));
    request.initial_text = "Read orders.json and create summary.json containing a JSON array sorted by customer name. Each object must have exactly customer, net_cents, paid_count. Add paid cents, subtract refunded cents, ignore cancelled orders. paid_count counts only paid orders, including zero-valued ones. Include customers with paid or refunded orders. Write the actual file, then finish.".into();
    let allowed = ["read_file", "list_dir", "create_file", "write_file"];
    request.disabled_tools = tools::tool_catalog(&AgentMode::Goal)
        .into_iter()
        .filter(|t| !allowed.contains(&t.name.as_str()))
        .map(|t| t.name)
        .collect();
    let id = "flash-smoke";
    let supervisor = Arc::new(FakeSupervisor::for_request(id, &request));
    let cancel = CancellationToken::new();
    let start = std::time::Instant::now();
    let future = run_agent_loop(
        supervisor,
        runs.clone(),
        id.into(),
        request,
        Channel::new(|_| Ok(())),
        cancel.clone(),
        RealProviderCaller,
    );
    tokio::pin!(future);
    let outcome = tokio::select! {
        result = &mut future => result,
        _ = tokio::time::sleep(std::time::Duration::from_secs(180)) => {
            cancel.cancel();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), &mut future).await;
            Err("Evaluation exceeded 180 seconds".into())
        }
    };
    let actual = std::fs::read(workspace.join("summary.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let expected = serde_json::json!([
        {"customer":"Ada","net_cents":1100,"paid_count":2},
        {"customer":"Lin","net_cents":500,"paid_count":1},
        {"customer":"Zoe","net_cents":0,"paid_count":1}
    ]);
    let events = read_events(&runs, id).unwrap_or_default();
    let usage: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::AssistantMessage { usage: Some(u), .. } => Some(u),
            _ => None,
        })
        .collect();
    let tokens = |input: bool| -> Option<u64> {
        if usage.is_empty() {
            return None;
        }
        usage
            .iter()
            .map(|u| {
                if input {
                    u.prompt_tokens
                } else {
                    u.completion_tokens
                }
            })
            .collect::<Option<Vec<_>>>()
            .map(|v| v.iter().sum())
    };
    let cost = if usage.is_empty() {
        None
    } else {
        usage
            .iter()
            .map(|u| u.cost_usd)
            .collect::<Option<Vec<_>>>()
            .map(|v| v.iter().sum::<f64>())
    };
    let passed = actual.as_ref() == Some(&expected);
    let report = serde_json::json!({
        "task": "order-summary-v1", "benchmark": "Klide synthetic smoke (not Terminal-Bench)",
        "model": "deepseek/deepseek-v4.1-flash", "provider": "openrouter",
        "passed": passed, "elapsed_seconds": start.elapsed().as_secs_f64(),
        "input_tokens": tokens(true), "output_tokens": tokens(false),
        "recorded_cost_usd": cost, "provider_turns_with_usage": usage.len(),
        "tool_calls": events.iter().filter(|e| matches!(e, AgentEvent::ToolCallStarted { .. })).count(),
        "harness_error": outcome.err(), "actual": actual, "expected": expected,
        "max_turns": 4, "timeout_seconds": 180, "allowed_tools": allowed,
    });
    std::fs::write(
        base.join("result.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("Evaluation report: {}", base.join("result.json").display());
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    assert!(
        passed,
        "Grader failed; inspect result.json and the run transcript"
    );
}

/// Benchmark entry point for scripts/harness-bench/run.py. Uses the production
/// provider and Harness; the Python driver owns fixtures and independent grading.
#[tokio::test]
#[ignore = "Live model benchmark; invoke through scripts/harness-bench/run.py"]
async fn paired_harness_benchmark() {
    let base = PathBuf::from(std::env::var("KLIDE_BENCH_CASE").expect("KLIDE_BENCH_CASE"));
    let case: serde_json::Value = serde_json::from_slice(&std::fs::read(base.join("case.json")).unwrap()).unwrap();
    let workspace = base.join("workspace");
    let runs = base.join("runs");
    std::fs::create_dir_all(&runs).unwrap();
    let mut request = test_request(workspace.to_str().unwrap(), &[]);
    request.provider = case["provider"].as_str().unwrap().into();
    request.model = case["model"].as_str().unwrap().into();
    request.initial_text = case["prompt"].as_str().unwrap().into();
    request.max_turns = Some(30);
    request.auto_approve_commands = Some(true);
    request.system_prompt = Some(format!("You are Klide's coding agent. Workspace: {}. Complete the requested task and verify the result. Edits and commands in this disposable benchmark workspace are pre-approved.", workspace.display()));
    let id = "paired-benchmark";
    let supervisor = Arc::new(FakeSupervisor::for_request(id, &request));
    let cancel = CancellationToken::new();
    let started = std::time::Instant::now();
    let future = run_agent_loop(supervisor, runs.clone(), id.into(), request,
        Channel::new(|_| Ok(())), cancel.clone(), RealProviderCaller);
    tokio::pin!(future);
    let outcome = tokio::select! {
        result = &mut future => result,
        _ = tokio::time::sleep(std::time::Duration::from_secs(case["timeoutSeconds"].as_u64().unwrap_or(180))) => {
            cancel.cancel();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), &mut future).await;
            Err("Benchmark timed out".into())
        }
    };
    let events = read_events(&runs, id).unwrap_or_default();
    let provider_usages: Vec<_> = events.iter().filter_map(|e| match e {
        AgentEvent::AssistantMessage { usage, timing: Some(_), .. } => Some(usage.as_ref()), _ => None,
    }).collect();
    let engine_ms = |prompt| complete_usage_sum(&provider_usages, |u| if prompt { u.prompt_eval_duration_ms } else { u.eval_duration_ms });
    let cost = complete_usage_sum(&provider_usages, |u| u.cost_usd);
    let tokens = |input| complete_usage_sum(&provider_usages, |u| if input { u.prompt_tokens } else { u.completion_tokens });
    std::fs::write(base.join("native-result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "elapsedSeconds":started.elapsed().as_secs_f64(),"error":outcome.err(),
        "inputTokens":tokens(true),"outputTokens":tokens(false),"costUsd":cost,
        "enginePromptMs":engine_ms(true),"engineGenerationMs":engine_ms(false),
        "toolCalls":events.iter().filter(|e| matches!(e, AgentEvent::ToolCallStarted {..})).count(),
        "permissionRequests":events.iter().filter(|e| matches!(e, AgentEvent::PermissionRequested {..})).count(),
        "transcript":super::transcripts::transcript_path(&runs, id),
    })).unwrap()).unwrap();
}

/// Code Mode on/off benchmark entry point for scripts/harness-bench/code_mode.py.
/// One trial: the production Harness in Plan mode (reads only, so neither arm
/// can shell out), with `run_script` offered or not according to
/// `KLIDE_CODE_MODE`, which the driver sets per trial. The driver owns the
/// fixtures, arm order and grading; this writes what the Transcript recorded.
#[tokio::test]
#[ignore = "Live model benchmark; invoke through scripts/harness-bench/code_mode.py"]
async fn code_mode_benchmark() {
    let base = PathBuf::from(std::env::var("KLIDE_BENCH_CASE").expect("KLIDE_BENCH_CASE"));
    let case: serde_json::Value = serde_json::from_slice(&std::fs::read(base.join("case.json")).unwrap()).unwrap();
    let workspace = base.join("workspace");
    let runs = base.join("runs");
    std::fs::create_dir_all(&runs).unwrap();
    let mut request = test_request(workspace.to_str().unwrap(), &[]);
    request.mode = AgentMode::Plan;
    request.provider = case["provider"].as_str().unwrap().into();
    request.model = case["model"].as_str().unwrap().into();
    request.initial_text = case["prompt"].as_str().unwrap().into();
    request.max_turns = case["maxTurns"].as_u64().map(|n| n as usize);
    request.num_ctx = case["numCtx"].as_u64().map(|n| n as usize);
    request.num_predict = case["numPredict"].as_u64().map(|n| n as usize);
    request.max_parallel_tools = case["maxParallelTools"].as_u64().map(|n| n as usize);
    request.reflection_level = case["reflectionLevel"].as_str().map(str::to_string);
    request.system_prompt = Some(format!(
        "You are Klide's coding agent. Workspace: {}. Answer the question from the workspace files. Finish with the requested JSON and nothing after it.",
        workspace.display()
    ));
    // Which arm this trial really is, read from the same gate a Run uses —
    // never assumed from the driver's label.
    let gate = permission::GateSubject::from_request(&request);
    let (offered, read_many_offered) = (gate.script_offered, gate.read_many_offered);
    let id = "code-mode-benchmark";
    let supervisor = Arc::new(FakeSupervisor::for_request(id, &request));
    let cancel = CancellationToken::new();
    let started = std::time::Instant::now();
    let future = run_agent_loop(supervisor, runs.clone(), id.into(), request,
        Channel::new(|_| Ok(())), cancel.clone(), RealProviderCaller);
    tokio::pin!(future);
    let outcome = tokio::select! {
        result = &mut future => result,
        _ = tokio::time::sleep(std::time::Duration::from_secs(case["timeoutSeconds"].as_u64().unwrap_or(180))) => {
            cancel.cancel();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), &mut future).await;
            Err("Benchmark timed out".into())
        }
    };
    let elapsed = started.elapsed().as_secs_f64();
    let events = read_events(&runs, id).unwrap_or_default();
    let provider_usages: Vec<_> = events.iter().filter_map(|e| match e {
        AgentEvent::AssistantMessage { usage, timing: Some(_), .. } => Some(usage.as_ref()), _ => None,
    }).collect();
    let script_ids: Vec<&str> = events.iter().filter_map(|e| match e {
        AgentEvent::ToolCallStarted { tool_call_id, name, .. } if name == super::script::RUN_SCRIPT_TOOL => Some(tool_call_id.as_str()),
        _ => None,
    }).collect();
    let nested: usize = events.iter().filter_map(|e| match e {
        AgentEvent::ToolCallFinished { tool_call_id, result, .. } if script_ids.contains(&tool_call_id.as_str()) => {
            result.metadata.as_ref().and_then(|m| m["scriptCalls"].as_array()).map(Vec::len)
        }
        _ => None,
    }).sum();
    // The run's last reply, as sent. Falling back to an earlier non-empty one
    // reported empty final turns as "the model stopped after its preamble"
    // (2026-11-16); an empty last reply is recorded as null.
    let final_answer = events.iter().rev().find_map(|e| match e {
        AgentEvent::AssistantMessage { content, timing: Some(_), .. } => Some(content.iter().filter_map(|b| match b {
            AgentContentBlock::Text { text } => Some(text.as_str()), _ => None,
        }).collect::<String>()),
        _ => None,
    }).filter(|text| !text.trim().is_empty());
    let status = super::transcripts::read_summary(&runs, id).ok().map(|s| s.status);
    let sum = |f: fn(&AgentUsage) -> Option<u64>| complete_usage_sum(&provider_usages, f);
    std::fs::write(base.join("native-result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "elapsedSeconds": elapsed, "error": outcome.err(), "codeModeOffered": offered, "readManyOffered": read_many_offered,
        "readManyCalls": events.iter().filter(|e| matches!(e, AgentEvent::ToolCallStarted { name, .. } if name == super::read_many::READ_MANY_TOOL)).count(),
        "inputTokens": sum(|u| u.prompt_tokens), "outputTokens": sum(|u| u.completion_tokens),
        "cacheReadTokens": sum(|u| u.cache_read_tokens),
        "costUsd": complete_usage_sum(&provider_usages, |u| u.cost_usd),
        "modelRequests": provider_usages.len(),
        "toolCalls": events.iter().filter(|e| matches!(e, AgentEvent::ToolCallStarted {..})).count(),
        "scriptCalls": script_ids.len(), "nestedToolCalls": nested,
        "finalAnswer": final_answer, "status": status,
        "transcript": super::transcripts::transcript_path(&runs, id),
    })).unwrap()).unwrap();
}

fn complete_usage_sum<T: std::iter::Sum<T>>(
    usages: &[Option<&AgentUsage>], field: impl Fn(&AgentUsage) -> Option<T>,
) -> Option<T> {
    if usages.is_empty() { return None; }
    usages.iter().map(|usage| usage.and_then(&field)).collect::<Option<Vec<_>>>()
        .map(|values| values.into_iter().sum())
}

#[test]
fn missing_turn_usage_cannot_produce_partial_totals() {
    let known = AgentUsage { prompt_tokens: Some(10), cost_usd: Some(0.5), ..Default::default() };
    let unknown = AgentUsage::default();
    assert_eq!(complete_usage_sum(&[Some(&known), Some(&known)], |u| u.prompt_tokens), Some(20));
    assert_eq!(complete_usage_sum(&[Some(&known), None], |u| u.prompt_tokens), None);
    assert_eq!(complete_usage_sum(&[Some(&known), Some(&unknown)], |u| u.cost_usd), None);
    assert_eq!(complete_usage_sum(&[], |u| u.prompt_tokens), None);
}
