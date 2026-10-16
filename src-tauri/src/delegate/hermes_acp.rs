//! Hermes ACP host. The foreign agent executes tools; KIDE observes its events
//! and answers permission requests through the existing authenticated bridge.
use super::{chat::Emitter, chat_stream::StreamItem, ChatSpec, Delegate};
use crate::providers::StreamChunk;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::time::{timeout, Duration};

pub(super) const MCP_ENV: &str = "KLIDE_HERMES_ACP_MCP";

struct Wire {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
    session: Option<String>,
    thinking: String,
    tools: HashMap<String, String>,
    mcp: Value,
}

impl Wire {
    async fn send(&mut self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|e| format!("Hermes ACP write: {e}"))
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        emitter: &mut Emitter<'_>,
        replay: bool,
    ) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        self.send(json!({"jsonrpc":"2.0", "id":id,"method":method,"params":params}))
            .await?;
        loop {
            let mut line = Vec::new();
            let count = (&mut self.output)
                .take(8 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|e| format!("Hermes ACP read: {e}"))?;
            if count == 0 {
                return Err("Hermes ACP closed before replying. Check `hermes acp --check`. The prompt was not retried.".into());
            }
            if count > 8 * 1024 * 1024 {
                return Err("Hermes ACP message exceeds 8 MiB".into());
            }
            let value: Value =
                serde_json::from_slice(&line).map_err(|_| "Hermes ACP emitted invalid JSON")?;
            if value.get("id") == Some(&json!(id)) && value.get("method").is_none() {
                if let Some(error) = value.get("error") {
                    return Err(format!("Hermes ACP {method}: {error}"));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "Hermes ACP response has no result".into());
            }
            match value.get("method").and_then(Value::as_str) {
                Some("session/update") => {
                    let params = &value["params"];
                    if self
                        .session
                        .as_deref()
                        .is_some_and(|s| params["sessionId"].as_str() != Some(s))
                    {
                        continue;
                    }
                    if !replay {
                        for item in updates(&params["update"], &mut self.thinking, &mut self.tools)
                        {
                            emitter.handle(item);
                        }
                    }
                }
                Some("session/request_permission") => {
                    let outcome = if replay {
                        json!({"outcome":"cancelled"})
                    } else {
                        permission(&value["params"], &self.mcp, self.session.as_deref()).await
                    };
                    self.send(
                        json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":outcome}}),
                    )
                    .await?;
                }
                Some(_) if value.get("id").is_some() => {
                    // We advertise no editor filesystem or terminal capability.
                    self.send(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"Unsupported host method"}})).await?;
                }
                _ => {}
            }
        }
    }
}

fn text_content(update: &Value) -> String {
    update
        .get("rawOutput")
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string())
        })
        .unwrap_or_else(|| {
            update["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| {
                            b.get("content")
                                .and_then(|c| c.get("text"))
                                .and_then(Value::as_str)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        })
}

fn updates(
    u: &Value,
    thinking: &mut String,
    tools: &mut HashMap<String, String>,
) -> Vec<StreamItem> {
    match u["sessionUpdate"].as_str() {
        Some("agent_message_chunk") => u["content"]["text"]
            .as_str()
            .map(|s| vec![StreamItem::TextDelta(s.into())])
            .unwrap_or_default(),
        Some("agent_thought_chunk") => {
            if let Some(text) = u["content"]["text"].as_str() {
                thinking.push_str(text);
            }
            vec![StreamItem::ThinkingPart {
                id: "acp-thinking".into(),
                text: thinking.clone(),
            }]
        }
        Some("tool_call" | "tool_call_update") => {
            let Some(id) = u["toolCallId"].as_str() else {
                return vec![];
            };
            let mut items = vec![];
            if !tools.contains_key(id) {
                let name = u["title"].as_str().unwrap_or("Hermes tool").to_string();
                tools.insert(id.into(), name.clone());
                items.push(StreamItem::ToolCall {
                    id: id.into(),
                    name,
                    input: u
                        .get("rawInput")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or_else(
                            || json!({"content":u["content"],"locations":u["locations"]}),
                        ),
                });
            }
            if matches!(u["status"].as_str(), Some("completed" | "failed")) {
                items.push(StreamItem::ToolResult {
                    id: id.into(),
                    ok: u["status"] == "completed",
                    content: text_content(u),
                });
            }
            items
        }
        Some("session_info_update") => u["title"]
            .as_str()
            .map(|t| vec![StreamItem::Title(t.into())])
            .unwrap_or_default(),
        _ => vec![],
    }
}

