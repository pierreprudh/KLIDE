//! Process-host routing for API/local intelligence across delegate harnesses.
use crate::{
    harness_source::{self, Selection},
    source_endpoint::{self, Endpoint, Wire},
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;
use tiny_http::{Header, Response, Server};
struct Bridge {
    base: String,
    token: String,
    stop: Arc<AtomicBool>,
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed)
    }
}
static BRIDGES: OnceLock<Mutex<HashMap<String, Bridge>>> = OnceLock::new();
pub fn shutdown() {
    if let Some(state) = BRIDGES.get() {
        if let Ok(mut entries) = state.lock() {
            entries.clear()
        }
    }
}
pub fn prepare(harness: &str, model: &str, cwd: &str) -> Result<(), String> {
    if let Some(source) = harness_source::selection(model)? {
        ensure(harness, &source, cwd)?;
    }
    Ok(())
}
fn ensure(harness: &str, source: &Selection, cwd: &str) -> Result<(String, String), String> {
    if !harness_source::support(harness, &source.provider).supported {
        return Err("Unsupported harness/source combination.".into());
    }
    // Resolve once before launching so a missing key or subscription fails
    // before a CLI session starts. Requests resolve again to honor rotation.
    source_endpoint::resolve(&source.provider, Some(Path::new(cwd)))?;
    let key = json!([harness, source.provider, source.model, source.effort, cwd]).to_string();
    let mut state = BRIDGES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Source bridge lock failed.")?;
    if let Some(bridge) = state.get(&key) {
        return Ok((bridge.base.clone(), bridge.token.clone()));
    }
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let base = format!("http://{}", server.server_addr());
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let stop = Arc::new(AtomicBool::new(false));
    let source = source.clone();
    let routing = source.clone();
    let cwd = cwd.to_owned();
    let model = source.model.clone();
    start(
        server,
        token.clone(),
        stop.clone(),
        Arc::new(move || source_endpoint::resolve(&source.provider, Some(Path::new(&cwd)))),
        model,
        Some(routing),
    )?;
    state.insert(
        key,
        Bridge {
            base: base.clone(),
            token: token.clone(),
            stop,
        },
    );
    Ok((base, token))
}
pub fn runtime_env(
    harness: &str,
    model: &str,
    cwd: &str,
    v2: bool,
) -> Result<Vec<(String, String)>, String> {
    let Some(source) = harness_source::selection(model)? else {
        return Ok(vec![]);
    };
    let wire = source_endpoint::resolve(&source.provider, Some(Path::new(cwd)))?.wire;
    let (base, token) = ensure(harness, &source, cwd)?;
    match harness {
        "claude-code" => Ok(crate::claude_nous_bridge::claude_env(
            base,
            token,
            &source.model,
        )),
        "codex" => Ok(vec![
            ("KLIDE_INTELLIGENCE_BASE_URL".into(), format!("{base}/v1")),
            ("KLIDE_INTELLIGENCE_KEY".into(), token),
        ]),
        "opencode" => {
            let config = opencode_config(&source, &format!("{base}/v1"), wire, v2);
            let mut merged = match std::env::var("OPENCODE_CONFIG_CONTENT") {
                Ok(value) if !value.trim().is_empty() => serde_json::from_str::<Value>(&value)
                    .map_err(|_| "Existing OPENCODE_CONFIG_CONTENT is invalid JSON.")?,
                _ => json!({}),
            };
            merge(&mut merged, config);
            Ok(vec![
                ("KLIDE_INTELLIGENCE_KEY".into(), token),
                ("OPENCODE_CONFIG_CONTENT".into(), merged.to_string()),
            ])
        }
        _ => Err("Unsupported source harness.".into()),
    }
}
fn merge(target: &mut Value, source: Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge(target.entry(key).or_insert(Value::Null), value)
            }
        }
        (target, value) => *target = value,
    }
}
pub fn opencode_config(source: &Selection, base: &str, wire: Wire, v2: bool) -> Value {
    let package = match (wire, v2) {
        (Wire::Anthropic, true) => "@opencode/ai/providers/anthropic",
        (Wire::Responses, true) => "@opencode/ai/providers/openai",
        (_, true) => "@opencode/ai/providers/openai-compatible",
        (Wire::Anthropic, false) => "@ai-sdk/anthropic",
        (Wire::Responses, false) => "@ai-sdk/openai",
        (_, false) => "@ai-sdk/openai-compatible",
    };
    let settings = json!({"baseURL":base,"apiKey":"{env:KLIDE_INTELLIGENCE_KEY}","transport":"http","encoding":"none"});
    let models = json!({source.model.clone():{"name":source.model}});
    if v2 {
        json!({"model":format!("klide-intelligence/{}",source.model),"providers":{"klide-intelligence":{"name":"Klide intelligence","env":["KLIDE_INTELLIGENCE_KEY"],"package":package,"settings":settings,"models":models}}})
    } else {
        json!({"model":format!("klide-intelligence/{}",source.model),"provider":{"klide-intelligence":{"name":"Klide intelligence","npm":package,"options":settings,"models":models}}})
    }
}
pub fn launch_args(
    harness: &str,
    model: &str,
    env: &[(String, String)],
) -> Result<Vec<String>, String> {
    if harness != "codex" || harness_source::selection(model)?.is_none() {
        return Ok(vec![]);
    }
    let base = env
        .iter()
        .find(|(key, _)| key == "KLIDE_INTELLIGENCE_BASE_URL")
        .map(|(_, value)| value)
        .ok_or("Missing Codex source endpoint.")?;
    Ok(codex_config_args(base))
}
pub fn codex_config_args(base: &str) -> Vec<String> {
    let provider = format!(
        "model_providers.klide_intelligence={{ name=\"Klide intelligence\", base_url={}, env_key=\"KLIDE_INTELLIGENCE_KEY\", wire_api=\"responses\", requires_openai_auth=false, supports_websockets=false, capabilities={{ remote_compaction=\"unsupported\" }} }}",
        json!(base),
    );
    [
        "model_provider=\"klide_intelligence\"".into(),
        provider,
        "web_search=\"disabled\"".into(),
    ]
    .into_iter()
    .flat_map(|value| ["-c".into(), value])
    .collect()
}
type Resolver = Arc<dyn Fn() -> Result<Endpoint, String> + Send + Sync>;
/// The source owns the effort vocabulary. CLI defaults must not override a
/// conversation's explicit choice (or its choice to use the provider default).
fn apply_effort(body: &mut Value, provider: &str, path: &str, effort: Option<&str>) -> Result<(), String> {
    let object = body.as_object_mut().ok_or("Invalid inference request.")?;
    object.remove("reasoning_effort");
    if let Some(reasoning) = object.get_mut("reasoning").and_then(Value::as_object_mut) {
        reasoning.remove("effort");
        if reasoning.is_empty() { object.remove("reasoning"); }
    }
    if let Some(config) = object.get_mut("output_config").and_then(Value::as_object_mut) {
        config.remove("effort");
        if config.is_empty() { object.remove("output_config"); }
    }
    let Some(level) = effort else { return Ok(()); };
    if !crate::harness_source::EFFORT_LEVELS.contains(&level) {
        return Err("Invalid reasoning effort.".into());
    }
    match path {
        "messages" => {
            if !crate::delegate::CLAUDE_EFFORT_LEVELS.contains(&level) {
                return Err("This effort is not supported by the Anthropic source.".into());
            }
            if !body["output_config"].is_object() { body["output_config"] = json!({}); }
            body["output_config"]["effort"] = json!(level);
        }
        "responses" => {
            if !body["reasoning"].is_object() { body["reasoning"] = json!({}); }
            body["reasoning"]["effort"] = json!(level);
        }
        "chat/completions" if provider == "openrouter" || provider == harness_source::NOUS => {
            if !body["reasoning"].is_object() { body["reasoning"] = json!({}); }
            body["reasoning"]["effort"] = json!(level);
        }
        "chat/completions" => { body["reasoning_effort"] = json!(level); }
        _ => return Err("This source does not expose reasoning effort.".into()),
    }
    Ok(())
}
fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid HTTP header")
}
fn error(request: tiny_http::Request, status: u16, message: &str) {
    let _=request.respond(Response::from_string(json!({"type":"error","error":{"type":if status==429{"rate_limit_error"}else{"api_error"},"message":message}}).to_string()).with_status_code(status).with_header(header("Content-Type","application/json")));
}
fn start(
    server: Server,
    token: String,
    stop: Arc<AtomicBool>,
    resolve: Resolver,
    model: String,
    routing: Option<Selection>,
) -> Result<(), String> {
    let http = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("klide-source-bridge".into())
        .spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(200)) else {
                    continue;
                };
                let authorized = !request.headers().iter().any(|h| h.field.equiv("Origin"))
                    && request.headers().iter().any(|h| {
                        (h.field.equiv("x-api-key") && h.value.as_str() == token)
                            || (h.field.equiv("Authorization")
                                && h.value.as_str().strip_prefix("Bearer ") == Some(&token))
                    });
                if !authorized {
                    error(request, 401, "Invalid source bridge credential.");
                    continue;
                }
                let (http, resolve, model, routing) = (http.clone(), resolve.clone(), model.clone(), routing.clone());
                std::thread::spawn(move || handle(request, &http, resolve, &model, routing.as_ref()));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn normalize_system_messages(input: &mut Value) -> Result<(), String> {
    let messages = input["messages"]
        .as_array_mut()
        .ok_or("Missing chat messages.")?;
    let mut systems = Vec::new();
    let mut others = Vec::new();
    for message in messages.drain(..) {
        if matches!(message["role"].as_str(), Some("system" | "developer")) {
            if let Some(text) = message["content"].as_str() {
                systems.push(text.to_owned());
            } else {
                for block in message["content"]
                    .as_array()
                    .ok_or("Invalid system content.")?
                {
                    systems.push(
                        block["text"]
                            .as_str()
                            .ok_or("Unsupported system content.")?
                            .to_owned(),
                    );
                }
            }
        } else {
            others.push(message);
        }
    }
    if !systems.is_empty() {
        messages.push(json!({"role":"system","content":systems.join("\n\n")}));
    }
    messages.extend(others);
    Ok(())
}
fn handle(
    mut request: tiny_http::Request,
    http: &reqwest::blocking::Client,
    resolve: Resolver,
    model: &str,
    routing: Option<&Selection>,
) {
    let path = request.url().split('?').next().unwrap_or("").to_string();
    if request.method().as_str() != "POST"
        || !matches!(
            path.as_str(),
            "/v1/messages" | "/v1/messages/count_tokens" | "/v1/responses" | "/v1/chat/completions"
        )
    {
        error(
            request,
            404,
            "This source bridge only serves model inference.",
        );
        return;
    }
    let mut bytes = Vec::new();
    if request
        .as_reader()
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 32 * 1024 * 1024
    {
        error(request, 413, "Request is too large or incomplete.");
        return;
    }
    let mut input: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            error(request, 400, "Invalid inference JSON.");
            return;
        }
    };
    input["model"] = json!(model);
    let endpoint = match resolve() {
        Ok(endpoint) => endpoint,
        Err(message) => {
            error(request, 401, &message);
            return;
        }
    };
    let messages = path == "/v1/messages";
    let responses = path == "/v1/responses";
    let count = path.ends_with("/count_tokens");
    let native = (messages || count) && endpoint.wire == Wire::Anthropic
        || responses && endpoint.wire == Wire::Responses
        || path == "/v1/chat/completions" && endpoint.wire == Wire::Chat;
    if count && !native {
        error(
            request,
            501,
            "This intelligence source does not expose exact Anthropic token counting.",
        );
        return;
    }
    let mut custom = crate::responses_bridge_wire::ToolMap::new();
    let outgoing = if native {
        Ok(input.clone())
    } else if messages {
        crate::anthropic_bridge_wire::request(&input)
    } else if responses {
        crate::responses_bridge_wire::request(&input).map(|(value, tools)| {
            custom = tools;
            value
        })
    } else {
        Ok(input.clone())
    };
    let mut outgoing = match outgoing {
        Ok(value) => value,
        Err(message) => {
            error(request, 400, &message);
            return;
        }
    };
    if !native && input["stream"] != true {
        error(
            request,
            400,
            "Translated inference currently requires streaming.",
        );
        return;
    }
    let upstream_path = if native {
        path.trim_start_matches("/v1/").to_owned()
    } else if endpoint.wire == Wire::Anthropic {
        outgoing = match crate::chat_anthropic_wire::request(&outgoing) {
            Ok(value) => value,
            Err(message) => {
                error(request, 400, &message);
                return;
            }
        };
        "messages".into()
    } else {
        "chat/completions".into()
    };
    if !native && endpoint.wire != Wire::Anthropic {
        if endpoint.stream_usage {
            outgoing["stream_options"] = json!({"include_usage":true})
        } else {
            outgoing.as_object_mut().unwrap().remove("stream_options");
        }
    }
    if upstream_path == "chat/completions" {
        if let Err(message) = normalize_system_messages(&mut outgoing) {
            error(request, 400, &message);
            return;
        }
    }
    if !count {
        if let Some(source) = routing {
            if let Err(message) = apply_effort(&mut outgoing, &source.provider, &upstream_path, source.effort.as_deref()) {
                error(request, 400, &message);
                return;
            }
        }
    }
    let mut upstream = http
        .post(format!(
            "{}/{upstream_path}",
            endpoint.base.trim_end_matches('/')
        ))
        .json(&outgoing);
    if endpoint.wire == Wire::Anthropic {
        upstream = upstream.header("anthropic-version", "2023-06-01");
        if let Some(key) = &endpoint.key {
            upstream = upstream.header("x-api-key", key)
        }
        if native {
            if let Some(beta) = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("anthropic-beta"))
            {
                upstream = upstream.header("anthropic-beta", beta.value.as_str())
            }
        }
    } else if let Some(key) = &endpoint.key {
        upstream = upstream.bearer_auth(key)
    }
    let response = match upstream.send() {
        Ok(response) => response,
        Err(_) => {
            error(
                request,
                502,
                "The intelligence source is unavailable or timed out.",
            );
            return;
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        error(request,status,&format!("The intelligence source returned HTTP {status}. Check its key, model, and allowance."));
        return;
    }
    if native {
        if input["stream"] == true {
            let _ = crate::claude_nous_bridge::write_stream(request, response);
        } else {
            let body = response.text().unwrap_or_default();
            let _ = request.respond(
                Response::from_string(body).with_header(header("Content-Type", "application/json")),
            );
        }
        return;
    }
    let chat: Box<dyn Read + Send> = if endpoint.wire == Wire::Anthropic {
        Box::new(crate::chat_anthropic_wire::StreamReader::new(
            BufReader::new(response),
        ))
    } else {
        Box::new(response)
    };
    let body: Box<dyn Read + Send> = if messages {
        Box::new(crate::anthropic_bridge_wire::StreamReader::new(
            BufReader::new(chat),
            model,
        ))
    } else if responses {
        Box::new(crate::responses_bridge_wire::StreamReader::new(
            BufReader::new(chat),
            model,
            custom,
        ))
    } else {
        chat
    };
    let _ = crate::claude_nous_bridge::write_stream(request, body);
}

