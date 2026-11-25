//! Klide's connectors, served to a Delegate CLI — `klide mcp connectors`.
//!
//! A Harness Run reaches the connectors the user switched on through two Tools
//! (`agent/connector_tools.rs`). A Delegate (Claude Code, Codex, OpenCode, …)
//! has its own MCP client, so it gets them the way it gets any MCP server: a
//! stdio child, here a second `klide mcp` server beside the coordination one,
//! listing each connected tool under its own name with its own schema.
//!
//! The child owns nothing and holds no credential. `tools/list` and
//! `tools/call` travel over the same authenticated loopback as the
//! coordination tools (`coordination_bridge.rs`); the bridge answers them from
//! the app's connector pool, which resolves `${KLIDE_OAUTH}` and every other
//! reference in-process. No token is ever written into a CLI's config, argv or
//! environment.
//!
//! Approval is the CLI's own, exactly as for an MCP server the user added to it
//! by hand: this server is a sibling of `klide`, not part of it, so Claude
//! Code's pre-approval of `mcp__klide` (Klide's own coordination tools) does
//! not cover it — a headless turn's prompt lands on Klide's card through the
//! permission relay, a terminal session asks in the terminal. Each tool keeps
//! the server's `readOnlyHint`, for a CLI that reads it.

use crate::connector_pool::{self, ConnectorTools};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;

/// The server's name in every CLI's config. Not `klide-…`: Claude Code's
/// `mcp__klide` allow rule must never reach it.
pub const SERVER_NAME: &str = "connectors";

/// The `klide mcp <arg>` that starts this server.
pub const SUBCOMMAND: &str = "connectors";

/// How long `tools/list` waits for connectors that are still connecting. The
/// pool is warmed at boot, so this is only paid on a cold start.
const READY_WAIT: Duration = Duration::from_secs(8);

/// How long one call may take — inside the MCP child's own bridge timeout.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// The most text one call returns, as for a Harness Run.
const MAX_RESULT_CHARS: usize = 200_000;

/// Claude Code names a tool `mcp__<server>__<tool>` and refuses one past 64
/// characters, so the part this server chooses has what is left.
const MAX_NAME: usize = 64 - "mcp__".len() - SERVER_NAME.len() - "__".len();

/// `<connector>__<tool>`, in the characters every CLI accepts. A name too long
/// for Claude Code is cut and keeps a short digest of the whole, so two long
/// names never collapse into one.
pub fn exposed_name(connector: &str, tool: &str) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect()
    };
    let name = format!("{}__{}", clean(connector), clean(tool));
    if name.len() <= MAX_NAME {
        return name;
    }
    let digest = Sha256::digest(name.as_bytes());
    let tag: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{}_{tag}", &name[..MAX_NAME - tag.len() - 1])
}

/// The MCP `tools` array for what is connected.
pub fn tools(connectors: &[ConnectorTools]) -> Value {
    let mut out = Vec::new();
    for connector in connectors {
        for tool in &connector.tools {
            let shown = tool.title.as_deref().unwrap_or(&tool.name);
            let schema = if tool.input_schema.is_object() {
                tool.input_schema.clone()
            } else {
                json!({ "type": "object" })
            };
            let mut entry = json!({
                "name": exposed_name(&connector.id, &tool.name),
                "title": format!("{}: {shown}", connector.label),
                "description": format!("[{}] {}", connector.label, tool.description.trim()),
                "inputSchema": schema,
            });
            if let Some(read_only) = tool.read_only {
                entry["annotations"] = json!({ "readOnlyHint": read_only });
            }
            out.push(entry);
        }
    }
    Value::Array(out)
}

/// Which connector and tool an exposed name stands for — by building every
/// name again, never by splitting one, so a connector id holding `__` cannot
/// mislead it.
pub fn resolve(connectors: &[ConnectorTools], name: &str) -> Option<(String, String)> {
    connectors.iter().find_map(|connector| {
        connector
            .tools
            .iter()
            .find(|tool| exposed_name(&connector.id, &tool.name) == name)
            .map(|tool| (connector.id.clone(), tool.name.clone()))
    })
}

