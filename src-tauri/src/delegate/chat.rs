//! One-shot headless chat with a subscription delegate CLI.
//!
//! The AI panel's "subscription" providers (Claude Code, Codex, OpenCode, Omp)
//! don't stream over a wire API — they run the CLI once with the prompt on
//! stdin and read plain text back. Building the command is the adapter's job
//! (`Delegate::chat_invocation`); this module owns the rest — folding the
//! conversation into a prompt, running the process, and streaming its output.
//! Keeping it here means the whole one-shot-chat operation lives behind the
//! Delegate seam instead of being split across the lib.rs IPC glue.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use super::{ChatSpec, Delegate};
use crate::providers::{text_from_message, AiChatResponse, ObservedToolActivity, StreamChunk};

/// Hard ceiling for one headless delegate turn. See `run_cli_with_stdin`.
const CHAT_TURN_CEILING: Duration = Duration::from_secs(30 * 60);

/// The CLI session each conversation is talking to, keyed by run id + provider.
///
/// A headless turn used to be self-contained: spawn the CLI, paste the whole
/// transcript on stdin, read the answer, exit. That made every message a cold
/// start — the CLI re-read the entire conversation, kept none of its own
/// context or prompt cache between turns, and filed a separate run on disk each
/// time. Remembering the session id it reports lets the next turn continue it
/// (`claude --resume`, `opencode run -s`) and send only what is new.
///
/// In memory on purpose: losing it costs one cold turn, which is exactly the
/// old behaviour, whereas a stale id persisted across a restart would point at
/// a session the CLI may already have collected.
static SESSIONS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, String>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One conversation with one delegate. The provider is part of the key because
/// switching a thread from Claude Code to OpenCode must not hand OpenCode a
/// Claude session id.
fn session_key(run_id: &str, provider: &str) -> String {
    format!("{run_id}:{provider}")
}

fn remembered_session(key: &str) -> Option<String> {
    sessions().lock().ok()?.get(key).cloned()
}

fn remember_session(key: &str, session: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.insert(key.to_string(), session.to_string());
    }
}

fn forget_session(key: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.remove(key);
    }
}

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
    run_id: Option<String>,
    allowed_commands: Vec<String>,
    mcp: Option<super::McpWiring>,
    on_chunk: &Channel<StreamChunk>,
) -> Result<AiChatResponse, String> {
    let cwd = workspace_root.unwrap_or_else(|| ".".to_string());
    // The "default" sentinel means "no model picked" — hand the adapter an
    // empty model so it omits its model flag and the CLI uses its own default.
    let model = model.trim();
    let model = if model.eq_ignore_ascii_case(super::CLI_DEFAULT_MODEL) {
        ""
    } else {
        model
    };
    // Which conversation this turn belongs to. Without a run id there is
    // nothing to key a session on, so the turn stays a cold start.
    let key = run_id
        .filter(|id| !id.trim().is_empty())
        .map(|id| session_key(&id, adapter.id()));
    // Resume only when this adapter actually honours the id — claiming to and
    // then ignoring it would silently drop every earlier turn, since a resuming
    // turn deliberately sends just the newest message.
    let resume = key
        .as_deref()
        .filter(|_| adapter.resumes_sessions())
        .and_then(remembered_session)
        // A resumed session already holds the history, so re-sending it would
        // say everything twice. Send what is new — and if there is no new user
        // message to send, fall back to the full fold rather than an empty turn.
        .filter(|_| !latest_user_message(&messages).is_empty());
    let prompt = match resume {
        Some(_) => latest_user_message(&messages),
        None => prompt_from_messages(&messages),
    };

    // Prefer the CLI's structured stream when it has one: the prose-only mode
    // reports an answer with no visible work behind it, and a delegate's work
    // is most of what the user wants to see.
    let spec = ChatSpec {
        model,
        resume: resume.as_deref(),
        mcp: mcp.as_ref(),
        allowed_commands: &allowed_commands,
    };
    let content = match adapter.chat_stream_invocation(&cwd, &spec) {
        Some(command) => {
            let emitted = AtomicBool::new(false);
            match run_cli_streaming(
                adapter,
                command?,
                prompt,
                label,
                key.as_deref(),
                &emitted,
                on_chunk,
            )
            .await
            {
                Ok(answer) => answer,
                // A remembered session the CLI no longer has fails the spawn,
                // and would keep failing every turn from here on. Forget it and
                // take the cold path once — but only while the failed attempt
                // said nothing, or the retry would repeat text already on screen.
                Err(err) if resume.is_some() && !emitted.load(Ordering::Relaxed) => {
                    if let Some(key) = key.as_deref() {
                        forget_session(key);
                    }
                    let _ = err;
                    let cold = ChatSpec { resume: None, ..spec };
                    let command = adapter
                        .chat_stream_invocation(&cwd, &cold)
                        .ok_or_else(|| format!("{label} has no structured mode"))??;
                    run_cli_streaming(
                        adapter,
                        command,
                        prompt_from_messages(&messages),
                        label,
                        key.as_deref(),
                        &emitted,
                        on_chunk,
                    )
                    .await?
                }
                Err(err) => return Err(err),
            }
        }
        None => run_cli_with_stdin(adapter.chat_invocation(&cwd, model)?, prompt, label, on_chunk)
            .await?
    };
    Ok(AiChatResponse {
        content,
        thinking: None,
        // Empty on purpose: a delegate has *already run* its tools. Reporting
        // them here would make the harness queue them for execution a second
        // time. They reach the UI as observed activity instead.
        tool_calls: Vec::new(),
        usage: None,
        stop_reason: None,
    })
}

