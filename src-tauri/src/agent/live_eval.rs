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
