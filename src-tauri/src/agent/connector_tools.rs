//! Connector tools — how a Harness Run uses the MCP servers the user enabled.
//!
//! A connector can bring a lot of tools: GitHub's four toolsets alone are 43,
//! about 13k tokens of schema. Offering each as its own function would cost
//! that on every turn of every Run and swamp a small local model, so a Run gets
//! two fixed Tools instead, whatever is connected:
//!
//! * `connector_tools` — what a connector offers. With no `tools`, a one-line
//!   list; with `tools`, those tools' full argument schemas. Reads Klide's own
//!   cached catalog, touches nothing remote.
//! * `connector_call` — run one tool with its arguments.
//!
//! The model sees every connected connector's tool *names* in the
//! `connector_tools` description, fetches the schema it needs, then calls. The
//! prompt cost stays around a kilobyte however many connectors are on.
//!
//! Trust follows the tool, not the door: a `connector_call` whose target the
//! server marks `readOnlyHint` resolves to [`ToolKind::ConnectorRead`] and runs
//! without a prompt (Plan included); anything else — unannotated counts as
//! "may write" — is [`ToolKind::Connector`], Goal-only, and goes through the
//! same Permission engine as a network target, keyed `mcp:<connector>/<tool>`.
//! That key namespace cannot collide with `host:` targets or tool names, and
//! the full-auto rung (commands only) never answers it.
//!
//! Only a conversation's own Run gets connectors. A Mission attempt or a
//! spawned child has no surface to answer an approval card on, so it is not
//! offered tools it could only stall on.

use super::permission::{self, GateSubject, RunLineage};
use super::tool_handlers::standard_gate_options;
use super::tools::{NormalizedToolCall, ToolKind};
use super::types::{AgentEvent, AgentMode, PermissionRequest, ToolResult};
use super::{network_allowlist, ToolCtx, ToolOutcome};
use crate::connector_pool::{self, ConnectorTools};
use crate::mcp_client::McpTool;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

pub const CONNECTOR_TOOLS: &str = "connector_tools";
pub const CONNECTOR_CALL: &str = "connector_call";

/// How long a Run waits at start for connectors that are still connecting.
/// A warm pool answers at once; a cold `npx` start keeps going in the
/// background and is there for the next message.
const READY_WAIT: Duration = Duration::from_secs(8);

/// How long one connector call may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// The most text one call returns to the model.
const MAX_RESULT_CHARS: usize = 200_000;

/// A tool description longer than this is cut in the one-line listing.
const SHORT_DESCRIPTION: usize = 160;

/// What this Run can reach, fixed at Run start.
#[derive(Default, Clone, Debug)]
pub struct Catalog {
    connectors: Vec<ConnectorTools>,
}

impl Catalog {
    /// The connected connectors this Run may use — none for Chat, a Mission
    /// attempt or a child, or when nothing is enabled.
    pub async fn load(subject: &GateSubject, workspace_root: Option<&str>) -> Catalog {
        if subject.mode == AgentMode::Chat || subject.lineage != RunLineage::Conversation {
            return Catalog::default();
        }
        if subject.disabled.contains(CONNECTOR_TOOLS) && subject.disabled.contains(CONNECTOR_CALL) {
            return Catalog::default();
        }
        let workspace = workspace_root.map(str::to_string);
        let connectors = crate::blocking::run(move || {
            Ok(connector_pool::ready(READY_WAIT, workspace.as_deref().map(Path::new)))
        })
        .await
        .unwrap_or_default();
        Catalog { connectors }
    }

    #[cfg(test)]
    fn of(connectors: Vec<ConnectorTools>) -> Catalog {
        Catalog { connectors }
    }

    pub fn is_empty(&self) -> bool {
        self.connectors.iter().all(|c| c.tools.is_empty())
    }

    fn connector(&self, id: &str) -> Option<&ConnectorTools> {
        self.connectors.iter().find(|c| c.id == id)
    }