/// Drive a CLI that reports itself line by line: prompt on stdin, one JSON
/// object per stdout line. Assistant prose is streamed as ordinary content;
/// tool calls and their results are streamed as *observed* activity, which the
/// harness forwards without ever dispatching or gating it.
///
/// The returned string is the assistant text only — the answer — so a saved
/// transcript reads as prose rather than as a mixture of prose and tool logs.
async fn run_cli_streaming(
    adapter: &dyn Delegate,
    mut command: TokioCommand,
    prompt: String,
    label: &str,
    session_key: Option<&str>,
    emitted: &AtomicBool,
    on_chunk: &Channel<StreamChunk>,
) -> Result<String, String> {
    let provider_id = adapter.id();
    use super::chat_stream::{summarize_call, StreamItem};

    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Unable to start {label}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Unable to write prompt to {label}: {e}"))?;
        // The CLI reads until EOF before it starts working, so the handle has to
        // drop here — holding it open deadlocks the turn.
        drop(stdin);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Unable to capture {label} stderr"))?;

    let answer = timeout(CHAT_TURN_CEILING, async {
        let mut lines = BufReader::new(stdout).lines();
        let mut answer = String::new();
        // With partial messages on, every block arrives twice: as deltas while
        // it is written, then again whole. Deltas win — they are what makes the
        // answer type out — so a completed block is dropped once any delta has
        // been seen. (The flag is per-adapter, so the whole-block path still has
        // to work for a CLI that streams no deltas.)
        let mut saw_delta = false;
        // How much of each named text part has already been streamed. OpenCode
        // reports text per part rather than as deltas, and a part that is still
        // growing may be re-sent whole; keeping the emitted length per id means
        // only the new suffix goes out either way — no duplicated answer if it
        // repeats, no lost text if it does not.
        let mut emitted_parts: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| format!("Unable to read {label} stdout: {e}"))?
        {
            for item in adapter.parse_stream_line(&line) {
                match item {
                    StreamItem::TextDelta(text) => {
                        saw_delta = true;
                        answer.push_str(&text);
                        emitted.store(true, Ordering::Relaxed);
                        let _ = on_chunk.send(StreamChunk::text(text));
                    }
                    StreamItem::TextPart { id, text } => {
                        let already = emitted_parts.get(&id).copied().unwrap_or(0);
                        // A part that shrank or was replaced is not a suffix of
                        // what we sent; start it over rather than slicing at a
                        // stale offset (which could also split a char boundary).
                        let suffix = if text.len() > already && text.is_char_boundary(already) {
                            &text[already..]
                        } else if already == 0 {
                            &text[..]
                        } else {
                            ""
                        };
                        if !suffix.is_empty() {
                            answer.push_str(suffix);
                            emitted.store(true, Ordering::Relaxed);
                            let _ = on_chunk.send(StreamChunk::text(suffix.to_string()));
                        }
                        emitted_parts.insert(id, text.len());
                    }
                    StreamItem::Text(text) if saw_delta => {
                        // Already streamed, character for character.
                        let _ = text;
                    }
                    StreamItem::Text(text) => {
                        answer.push_str(&text);
                        answer.push('\n');
                        emitted.store(true, Ordering::Relaxed);
                        let _ = on_chunk.send(StreamChunk::text(format!("{text}\n")));
                    }
                    StreamItem::ToolCall { id, name, input } => {
                        let summary = summarize_call(&name, &input);
                        emitted.store(true, Ordering::Relaxed);
                        let _ = on_chunk.send(StreamChunk {
                            observed: Some(ObservedToolActivity::Call {
                                id,
                                name,
                                input,
                                provider: provider_id.to_string(),
                                summary,
                            }),
                            ..Default::default()
                        });
                    }
                    StreamItem::ToolResult { id, ok, content } => {
                        let _ = on_chunk.send(StreamChunk {
                            observed: Some(ObservedToolActivity::Result { id, ok, content }),
                            ..Default::default()
                        });
                    }
                    // Remember what to continue next turn. Recorded even on a
                    // turn that was itself a resume: a CLI may answer with a new
                    // id (a fork, a compaction), and the newest one is the live
                    // session.
                    StreamItem::Session(session) => {
                        if let Some(key) = session_key {
                            remember_session(key, &session);
                        }
                    }
                    // Cost is not shown here; the harness reports run cost.
                    StreamItem::Finished { .. } => {}
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("Unable to read {label} exit status: {e}"))?;
        if !status.success() {
            // stderr is only read on failure: on the happy path it carries
            // warnings that would otherwise be pasted into the answer.
            let mut stderr_text = String::new();
            let mut stderr_lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = stderr_lines.next_line().await {
                stderr_text.push_str(&line);
                stderr_text.push('\n');
            }
            let stderr_text = stderr_text.trim().to_string();
            return Err(if stderr_text.is_empty() {
                format!("{label} exited with {status}")
            } else {
                format!("{label} exited with {status}: {stderr_text}")
            });
        }
        Ok::<_, String>(answer.trim().to_string())
    })
    .await
    .map_err(|_| {
        format!(
            "{label} timed out after {} minutes",
            CHAT_TURN_CEILING.as_secs() / 60
        )
    })??;

    Ok(answer)
}

/// The newest user message, which is all a resumed session still needs — it
/// already holds everything before it.
///
/// Note what this deliberately does not carry: a system message. A mode change
/// made mid-conversation (Chat → Goal) is announced in the system message, and
/// a resumed session never sees it. That is the known edge of session reuse;
/// the fresh-start path still folds the system message in.
fn latest_user_message(messages: &[serde_json::Value]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .map(text_from_message)
        .unwrap_or_default()
        .trim()
        .to_string()
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
    // Stopping a turn drops this future. Without `kill_on_drop` the CLI would
    // keep running unattended — still editing the workspace, with nothing left
    // reading its output — so cancelling from the composer has to end it.
    command.kill_on_drop(true);

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

    // A backstop against a wedged CLI, not a work budget. Three minutes was
    // enough when this only answered questions; a delegate driving a Goal-mode
    // task in Focus routinely runs longer, and cutting it mid-edit leaves the
    // workspace half-written. Stop in the composer is the real control.
    let (status, stdout, stderr) = timeout(CHAT_TURN_CEILING, async {
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
                            let _ = on_chunk.send(StreamChunk::text(format!("{line}\n")));
                        }
                        None => stdout_done = true,
                    }
                }
                line = stderr_lines.next_line(), if !stderr_done => {
                    match line.map_err(|e| format!("Unable to read {label} stderr: {e}"))? {
                        Some(line) => {
                            // Collected for diagnostics, never streamed into the
                            // answer. A CLI's stderr is its chrome: OpenCode puts
                            // its banner, its `→ Read README.md` progress and the
                            // full stdout of every command it ran there, which
                            // arrived in the conversation as a wall of
                            // "stderr: total 720 / drwxr-xr-x@ …". The answer is
                            // on stdout; this is only shown if the turn fails.
                            stderr_text.push_str(&line);
                            stderr_text.push('\n');
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
    .map_err(|_| {
        format!(
            "{label} timed out after {} minutes",
            CHAT_TURN_CEILING.as_secs() / 60
        )
    })??;

    if status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else if stderr.is_empty() {
        Err(format!("{label} exited with {status}"))
    } else {
        Err(format!("{label} exited with {status}: {stderr}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, text: &str) -> serde_json::Value {
        serde_json::json!({ "role": role, "content": text })
    }

    #[test]
    fn a_resumed_turn_sends_only_the_newest_user_message() {
        let messages = vec![
            msg("system", "You are in Goal mode."),
            msg("user", "first ask"),
            msg("assistant", "first answer"),
            msg("user", "second ask"),
        ];
        assert_eq!(latest_user_message(&messages), "second ask");
        // The cold path still carries everything, so a fresh session is not
        // handed a conversation with no history.
        let full = prompt_from_messages(&messages);
        assert!(full.contains("first ask"));
        assert!(full.contains("second ask"));
    }

    #[test]
    fn no_user_message_means_nothing_to_resume_with() {
        // Empty rather than the assistant's last turn — the caller reads this
        // as "fall back to the full fold", never as a prompt to send.
        assert_eq!(latest_user_message(&[msg("assistant", "hi")]), "");
        assert_eq!(latest_user_message(&[]), "");
        assert_eq!(latest_user_message(&[msg("user", "   ")]), "");
    }

    #[test]
    fn sessions_are_remembered_per_conversation_and_provider() {
        let a = session_key("run-1", "claude-code");
        let b = session_key("run-1", "opencode");
        let c = session_key("run-2", "claude-code");
        remember_session(&a, "sess-a");
        remember_session(&b, "sess-b");
        // Switching a thread's provider must not hand the new CLI the old
        // CLI's session id, and two conversations must not share one session.
        assert_eq!(remembered_session(&a).as_deref(), Some("sess-a"));
        assert_eq!(remembered_session(&b).as_deref(), Some("sess-b"));
        assert_eq!(remembered_session(&c), None);

        // A session the CLI no longer has is forgotten, so the next turn is a
        // cold start rather than a permanent failure.
        forget_session(&a);
        assert_eq!(remembered_session(&a), None);
    }
}