#[cfg(test)]
mod tests {
    #[test]
    fn effort_reaches_each_upstream_wire_and_default_clears_cli_overrides() {
        use super::*;
        for (provider, path, field) in [
            ("anthropic", "messages", "/output_config/effort"),
            ("openai", "responses", "/reasoning/effort"),
            ("openai", "chat/completions", "/reasoning_effort"),
            ("openrouter", "chat/completions", "/reasoning/effort"),
            (harness_source::NOUS, "chat/completions", "/reasoning/effort"),
        ] {
            let mut body = json!({"model":"test", "reasoning_effort":"low", "reasoning":{"effort":"low","summary":"auto"}, "output_config":{"effort":"low","format":{"type":"json_schema"}}});
            apply_effort(&mut body, provider, path, Some("high")).unwrap();
            assert_eq!(body.pointer(field).unwrap(), "high", "{provider}: {path}");
            apply_effort(&mut body, provider, path, None).unwrap();
            assert!(body.pointer(field).is_none());
            assert_eq!(body["reasoning"]["summary"], "auto");
            assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        }
    }
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    fn fixture_gateway(
        dir: &Path,
        wire: Wire,
    ) -> (String, Arc<AtomicBool>, std::sync::mpsc::Receiver<Value>) {
        let upstream = Server::http("127.0.0.1:0").unwrap();
        let upstream_url = format!("http://{}/v1", upstream.server_addr());
        let (sender, receiver) = std::sync::mpsc::channel();
        let dir = dir.to_string_lossy().to_string();
        std::thread::spawn(move || {
            let mut turn = 0;
            let mut called = false;
            while let Ok(Some(mut request)) = upstream.recv_timeout(Duration::from_secs(30)) {
                if wire == Wire::Anthropic {
                    assert!(request
                        .headers()
                        .iter()
                        .any(|h| h.field.equiv("x-api-key") && h.value.as_str() == "fixture-key"));
                } else {
                    assert!(request
                        .headers()
                        .iter()
                        .any(|h| h.field.equiv("Authorization")
                            && h.value.as_str() == "Bearer fixture-key"));
                }
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                let value: Value = serde_json::from_str(&body).unwrap();
                sender.send(value.clone()).unwrap();
                let mut tool_input = value.clone();
                if wire == Wire::Anthropic {
                    tool_input["tools"] = json!(value["tools"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|t| json!({"function":{"name":t["name"]}}))
                        .collect::<Vec<_>>());
                }
                let tool = tool_input["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|t| {
                        matches!(
                            t["function"]["name"]
                                .as_str()
                                .map(|n| n.rsplit("__").next().unwrap_or(n)),
                            Some("Read" | "read" | "exec_command" | "shell_command" | "shell")
                        )
                    })
                    .cloned();
                let (delta, reason) = if !called && tool.is_some() {
                    called = true;
                    let name = tool.unwrap()["function"]["name"]
                        .as_str()
                        .unwrap()
                        .to_string();
                    let args = match name.rsplit("__").next().unwrap_or(&name) {
                        "Read" => json!({"file_path":format!("{dir}/fixture.txt")}),
                        "read" => json!({"path":format!("{dir}/fixture.txt")}),
                        "exec_command" => {
                            json!({"cmd":"cat fixture.txt","workdir":dir,"yield_time_ms":1000})
                        }
                        "shell_command" => {
                            json!({"command":"cat fixture.txt","workdir":dir,"timeout_ms":1000})
                        }
                        _ => {
                            json!({"command":["/bin/sh","-c","cat fixture.txt"],"workdir":dir,"timeout_ms":1000})
                        }
                    };
                    (
                        json!({"tool_calls":[{"index":0,"id":"fixture_call","type":"function","function":{"name":name,"arguments":args.to_string()}}]}),
                        "tool_calls",
                    )
                } else {
                    (json!({"content":"Source bridge verified."}), "stop")
                };
                turn += 1;
                let body = format!(
                    "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"id":"fixture","object":"chat.completion.chunk","created":0,"model":"coder","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                    json!({"id":"fixture","object":"chat.completion.chunk","created":0,"model":"coder","choices":[{"index":0,"delta":{},"finish_reason":reason}]}),
                    json!({"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}})
                );
                let body = if wire == Wire::Anthropic {
                    let mut events = vec![
                        json!({"type":"message_start","message":{"id":"native_fixture","type":"message","role":"assistant","model":"coder","content":[],"usage":{"input_tokens":100,"output_tokens":0}}}),
                    ];
                    if let Some(call) = delta["tool_calls"].as_array().and_then(|v| v.first()) {
                        events.push(json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":call["id"],"name":call["function"]["name"],"input":{}}}));
                        events.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":call["function"]["arguments"]}}));
                    } else {
                        events.push(json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}));
                        events.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":delta["content"]}}));
                    }
                    events.push(json!({"type":"content_block_stop","index":0}));
                    events.push(json!({"type":"message_delta","delta":{"stop_reason":if reason == "tool_calls" {"tool_use"} else {"end_turn"},"stop_sequence":null},"usage":{"output_tokens":20}}));
                    events.push(json!({"type":"message_stop"}));
                    events
                        .iter()
                        .map(|v| format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap()))
                        .collect::<String>()
                } else {
                    body
                };
                let _ = request.respond(
                    Response::from_string(body)
                        .with_header(header("Content-Type", "text/event-stream")),
                );
                if turn >= 3 {
                    break;
                }
            }
        });
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let stop = Arc::new(AtomicBool::new(false));
        start(
            server,
            "test-only-token".into(),
            stop.clone(),
            Arc::new(move || {
                Ok(Endpoint {
                    base: upstream_url.clone(),
                    key: Some("fixture-key".into()),
                    wire,
                    stream_usage: true,
                })
            }),
            "coder".into(),
            Some(Selection {
                provider: if wire == Wire::Anthropic { "anthropic" } else { "openrouter" }.into(),
                model: "coder".into(),
                effort: Some("high".into()),
            }),
        )
        .unwrap();
        (base, stop, receiver)
    }
    #[test]
    fn system_reminders_precede_the_chat_for_strict_api_providers() {
        let mut input = json!({"messages":[{"role":"system","content":"Base"},{"role":"user","content":"Task"},{"role":"system","content":[{"type":"text","text":"Reminder"}]}]});
        normalize_system_messages(&mut input).unwrap();
        assert_eq!(input["messages"][0]["content"], "Base\n\nReminder");
        assert_eq!(input["messages"][1]["content"], "Task");
    }
    #[test]
    fn configurations_are_scoped_and_never_contain_provider_keys() {
        let source = Selection {
            provider: "openrouter".into(),
            model: "anthropic/claude-test".into(),
            effort: None,
        };
        for v2 in [false, true] {
            let config = opencode_config(&source, "http://127.0.0.1:1/v1", Wire::Chat, v2);
            assert_eq!(config["model"], "klide-intelligence/anthropic/claude-test");
            let root = if v2 { "providers" } else { "provider" };
            assert!(config[root]["klide-intelligence"].is_object());
            assert!(config.to_string().contains("{env:KLIDE_INTELLIGENCE_KEY}"));
        }
        let args = codex_config_args("http://127.0.0.1:1/v1");
        assert!(args.iter().any(|s| s.contains("wire_api=\"responses\"")));
        assert!(!args.join(" ").contains("experimental_bearer_token"));
    }
    fn run_fixture(harness: &str, wire: Wire) {
        let dir = std::env::temp_dir().join(format!(
            "klide-{harness}-{}-source-test-{}",
            if wire == Wire::Anthropic {
                "anthropic"
            } else {
                "chat"
            },
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fixture.txt"), "source-fixture-verified").unwrap();
        std::fs::create_dir_all(dir.join("codex")).unwrap();
        let (base, stop, received) = fixture_gateway(&dir, wire);
        let binary = crate::cli::resolve_command(harness).unwrap();
        let mut command = Command::new(binary);
        command.current_dir(&dir).env_clear();
        for name in ["PATH", "HOME", "USER", "TMPDIR", "SHELL"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.env("KLIDE_INTELLIGENCE_KEY", "test-only-token");
        if harness == "codex" {
            command
                .env("CODEX_HOME", dir.join("codex"))
                .args([
                    "exec",
                    "--skip-git-repo-check",
                    "-s",
                    "read-only",
                    "-m",
                    "coder",
                ])
                .args(codex_config_args(&format!("{base}/v1")))
                .arg("Read fixture.txt and report its contents.");
        } else if harness == "claude" {
            std::fs::create_dir_all(dir.join("claude")).unwrap();
            command
                .env("CLAUDE_CONFIG_DIR", dir.join("claude"))
                .envs(crate::claude_nous_bridge::claude_env(
                    base.clone(),
                    "test-only-token".into(),
                    "coder",
                ))
                .args([
                    "-p",
                    "Read fixture.txt and report its contents.",
                    "--model",
                    "coder",
                    "--permission-mode",
                    "acceptEdits",
                    "--tools",
                    "Read",
                    "--max-turns",
                    "3",
                ]);
        } else {
            let source = Selection {
                provider: "fixture".into(),
                model: "coder".into(),
                effort: None,
            };
            command
                .env("XDG_CONFIG_HOME", dir.join("config"))
                .env("XDG_DATA_HOME", dir.join("data"))
                .env("XDG_CACHE_HOME", dir.join("cache"))
                .env("XDG_STATE_HOME", dir.join("state"))
                .env(
                    "OPENCODE_CONFIG_CONTENT",
                    opencode_config(&source, &format!("{base}/v1"), Wire::Chat, true).to_string(),
                )
                .env("OPENCODE_DISABLE_AUTOUPDATE", "1")
                .env("OPENCODE_DISABLE_DEFAULT_PLUGINS", "1")
                .args([
                    "run",
                    "--standalone",
                    "--auto",
                    "-m",
                    "klide-intelligence/coder",
                    "Read fixture.txt and report its contents.",
                ]);
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100))
        }
        if child.try_wait().unwrap().is_none() {
            let _ = child.kill();
        }
        let output = child.wait_with_output().unwrap();
        stop.store(true, Ordering::Relaxed);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "{harness} failed: {stdout}\n{stderr}"
        );
        assert!(
            format!("{stdout}\n{stderr}").contains("Source bridge verified."),
            "{harness} missing answer: {stdout}\n{stderr}"
        );
        let requests: Vec<_> = received.try_iter().collect();
        assert!(!requests.is_empty());
        for body in &requests {
            assert_eq!(if wire == Wire::Anthropic { &body["output_config"]["effort"] } else { &body["reasoning"]["effort"] }, "high", "{harness}: effort was lost before the provider request");
        }
        assert!(
            requests.iter().any(
                |v| v["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| (m["role"] == "tool"
                        && m["content"].to_string().contains("source-fixture-verified"))
                        || m["content"]
                            .as_array()
                            .is_some_and(|blocks| blocks.iter().any(|b| b["type"]
                                == "tool_result"
                                && b["content"].to_string().contains("source-fixture-verified"))))
            ),
            "{harness} did not execute its file-reading tool; tool names: {:?}; tool results: {:?}",
            requests
                .iter()
                .map(|v| v["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|t| t
                        .get("name")
                        .cloned()
                        .unwrap_or_else(|| t["function"]["name"].clone()))
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            requests
                .iter()
                .map(|v| v["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["role"] == "tool"
                        || m["content"].as_array().is_some_and(|blocks| blocks
                            .iter()
                            .any(|b| b["type"] == "tool_result")))
                    .map(|m| m["content"].clone())
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "opt-in: installed Codex, isolated config, mock API and fixture tool only"]
    fn installed_codex_tool_loop() {
        run_fixture("codex", Wire::Chat)
    }
    #[test]
    #[ignore = "opt-in: installed OpenCode 2, isolated config, mock API and fixture tool only"]
    fn installed_opencode_tool_loop() {
        run_fixture("opencode", Wire::Chat)
    }
    #[test]
    #[ignore = "opt-in: installed Claude, isolated config, mock API and fixture tool only"]
    fn installed_claude_api_tool_loop() {
        run_fixture("claude", Wire::Chat)
    }
    #[test]
    #[ignore = "opt-in: installed Codex, isolated config, mock Anthropic API and fixture tool only"]
    fn installed_codex_anthropic_tool_loop() {
        run_fixture("codex", Wire::Anthropic)
    }
}