    fn tool(&self, connector: &str, tool: &str) -> Option<(&ConnectorTools, &McpTool)> {
        let c = self.connector(connector)?;
        Some((c, c.tools.iter().find(|t| t.name == tool)?))
    }

    /// The two Tools, described against what is connected right now. Empty
    /// when nothing is.
    pub fn schemas(&self) -> Vec<Value> {
        if self.is_empty() {
            return Vec::new();
        }
        let ids: Vec<&str> = self.connectors.iter().map(|c| c.id.as_str()).collect();
        let listing: Vec<String> = self
            .connectors
            .iter()
            .map(|c| {
                let names: Vec<&str> = c.tools.iter().map(|t| t.name.as_str()).collect();
                format!("- {} ({}): {}", c.id, c.label, names.join(", "))
            })
            .collect();
        vec![
            json!({
                "type": "function",
                "function": {
                    "name": CONNECTOR_TOOLS,
                    "description": format!(
                        "Look up tools on the user's connected services before calling them with {CONNECTOR_CALL}. \
                         Pass `tools` to get their argument schemas; omit it for a one-line list. Connected:\n{}",
                        listing.join("\n")
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "connector": { "type": "string", "enum": ids },
                            "tools": { "type": "array", "items": { "type": "string" }, "description": "Tool names whose argument schemas you need." }
                        },
                        "required": ["connector"]
                    }
                }
            }),
            json!({
                "type": "function",
                "function": {
                    "name": CONNECTOR_CALL,
                    "description": format!(
                        "Run one tool on a connected service. Get its argument schema from {CONNECTOR_TOOLS} first. \
                         Read-only tools run at once; a tool that can change something asks the user first."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "connector": { "type": "string", "enum": ids },
                            "tool": { "type": "string" },
                            "arguments": { "type": "object", "description": "The tool's arguments, matching its schema. Send `{}` for a tool that takes none." }
                        },
                        "required": ["connector", "tool", "arguments"]
                    }
                }
            }),
        ]
    }

    /// The kind a call resolves to, or `None` for a name that isn't one of the
    /// two. A call to a tool the catalog doesn't know resolves read-only: it
    /// fails at execution without reaching any server.
    pub fn kind(&self, call: &NormalizedToolCall) -> Option<ToolKind> {
        match call.name.as_str() {
            CONNECTOR_TOOLS => Some(ToolKind::ConnectorRead),
            CONNECTOR_CALL => {
                let (connector, tool) = target(call);
                Some(match self.tool(&connector, &tool) {
                    Some((_, t)) if t.read_only != Some(true) => ToolKind::Connector,
                    _ => ToolKind::ConnectorRead,
                })
            }
            _ => None,
        }
    }

    /// The one-liner on `ToolCallStarted`.
    pub fn summary(&self, call: &NormalizedToolCall) -> Option<String> {
        let (connector, tool) = target(call);
        let label = self.connector(&connector).map(|c| c.label.as_str()).unwrap_or(connector.as_str());
        match call.name.as_str() {
            CONNECTOR_TOOLS => Some(format!("{label} tools")),
            CONNECTOR_CALL => Some(format!("{tool} on {label}")),
            _ => None,
        }
    }

    /// `connector_tools`: answered from the catalog alone.
    fn describe(&self, call: &NormalizedToolCall) -> ToolResult {
        let (connector, _) = target(call);
        let Some(c) = self.connector(&connector) else {
            return failed(format!("No connected connector is called `{connector}`."));
        };
        let wanted: Vec<&str> = call
            .input
            .get("tools")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let body = if wanted.is_empty() {
            let mut lines: Vec<String> = c
                .tools
                .iter()
                .map(|t| {
                    let access = if t.read_only == Some(true) { "read" } else { "write" };
                    format!("{} [{access}] — {}", t.name, first_line(&t.description))
                })
                .collect();
            if let Some(instructions) = &c.instructions {
                lines.insert(0, format!("{instructions}\n"));
            }
            lines.join("\n")
        } else {
            let (found, missing): (Vec<&McpTool>, Vec<&str>) = wanted.iter().fold(
                (Vec::new(), Vec::new()),
                |(mut found, mut missing), name| {
                    match c.tools.iter().find(|t| t.name == *name) {
                        Some(tool) => found.push(tool),
                        None => missing.push(name),
                    }
                    (found, missing)
                },
            );
            let tools: Vec<Value> = found
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "readOnly": t.read_only == Some(true),
                        "arguments": t.input_schema,
                    })
                })
                .collect();
            let mut out = serde_json::to_string_pretty(&tools).unwrap_or_default();
            if !missing.is_empty() {
                out.push_str(&format!("\nNot on {}: {}", c.id, missing.join(", ")));
            }
            out
        };
        ToolResult { ok: true, content: body, metadata: Some(json!({ "connector": c.id })) }
    }
}

