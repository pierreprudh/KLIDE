//! Harness eval — golden scenarios for the agent's tool layer.
//!
//! These are the regression net the audit flagged as missing. Each scenario is
//! a fixture workspace plus a scripted sequence of tool calls (what a model
//! *would* emit) run through the **real** execution path — `execute_read_only_tool`,
//! `execute_write_tool_preview` + `apply_write`, `run_command_capture` — and
//! then asserted against the resulting workspace + tool results.
//!
//! Scope: this evals the harness's **deterministic** behavior (do reads/edits/
//! commands do the right thing, in sequence?) without a live model. The
//! model-in-loop layer ("does the agent *choose* the right tools to complete a
//! task?") needs the run loop decoupled from `tauri::AppHandle` + a mockable
//! provider — that's the next layer; this is the foundation it will reuse.
//!
//! Add a scenario: append a `Scenario` to `scenarios()` with its fixture files,
//! steps, and an `expect` closure. It runs automatically as a `cargo test`.

#![cfg(test)]

use super::tools::{
    apply_write, execute_read_only_tool, execute_write_tool_preview, run_command_capture,
    NormalizedToolCall,
};
use super::types::ToolResult;

/// One scripted tool call. `write_file` / `create_file` are auto-applied (the
/// eval stands in for the user approving the diff); `run_command` is run
/// directly (the eval stands in for approval).
struct Step {
    tool: &'static str,
    input: serde_json::Value,
}

/// A golden scenario: a fixture workspace, the tool calls to run against it,
/// and an assertion over the results + final file contents.
struct Scenario {
    name: &'static str,
    /// Initial files, workspace-relative path → contents.
    files: &'static [(&'static str, &'static str)],
    steps: Vec<Step>,
    /// Asserts on `(results, read_file)` where `results[i]` is step i's tool
    /// result and `read_file(path)` returns the final on-disk contents.
    expect: fn(results: &[ToolResult], read_file: &dyn Fn(&str) -> Option<String>),
}

fn call(tool: &str, input: serde_json::Value) -> NormalizedToolCall {
    NormalizedToolCall {
        id: format!("eval_{tool}"),
        name: tool.to_string(),
        input,
    }
}

/// Run one scenario end-to-end against a fresh temp workspace.
async fn run_scenario(scenario: &Scenario) {
    let dir = std::env::temp_dir().join(format!(
        "klide-eval-{}-{}",
        scenario.name.replace(' ', "_"),
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for (rel, contents) in scenario.files {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, contents).unwrap();
    }
    let root = dir.to_str().unwrap().to_string();
    let run_id = format!("eval-{}", scenario.name);

    let mut results: Vec<ToolResult> = Vec::new();
    for step in &scenario.steps {
        let c = call(step.tool, step.input.clone());
        let result = match step.tool {
            "run_command" => {
                let command = step.input.get("command").and_then(|v| v.as_str()).unwrap_or("");
                run_command_capture(&root, command, 30).await
            }
            "write_file" | "create_file" => {
                // Preview then auto-apply — the eval stands in for the user
                // approving the diff in the real flow.
                match execute_write_tool_preview(&root, &c, &run_id) {
                    Ok(proposal) => match apply_write(&root, &proposal) {
                        Ok(r) | Err(r) => r,
                    },
                    Err(r) => r,
                }
            }
            _ => execute_read_only_tool(&root, &c, &run_id),
        };
        results.push(result);
    }

    let read_root = root.clone();
    let read_file = move |rel: &str| std::fs::read_to_string(format!("{read_root}/{rel}")).ok();
    (scenario.expect)(&results, &read_file);

    let _ = std::fs::remove_dir_all(&dir);
}

fn scenarios() -> Vec<Scenario> {
    vec![
        // Read → edit → verify the edit landed via a command.
        Scenario {
            name: "edit-and-verify",
            files: &[("greeting.txt", "hello world\n")],
            steps: vec![
                Step { tool: "read_file", input: serde_json::json!({ "path": "greeting.txt" }) },
                Step {
                    tool: "write_file",
                    input: serde_json::json!({
                        "path": "greeting.txt",
                        "old_str": "hello world",
                        "new_str": "hello klide",
                    }),
                },
                Step { tool: "run_command", input: serde_json::json!({ "command": "cat greeting.txt" }) },
            ],
            expect: |results, read_file| {
                assert!(results[0].content.contains("hello world"), "read shows original");
                assert!(results[1].ok, "edit applied: {}", results[1].content);
                assert_eq!(read_file("greeting.txt").as_deref(), Some("hello klide\n"));
                assert!(results[2].ok, "verify command ran");
                assert!(results[2].content.contains("hello klide"), "command sees the edit");
            },
        },
        // Create a new file, then confirm it exists with a command.
        Scenario {
            name: "create-file",
            files: &[],
            steps: vec![
                Step {
                    tool: "create_file",
                    input: serde_json::json!({ "path": "notes/todo.md", "contents": "- ship it\n" }),
                },
                Step { tool: "run_command", input: serde_json::json!({ "command": "test -f notes/todo.md && echo EXISTS" }) },
            ],
            expect: |results, read_file| {
                assert!(results[0].ok, "create applied: {}", results[0].content);
                assert_eq!(read_file("notes/todo.md").as_deref(), Some("- ship it\n"));
                assert!(results[1].ok && results[1].content.contains("EXISTS"), "file is on disk");
            },
        },
        // A failing command surfaces as not-ok so the model can react.
        Scenario {
            name: "command-failure-is-visible",
            files: &[("a.txt", "x\n")],
            steps: vec![
                Step { tool: "grep", input: serde_json::json!({ "pattern": "x", "path": "a.txt" }) },
                Step { tool: "run_command", input: serde_json::json!({ "command": "exit 7" }) },
            ],
            expect: |results, _read_file| {
                assert!(results[0].content.contains("a.txt"), "grep found the file");
                assert!(!results[1].ok, "failing command is not ok");
                assert!(results[1].content.contains("exit 7"), "exit code surfaced");
            },
        },
    ]
}

#[tokio::test]
async fn golden_scenarios_pass() {
    for scenario in scenarios() {
        run_scenario(&scenario).await;
    }
}