async fn permission(params: &Value, mcp: &Value, session: Option<&str>) -> Value {
    if session.is_none() || params["sessionId"].as_str() != session {
        return json!({"outcome":"cancelled"});
    }
    // Return only an option Hermes offered, always once; KIDE retains any
    // broader approval in its own permission engine.
    let options = params["options"].as_array().cloned().unwrap_or_default();
    let allow = options
        .iter()
        .find(|o| o["kind"] == "allow_once")
        .and_then(|o| o["optionId"].as_str())
        .map(str::to_string);
    let server = mcp
        .as_array()
        .and_then(|a| a.iter().find(|s| s["name"] == "klide"))
        .cloned();
    let call = params["toolCall"].clone();
    let allowed = if allow.is_some() {
        tokio::task::spawn_blocking(move || -> Result<bool, String> {
            use crate::mcp_server::Bridge;
            let server = server.ok_or("No authenticated KIDE permission bridge")?;
            let env = server["env"].as_array().ok_or("Missing MCP environment")?;
            let get = |key: &str| {
                env.iter()
                    .find(|e| e["name"] == key)
                    .and_then(|e| e["value"].as_str())
                    .map(str::to_string)
                    .ok_or_else(|| format!("Missing {key}"))
            };
            let bridge = crate::mcp_server::HttpBridge::new(
                get(crate::mcp_server::ENV_ENDPOINT)?.into(),
                get(crate::mcp_server::ENV_SESSION)?,
                Some(get(crate::mcp_server::ENV_SECRET_FILE)?.into()),
            )?;
            let input = call
                .get("rawInput")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!({"title":call["title"],"content":call["content"]}));
            let result = bridge.call(&crate::coordination_bridge::BridgeRequest::Permission {
                tool_name: if call["kind"] == "execute" && input["command"].is_string() {
                    "Bash".into()
                } else {
                    call["title"].as_str().unwrap_or("Hermes tool").into()
                },
                input,
                tool_use_id: call["toolCallId"].as_str().map(str::to_string),
            })?;
            let decision: Value = serde_json::from_str(
                result
                    .value
                    .as_ref()
                    .and_then(|v| v["text"].as_str())
                    .unwrap_or("{}"),
            )
            .map_err(|e| e.to_string())?;
            Ok(result.ok && decision["behavior"] == "allow")
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false)
    } else {
        false
    };
    if allowed {
        json!({"outcome":"selected","optionId":allow.unwrap()})
    } else if let Some(deny) = options
        .iter()
        .find(|o| o["kind"] == "reject_once")
        .and_then(|o| o["optionId"].as_str())
    {
        json!({"outcome":"selected","optionId":deny})
    } else {
        json!({"outcome":"cancelled"})
    }
}