fn target(call: &NormalizedToolCall) -> (String, String) {
    let field = |key: &str| {
        call.input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    };
    (field("connector"), field("tool"))
}

fn first_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() > SHORT_DESCRIPTION {
        format!("{}…", line.chars().take(SHORT_DESCRIPTION).collect::<String>())
    } else {
        line.to_string()
    }
}

/// The target tool's own arguments, when a model left out `arguments` and put
/// them beside `connector` and `tool` instead.
fn stray_arguments(input: &Value) -> Value {
    let stray = input
        .as_object()
        .map(|map| {
            map.iter()
                .filter(|(key, _)| !matches!(key.as_str(), "connector" | "tool" | "arguments"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();
    Value::Object(stray)
}

/// The fields the tool's schema requires that `arguments` doesn't carry. Only
/// the top-level `required` list — enough to catch a call that sent nothing,
/// while anything subtler stays the server's to judge.
fn missing_required(schema: &Value, arguments: &Value) -> Vec<String> {
    let required = schema.get("required").and_then(Value::as_array).cloned().unwrap_or_default();
    required
        .iter()
        .filter_map(Value::as_str)
        .filter(|key| arguments.get(*key).map_or(true, Value::is_null))
        .map(str::to_string)
        .collect()
}

/// Answered without reaching the server: which fields are missing, what each
/// one is, and the call written out whole. A server's own reply ("missing
/// required parameter: method") names one field and no shape, and a small
/// model repeats the same empty call against it until steering gives up.
fn argument_hint(connector: &str, tool: &McpTool, arguments: &Value, missing: &[String]) -> String {
    let properties = tool.input_schema.get("properties");
    let lines: Vec<String> = missing
        .iter()
        .map(|key| {
            let property = properties.and_then(|p| p.get(key));
            let kind = property.and_then(|p| p.get("type")).and_then(Value::as_str).unwrap_or("value");
            let options = property
                .and_then(|p| p.get("enum"))
                .and_then(Value::as_array)
                .map(|values| {
                    let names: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
                    format!(", one of: {}", names.join(", "))
                })
                .unwrap_or_default();
            let about = property.and_then(|p| p.get("description")).and_then(Value::as_str).map(first_line);
            match about {
                Some(about) if !about.is_empty() => format!("- {key} ({kind}{options}): {about}"),
                _ => format!("- {key} ({kind}{options})"),
            }
        })
        .collect();
    let mut example = arguments.as_object().cloned().unwrap_or_default();
    for key in missing {
        example.insert(key.clone(), Value::String(format!("<{key}>")));
    }
    let example = json!({ "connector": connector, "tool": tool.name, "arguments": example });
    format!(
        "Not sent: `{}` requires these inside `arguments`, and they are missing:\n{}\nCall {CONNECTOR_CALL} again with every required field filled in, shaped like:\n{}",
        tool.name,
        lines.join("\n"),
        example
    )
}

fn failed(content: String) -> ToolResult {
    ToolResult { ok: false, content, metadata: None }
}

/// Run a `connector_call` against the pool.
async fn execute(connector: String, tool: String, arguments: Value, workspace: Option<String>) -> ToolResult {
    let metadata = json!({ "connector": connector, "tool": tool });
    let outcome = crate::blocking::run(move || {
        connector_pool::call(&connector, &tool, arguments, CALL_TIMEOUT, workspace.as_deref().map(Path::new))
    })
    .await;
    match outcome {
        Ok(result) => {
            let mut text = result.text;
            if text.chars().count() > MAX_RESULT_CHARS {
                text = text.chars().take(MAX_RESULT_CHARS).collect();
                text.push_str("\n[truncated]");
            }
            if text.trim().is_empty() {
                text = if result.is_error { "The tool failed without saying why." } else { "Done." }.to_string();
            }
            ToolResult { ok: !result.is_error, content: text, metadata: Some(metadata) }
        }
        Err(e) => ToolResult { ok: false, content: format!("Error: {e}"), metadata: Some(metadata) },
    }
}

/// Dispatch one connector call. A read runs at once; a tool that may write
/// asks first, through the network capability's scopes.
pub(super) async fn process<E>(
    ctx: &ToolCtx<'_>,
    call: &NormalizedToolCall,
    catalog: &Catalog,
    emit: &mut E,
) -> Result<ToolOutcome, String>
where
    E: FnMut(AgentEvent) -> Result<(), String>,
{
    let workspace = ctx.request.workspace_root.clone();
    if call.name == CONNECTOR_TOOLS {
        return Ok(ToolOutcome::Produced(catalog.describe(call)));
    }
    let (connector, tool) = target(call);
    let Some((c, t)) = catalog.tool(&connector, &tool) else {
        return Ok(ToolOutcome::Produced(failed(match catalog.connector(&connector) {
            Some(_) => format!("`{connector}` has no tool called `{tool}`. Call {CONNECTOR_TOOLS} to see what it offers."),
            None => format!("No connected connector is called `{connector}`."),
        })));
    };
    let arguments = match call.input.get("arguments") {
        None | Some(Value::Null) => stray_arguments(&call.input),
        Some(Value::Object(map)) => Value::Object(map.clone()),
        // Small models sometimes send the arguments as a JSON string.
        Some(Value::String(raw)) => match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(map)) => Value::Object(map),
            _ => return Ok(ToolOutcome::Produced(failed("`arguments` must be an object.".to_string()))),
        },
        Some(_) => return Ok(ToolOutcome::Produced(failed("`arguments` must be an object.".to_string()))),
    };
    let missing = missing_required(&t.input_schema, &arguments);
    if !missing.is_empty() {
        return Ok(ToolOutcome::Produced(failed(argument_hint(&connector, t, &arguments, &missing))));
    }
    if t.read_only == Some(true) {
        return Ok(ToolOutcome::Produced(execute(connector, tool, arguments, workspace).await));
    }

    let key = format!("mcp:{connector}/{tool}");
    let project_ok = workspace
        .as_deref()
        .map(|root| network_allowlist::is_allowed(ctx.runs_dir, root, &key).unwrap_or(false))
        .unwrap_or(false);
    match permission::precheck(ctx, permission::Capability::Network, &key, project_ok) {
        permission::Precheck::Execute(_) => {
            return Ok(ToolOutcome::Produced(execute(connector, tool, arguments, workspace).await));
        }
        permission::Precheck::AutoReject(msg) => return Ok(ToolOutcome::Produced(failed(msg.to_string()))),
        permission::Precheck::Ask => {}
    }

    let perm = PermissionRequest {
        id: permission::request_id(ctx, call),
        run_id: ctx.id.to_string(),
        tool_call_id: call.id.clone(),
        tool_name: call.name.clone(),
        input: json!({
            "target": key,
            "connector": connector,
            "connectorLabel": c.label,
            "tool": tool,
            "arguments": arguments,
        }),
        summary: format!("{tool} on {}", c.label),
        reason: format!("The agent wants to use {} on {}, which can change things there.", tool, c.label),
        options: standard_gate_options("Approve this tool for this run", "Approve this tool for this project"),
    };
    let decision = match permission::run_gate(ctx, call, Some(permission::Capability::Network), perm, emit).await? {
        permission::GateDecision::Cancelled => return Ok(ToolOutcome::Cancelled),
        decision => decision,
    };
    permission::record(ctx, permission::Capability::Network, &key, Some(&key), &decision);
    Ok(ToolOutcome::Produced(match decision {
        permission::GateDecision::Approved { .. } => execute(connector, tool, arguments, workspace).await,
        _ => failed(format!("The user declined {tool} on {}. Don't retry it; continue without it or ask.", c.label)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, read_only: Option<bool>) -> McpTool {
        McpTool {
            name: name.to_string(),
            title: None,
            description: format!("{name} does a thing.\nMore detail."),
            read_only,
            input_schema: json!({ "type": "object", "properties": { "owner": { "type": "string" } } }),
        }
    }

    /// Klide's own server id — `connectors::upsert` refuses it, so it can
    /// never name a real stored connector and a test call past the gate can
    /// never reach one (with `github`, the "approved write" test would call
    /// the user's real GitHub once they connected it).
    const TEST_ID: &str = "klide";

    fn github() -> Catalog {
        Catalog::of(vec![ConnectorTools {
            id: TEST_ID.to_string(),
            label: "GitHub".to_string(),
            instructions: None,
            tools: vec![
                tool("list_pull_requests", Some(true)),
                tool("create_pull_request", Some(false)),
                tool("unannotated", None),
            ],
        }])
    }

    fn call(name: &str, input: Value) -> NormalizedToolCall {
        NormalizedToolCall { id: "c1".to_string(), name: name.to_string(), input }
    }

    #[test]
    fn trust_follows_the_target_tool_and_silence_means_it_writes() {
        let catalog = github();
        let kind = |tool: &str| catalog.kind(&call(CONNECTOR_CALL, json!({ "connector": TEST_ID, "tool": tool })));
        assert_eq!(kind("list_pull_requests"), Some(ToolKind::ConnectorRead));
        assert_eq!(kind("create_pull_request"), Some(ToolKind::Connector));
        assert_eq!(kind("unannotated"), Some(ToolKind::Connector));
        // Unknown: fails at execution, reaches no server, so it needs no gate.
        assert_eq!(kind("nope"), Some(ToolKind::ConnectorRead));
        assert_eq!(catalog.kind(&call(CONNECTOR_TOOLS, json!({}))), Some(ToolKind::ConnectorRead));
        assert_eq!(catalog.kind(&call("read_file", json!({}))), None);
    }

    #[test]
    fn plan_may_read_a_connector_but_never_write_through_one() {
        assert!(super::super::tools::tool_allowed_in_mode(&AgentMode::Plan, ToolKind::ConnectorRead));
        assert!(!super::super::tools::tool_allowed_in_mode(&AgentMode::Plan, ToolKind::Connector));
        assert!(!super::super::tools::tool_allowed_in_mode(&AgentMode::Chat, ToolKind::ConnectorRead));
        assert!(super::super::tools::tool_allowed_in_mode(&AgentMode::Goal, ToolKind::Connector));
    }

    #[test]
    fn the_schemas_name_every_tool_but_carry_no_argument_schemas() {
        let schemas = github().schemas();
        assert_eq!(schemas.len(), 2);
        let lookup = schemas[0]["function"]["description"].as_str().unwrap();
        assert!(lookup.contains("klide (GitHub): list_pull_requests, create_pull_request"), "{lookup}");
        assert!(!serde_json::to_string(&schemas).unwrap().contains("\"owner\""));
        assert!(Catalog::default().schemas().is_empty(), "nothing connected, nothing offered");
    }

    #[test]
    fn a_lookup_lists_briefly_and_details_on_request() {
        let catalog = github();
        let brief = catalog.describe(&call(CONNECTOR_TOOLS, json!({ "connector": TEST_ID })));
        assert!(brief.content.contains("list_pull_requests [read] — list_pull_requests does a thing."), "{}", brief.content);
        assert!(brief.content.contains("create_pull_request [write]"));
        assert!(!brief.content.contains("More detail"));
        let detail = catalog.describe(&call(
            CONNECTOR_TOOLS,
            json!({ "connector": TEST_ID, "tools": ["create_pull_request", "missing_one"] }),
        ));
        assert!(detail.content.contains("\"owner\""), "{}", detail.content);
        assert!(detail.content.contains("Not on klide: missing_one"));
        assert!(!catalog.describe(&call(CONNECTOR_TOOLS, json!({ "connector": "linear" }))).ok);
    }

    /// Drive `process` against the fake supervisor. Nothing is in the
    /// connector store, so a call that gets past the gate fails with "not
    /// enabled" — which is how these tests tell "ran" from "was stopped".
    async fn dispatch(input: Value, decision: Option<&str>) -> (ToolResult, Vec<AgentEvent>) {
        dispatch_with(&github(), input, decision).await
    }

    async fn dispatch_with(catalog: &Catalog, input: Value, decision: Option<&str>) -> (ToolResult, Vec<AgentEvent>) {
        use super::super::test_support::*;
        use std::sync::{Arc, Mutex};
        let root = std::env::temp_dir().join(format!("klide-connector-gate-{}-{}", std::process::id(), super::super::transcripts::now_ms()));
        let (runs_dir, workspace) = (root.join("runs"), root.join("workspace"));
        std::fs::create_dir_all(&runs_dir).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let sup = FakeSupervisor::with_run("connector-run");
        let cancel = tokio_util::sync::CancellationToken::new();
        let request = test_request(workspace.to_str().unwrap(), &[]);
        let ctx = ToolCtx { sup: &sup, id: "connector-run", request: &request, cancel: &cancel, runs_dir: runs_dir.as_path() };
        let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
        let sink = events.clone();
        let mut emit = move |event: AgentEvent| -> Result<(), String> {
            sink.lock().unwrap().push(event);
            Ok(())
        };
        let call = call(CONNECTOR_CALL, input);
        let run = tokio::time::timeout(Duration::from_secs(15), process(&ctx, &call, catalog, &mut emit));
        let outcome = match decision {
            Some(decision) => tokio::join!(run, answer_permission(&sup, "connector-run", decision)).0,
            None => run.await,
        };
        let result = match outcome.expect("settles").expect("returns") {
            ToolOutcome::Produced(result) => result,
            ToolOutcome::Cancelled => panic!("cancelled"),
        };
        let _ = std::fs::remove_dir_all(root);
        let events = events.lock().unwrap().clone();
        (result, events)
    }

    #[tokio::test]
    async fn a_write_stops_at_the_card_and_a_refusal_never_reaches_the_server() {
        let (result, events) = dispatch(
            json!({ "connector": TEST_ID, "tool": "create_pull_request", "arguments": { "title": "x" } }),
            Some(r#"{"behavior":"deny"}"#),
        )
        .await;
        let request = events.iter().find_map(|e| match e {
            AgentEvent::PermissionRequested { request, .. } => Some(request.clone()),
            _ => None,
        });
        let request = request.expect("a write asks first");
        assert_eq!(request.summary, "create_pull_request on GitHub");
        assert_eq!(request.input["connectorLabel"], "GitHub");
        assert_eq!(request.input["target"], "mcp:klide/create_pull_request");
        assert!(!result.ok);
        assert!(result.content.contains("declined"), "{}", result.content);
    }

    #[tokio::test]
    async fn an_approved_write_and_a_read_both_reach_the_pool() {
        let (approved, events) = dispatch(
            json!({ "connector": TEST_ID, "tool": "create_pull_request" }),
            Some(r#"{"behavior":"allow","scope":"once"}"#),
        )
        .await;
        assert!(events.iter().any(|e| matches!(e, AgentEvent::PermissionResolved { .. })));
        assert!(approved.content.contains("not enabled"), "{}", approved.content);

        let (read, events) = dispatch(json!({ "connector": TEST_ID, "tool": "list_pull_requests" }), None).await;
        assert!(events.is_empty(), "a read-only tool asks nothing: {events:?}");
        assert!(read.content.contains("not enabled"), "{}", read.content);
    }

    fn pull_request_read() -> McpTool {
        McpTool {
            input_schema: json!({
                "type": "object",
                "properties": {
                    "method": { "type": "string", "enum": ["get", "get_diff"], "description": "Action to specify what pull request data to read.\nPossible options: …" },
                    "owner": { "type": "string" },
                    "pullNumber": { "type": "number", "description": "Pull request number" }
                },
                "required": ["method", "owner", "pullNumber"]
            }),
            ..tool("pull_request_read", Some(true))
        }
    }

    #[test]
    fn a_call_missing_required_fields_names_each_one_and_the_whole_call() {
        let t = pull_request_read();
        let sent = json!({ "owner": "mattpocock", "pullNumber": null });
        let missing = missing_required(&t.input_schema, &sent);
        assert_eq!(missing, ["method", "pullNumber"]);
        let hint = argument_hint("github", &t, &sent, &missing);
        assert!(hint.contains("- method (string, one of: get, get_diff): Action to specify what pull request data to read."), "{hint}");
        assert!(hint.contains("- pullNumber (number): Pull request number"), "{hint}");
        assert!(!hint.contains("- owner"), "{hint}");
        assert!(hint.contains(r#""owner":"mattpocock""#) && hint.contains(r#""method":"<method>""#), "{hint}");
        assert!(missing_required(&t.input_schema, &json!({ "method": "get", "owner": "o", "pullNumber": 1 })).is_empty());
        assert!(missing_required(&json!({ "type": "object" }), &json!({})).is_empty(), "no `required`, nothing to check");
    }

    #[test]
    fn arguments_left_beside_connector_and_tool_are_taken_as_the_arguments() {
        let input = json!({ "connector": "github", "tool": "pull_request_read", "method": "get", "pullNumber": 1316 });
        assert_eq!(stray_arguments(&input), json!({ "method": "get", "pullNumber": 1316 }));
        assert_eq!(stray_arguments(&json!({ "connector": "github", "tool": "x" })), json!({}));
    }

    #[tokio::test]
    async fn an_empty_call_is_answered_here_and_never_reaches_the_server() {
        let catalog = Catalog::of(vec![ConnectorTools {
            id: TEST_ID.to_string(),
            label: "GitHub".to_string(),
            instructions: None,
            tools: vec![pull_request_read()],
        }]);
        let (result, events) = dispatch_with(&catalog, json!({ "connector": TEST_ID, "tool": "pull_request_read" }), None).await;
        assert!(events.is_empty());
        assert!(!result.ok);
        assert!(result.content.starts_with("Not sent:"), "{}", result.content);
        assert!(!result.content.contains("not enabled"), "the pool was never called: {}", result.content);
    }

    #[test]
    fn only_a_conversation_outside_chat_is_offered_connectors() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for (mode, lineage) in [
            (AgentMode::Chat, RunLineage::Conversation),
            (AgentMode::Goal, RunLineage::MissionAttempt),
            (AgentMode::Goal, RunLineage::SubagentChild),
        ] {
            let mut subject = GateSubject::for_mode(mode);
            subject.lineage = lineage;
            // Returns before the pool is consulted, so no connector starts.
            assert!(rt.block_on(Catalog::load(&subject, None)).is_empty());
        }
    }
}
