//! One-shot headless chat with a subscription delegate CLI.
//!
//! The AI panel's "subscription" providers (Claude Code, Codex, OpenCode, Omp)
//! don't stream over a wire API — they run the CLI once with the prompt on
//! stdin and read plain text back. Building the command is the adapter's job
//! (`Delegate::chat_invocation`); this module owns the rest — folding the
//! conversation into a prompt, running the process, and streaming its output.
//! Keeping it here means the whole one-shot-chat operation lives behind the
//! Delegate seam instead of being split across the lib.rs IPC glue.

use std::process::Stdio;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use super::Delegate;
use crate::{text_from_message, AiChatResponse, StreamChunk};

/// Run one headless chat turn against a subscription delegate CLI: fold the
/// conversation into a prompt, spawn the adapter's chat invocation, stream its
/// output back, and wrap the result. The single entry the `ai_chat` dispatcher
/// calls for the subscription path.
pub async fn run_subscription_chat(
    adapter: &dyn Delegate,
    label: &str,
    model: String,
    messages: Vec<serde_json::Value>,
    workspace_root: Option<String>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let prompt = prompt_from_messages(&messages);
    let cwd = workspace_root.unwrap_or_else(|| ".".to_string());
    // The "default" sentinel means "no model picked" — hand the adapter an
    // empty model so it omits its model flag and the CLI uses its own default.
    let model = model.trim();
    let model = if model.eq_ignore_ascii_case(super::CLI_DEFAULT_MODEL) {
        ""
    } else {
        model
    };
    let command = adapter.chat_invocation(&cwd, model)?;
    let content = run_cli_with_stdin(command, prompt, label, on_chunk).await?;
    Ok(AiChatResponse {
        content,
        thinking: None,
        tool_calls: Vec::new(),
        usage: None,
        stop_reason: None,
    })
}

fn prompt_from_messages(messages: &[serde_json::Value]) -> String {
    let mut out = String::from(
        "You are running as a subscription CLI backend inside Klide.\n\
         Answer the user's latest request using the conversation below.\n\
         Follow the active Klide mode described in the system message. In Goal mode,\n\
         you may edit files directly in the current workspace; Klide will surface the\n\
         resulting file and git diffs after you finish. In Chat or Plan mode, do not\n\
         edit files unless the mode instructions explicitly allow it.\n\n",
    );

    for message in messages {
        let role = message
            .get("role")
            .and_then(|role| role.as_str())
            .unwrap_or("message");
        if role == "tool" {
            continue;
        }
        let content = text_from_message(message);
        if content.trim().is_empty() {
            continue;
        }
        out.push_str(&format!("[{role}]\n{content}\n\n"));
    }
    out
}

async fn run_cli_with_stdin(
    mut command: TokioCommand,
    prompt: String,
    label: &str,
    on_chunk: &Channel<StreamChunk>,
) -> Result<String, String> {
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Unable to start {label}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Unable to write prompt to {label}: {e}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stderr"))?;

    let (status, stdout, stderr) = timeout(Duration::from_secs(180), async {
        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut stderr_lines = BufReader::new(stderr).lines();
        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut stdout_text = String::new();
        let mut stderr_text = String::new();

        while !stdout_done || !stderr_done {
            tokio::select! {
                line = stdout_lines.next_line(), if !stdout_done => {
                    match line.map_err(|e| format!("Unable to read {label} stdout: {e}"))? {
                        Some(line) => {
                            stdout_text.push_str(&line);
                            stdout_text.push('\n');
                            let _ = on_chunk.send(StreamChunk {
                                content: format!("{line}\n"),
                                thinking: String::new(),
                            });
                        }
                        None => stdout_done = true,
                    }
                }
                line = stderr_lines.next_line(), if !stderr_done => {
                    match line.map_err(|e| format!("Unable to read {label} stderr: {e}"))? {
                        Some(line) => {
                            stderr_text.push_str(&line);
                            stderr_text.push('\n');
                            let _ = on_chunk.send(StreamChunk {
                                content: format!("stderr: {line}\n"),
                                thinking: String::new(),
                            });
                        }
                        None => stderr_done = true,
                    }
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("Unable to read {label} exit status: {e}"))?;
        Ok::<_, String>((
            status,
            stdout_text.trim().to_string(),
            stderr_text.trim().to_string(),
        ))
    })
    .await
    .map_err(|_| format!("{label} timed out after 180 seconds"))??;

    if status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else if stderr.is_empty() {
        Err(format!("{label} exited with {status}"))
    } else {
        Err(format!("{label} exited with {status}: {stderr}"))
    }
}