pub(super) async fn run(
    adapter: &dyn Delegate,
    spec: &ChatSpec<'_>,
    cwd: &str,
    prompt: String,
    key: Option<&str>,
    emitted: &AtomicBool,
    channel: &Channel<StreamChunk>,
) -> Result<String, String> {
    // Reuse the adapter's credential checks/environment, but ACP accepts no
    // chat flags. The selected model is applied through the protocol below.
    let template = adapter.chat_invocation(cwd, spec.model)?;
    let mut command = Command::new(template.as_std().get_program());
    command.current_dir(cwd).arg("acp").envs(
        template
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| v.map(|v| (k, v))),
    );
    command.env("HERMES_ACP_SKIP_CONFIGURED_MCP", "1");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Unable to start Hermes ACP: {e}"))?;
    let mcp = spec
        .mcp
        .and_then(|m| m.env.iter().find(|(k, _)| k == MCP_ENV))
        .map(|(_, v)| serde_json::from_str(v))
        .transpose()
        .map_err(|e| format!("Invalid Hermes MCP wiring: {e}"))?
        .unwrap_or_else(|| json!([]));
    let mut wire = Wire {
        input: child.stdin.take().ok_or("Missing ACP stdin")?,
        output: BufReader::new(child.stdout.take().ok_or("Missing ACP stdout")?),
        next: 0,
        session: spec.resume.map(str::to_string),
        thinking: String::new(),
        tools: HashMap::new(),
        mcp,
    };
    let mut emitter = Emitter::new(adapter, cwd, key, emitted, channel);
    let outcome = timeout(super::chat::CHAT_TURN_CEILING, async {
        let init = timeout(Duration::from_secs(30), wire.request("initialize", json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"klide","version":env!("CARGO_PKG_VERSION")}}), &mut emitter, true)).await.map_err(|_| "Hermes ACP initialization timed out")??;
        if init["protocolVersion"] != 1 { return Err("Unsupported Hermes ACP protocol version".into()); }
        let params = json!({"cwd":cwd,"mcpServers":wire.mcp});
        let session = if let Some(id) = spec.resume {
            if init["agentCapabilities"]["loadSession"] != true { return Err("Hermes ACP cannot load this conversation".into()); }
            wire.request("session/load", json!({"sessionId":id,"cwd":cwd,"mcpServers":wire.mcp}), &mut emitter, true).await?;
            id.to_string()
        } else {
            let response = wire.request("session/new", params, &mut emitter, true).await?;
            response["sessionId"].as_str().filter(|s| !s.is_empty()).ok_or("Hermes ACP returned no session id")?.to_string()
        };
        wire.session = Some(session.clone());
        // A loaded session may carry an edit auto-approval mode selected by a
        // different host. Return it to asking; KIDE owns this turn's answers.
        wire.request("session/set_mode", json!({"sessionId":session,"modeId":"default"}), &mut emitter, true).await?;
        let selected = crate::hermes_settings::selection(Some(spec.model))?;
        let model = if let Some(selected) = selected { Some(format!("{}:{}", selected.backend()?.0, if spec.model.is_empty() { selected.model.clone() } else { crate::hermes_settings::model_value(spec.model) })) }
            else { (!spec.model.is_empty()).then(|| crate::hermes_settings::model_value(spec.model)) };
        if let Some(model) = model {
            wire.request("session/set_model", json!({"sessionId":session,"modelId":model}), &mut emitter, true).await?;
        }
        emitter.handle(StreamItem::Session(session.clone()));
        let result = wire.request("session/prompt", json!({"sessionId":session,"prompt":[{"type":"text","text":prompt}]}), &mut emitter, false).await?;
        if let (Some(input), Some(output)) = (result["usage"]["inputTokens"].as_u64(), result["usage"]["outputTokens"].as_u64()) {
            emitter.handle(StreamItem::Usage { id: "acp-turn".into(), prompt: input, completion: output, cost: None, context_window: None });
        }
        match result["stopReason"].as_str() {
            Some("end_turn") => Ok(()),
            Some(reason) => Err(format!("Hermes stopped: {reason}")),
            None => Err("Hermes ACP returned no stop reason".into()),
        }
    }).await.map_err(|_| "Hermes ACP turn timed out; the prompt was not retried".to_string()).and_then(|r| r);
    let _ = child.kill().await;
    outcome?;
    emitter.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn events_preserve_tool_identity_and_failures() {
        let mut thought = String::new();
        let mut tools = HashMap::new();
        assert_eq!(
            updates(
                &json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}),
                &mut thought,
                &mut tools
            ),
            vec![StreamItem::TextDelta("Hello".into())]
        );
        let start = updates(
            &json!({"sessionUpdate":"tool_call","toolCallId":"a","title":"Read file","rawInput":{"path":"a.rs"}}),
            &mut thought,
            &mut tools,
        );
        assert!(matches!(&start[0], StreamItem::ToolCall { id, .. } if id == "a"));
        assert_eq!(
            updates(
                &json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"failed","content":[{"type":"content","content":{"type":"text","text":"denied"}}]}),
                &mut thought,
                &mut tools
            ),
            vec![StreamItem::ToolResult {
                id: "a".into(),
                ok: false,
                content: "denied".into()
            }]
        );
        assert!(updates(
            &json!({"sessionUpdate":"future_event"}),
            &mut thought,
            &mut tools
        )
        .is_empty());
    }
    #[tokio::test]
    async fn permissions_fail_closed_without_bridge_or_matching_session() {
        let request = json!({"sessionId":"a","options":[{"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]});
        assert_eq!(
            permission(&request, &json!([]), Some("a")).await,
            json!({"outcome":"selected","optionId":"no"})
        );
        assert_eq!(
            permission(&request, &json!([]), Some("b")).await,
            json!({"outcome":"cancelled"})
        );
    }

    #[tokio::test]
    async fn bidirectional_transport_streams_denies_and_suppresses_load_replay() {
        let mut child = Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/delegate/fixtures/hermes-acp/server.py"
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut wire = Wire {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            next: 0,
            session: Some("fixture".into()),
            thinking: String::new(),
            tools: HashMap::new(),
            mcp: json!([]),
        };
        let emitted = AtomicBool::new(false);
        let channel = Channel::new(|_| Ok(()));
        let mut emitter = Emitter::new(&super::super::HERMES, "/tmp", None, &emitted, &channel);
        timeout(Duration::from_secs(10), async {
            let init = wire
                .request(
                    "initialize",
                    json!({"protocolVersion":1}),
                    &mut emitter,
                    true,
                )
                .await
                .unwrap();
            assert_eq!(init["protocolVersion"], 1);
            wire.request(
                "session/new",
                json!({"cwd":"/tmp","mcpServers":[]}),
                &mut emitter,
                true,
            )
            .await
            .unwrap();
            wire.request(
                "session/load",
                json!({"cwd":"/tmp","mcpServers":[],"sessionId":"fixture"}),
                &mut emitter,
                true,
            )
            .await
            .unwrap();
            let result = wire
                .request(
                    "session/prompt",
                    json!({"sessionId":"fixture","prompt":[]}),
                    &mut emitter,
                    false,
                )
                .await
                .unwrap();
            assert_eq!(result["stopReason"], "end_turn");
            assert_eq!(result["usage"]["inputTokens"], 10);
        })
        .await
        .unwrap();
        assert_eq!(emitter.finish().unwrap(), "Hello world.");
        child.kill().await.unwrap();
    }
}
