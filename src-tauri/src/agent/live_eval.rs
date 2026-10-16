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
    let usages: Vec<_> = events.iter().filter_map(|e| match e { AgentEvent::AssistantMessage { usage: Some(u), .. } => Some(u), _ => None }).collect();
    let costs: Option<Vec<f64>> = if usages.is_empty() { None } else { usages.iter().map(|u| u.cost_usd).collect() };
    let tokens = |input| -> Option<u64> {
        if usages.is_empty() { return None; }
        usages.iter().map(|u| if input {u.prompt_tokens} else {u.completion_tokens}).collect::<Option<Vec<_>>>().map(|v| v.iter().sum())
    };
    std::fs::write(base.join("native-result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "elapsedSeconds":started.elapsed().as_secs_f64(),"error":outcome.err(),
        "inputTokens":tokens(true),"outputTokens":tokens(false),"costUsd":costs.map(|v| v.iter().sum::<f64>()),
        "toolCalls":events.iter().filter(|e| matches!(e, AgentEvent::ToolCallStarted {..})).count(),
        "permissionRequests":events.iter().filter(|e| matches!(e, AgentEvent::PermissionRequested {..})).count(),
        "transcript":super::transcripts::transcript_path(&runs, id),
    })).unwrap()).unwrap();
}