/// `tools/list`, answered in the app for the bridge.
pub fn list(workspace: &str) -> Value {
    tools(&connector_pool::ready(READY_WAIT, Some(Path::new(workspace))))
}

/// `tools/call`, answered in the app for the bridge. The tool's own failure is
/// an error, so the MCP child marks the result `isError`.
pub fn call(workspace: &str, name: &str, arguments: Value) -> Result<Value, String> {
    // The catalog as it stands: a call needs no new handshake to be resolved.
    let connectors = connector_pool::ready(Duration::ZERO, Some(Path::new(workspace)));
    let (connector, tool) = resolve(&connectors, name).ok_or_else(|| {
        format!("`{name}` is not a tool of a connector that is on in Klide right now. List the tools again.")
    })?;
    let arguments = if arguments.is_object() { arguments } else { json!({}) };
    let result = connector_pool::call(&connector, &tool, arguments, CALL_TIMEOUT, Some(Path::new(workspace)))?;
    let mut text = result.text;
    if text.chars().count() > MAX_RESULT_CHARS {
        text = text.chars().take(MAX_RESULT_CHARS).collect();
        text.push_str("\n[truncated]");
    }
    if result.is_error {
        return Err(if text.trim().is_empty() { "The tool failed without saying why.".to_string() } else { text });
    }
    if text.trim().is_empty() {
        text = "Done.".to_string();
    }
    Ok(json!({ "text": text, "connector": connector, "tool": tool }))
}

/// Whether a Delegate session should be handed this server at all: only when
/// something is switched on, so a CLI without connectors sees no empty server.
pub fn any_enabled() -> bool {
    crate::connectors::list().iter().any(|c| c.enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_client::McpTool;

    fn tool(name: &str, read_only: Option<bool>) -> McpTool {
        McpTool {
            name: name.into(),
            title: None,
            description: format!("does {name}"),
            read_only,
            input_schema: json!({ "type": "object", "properties": { "q": { "type": "string" } } }),
        }
    }

    fn catalog() -> Vec<ConnectorTools> {
        vec![
            ConnectorTools {
                id: "notion".into(),
                label: "Notion".into(),
                instructions: None,
                tools: vec![tool("notion-search", Some(true)), tool("notion-create-pages", None)],
            },
            ConnectorTools {
                id: "hugging face".into(),
                label: "Hugging Face".into(),
                instructions: None,
                tools: vec![tool("hub.search", Some(true))],
            },
        ]
    }

    #[test]
    fn each_tool_is_listed_under_its_connector_with_its_schema_and_hint() {
        let listed = tools(&catalog());
        let names: Vec<&str> = listed.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["notion__notion-search", "notion__notion-create-pages", "hugging_face__hub_search"]);
        assert_eq!(listed[0]["annotations"]["readOnlyHint"], true);
        // Silence stays silence: a tool that didn't say is not called read-only.
        assert!(listed[1].get("annotations").is_none());
        assert_eq!(listed[0]["inputSchema"]["properties"]["q"]["type"], "string");
        assert!(listed[0]["description"].as_str().unwrap().starts_with("[Notion] "));
    }

    #[test]
    fn a_name_comes_back_to_the_connector_and_tool_it_was_built_from() {
        let c = catalog();
        assert_eq!(resolve(&c, "notion__notion-create-pages"), Some(("notion".into(), "notion-create-pages".into())));
        assert_eq!(resolve(&c, "hugging_face__hub_search"), Some(("hugging face".into(), "hub.search".into())));
        assert_eq!(resolve(&c, "notion__nope"), None);
    }

    #[test]
    fn a_long_name_fits_claude_codes_limit_and_stays_unique() {
        let long = "x".repeat(80);
        let a = exposed_name("github", &format!("{long}_a"));
        let b = exposed_name("github", &format!("{long}_b"));
        assert!(a.len() <= MAX_NAME && b.len() <= MAX_NAME);
        assert_ne!(a, b);
        assert!(format!("mcp__{SERVER_NAME}__{a}").len() <= 64);
    }

    #[test]
    fn the_server_name_is_outside_klides_own_allow_rule() {
        // `mcp__klide` pre-approves Klide's coordination server in a headless
        // Claude Code turn; connectors must keep asking.
        assert!(!SERVER_NAME.starts_with("klide"));
    }
}
