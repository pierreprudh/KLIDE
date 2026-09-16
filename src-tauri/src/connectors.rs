//! Connectors — the MCP servers Klide itself connects *to*.
//!
//! A connector is one named MCP server plus the decision to use it. The config
//! lives in `~/.klide/connectors.json`, the same `~/.klide` home the skills
//! loader and the custom-provider store already use, and looks a lot like the
//! `mcpServers` block every other tool writes — deliberately, because the most
//! valuable thing this module does is **not** ask the user to type it again.
//!
//! [`discover`] reads the MCP config the user already has — Claude Code's
//! `~/.claude.json` and a project's `.mcp.json`, Codex's `~/.codex/config.toml`,
//! OpenCode's `opencode.json` — and offers each entry for import. Reading only:
//! Klide never edits another tool's config file. Importing copies the launch
//! spec into Klide's own store, so a later change there is Klide's, and
//! removing a connector here never touches the file it came from.
//!
//! Klide's own `klide mcp coordination` entry is filtered out of discovery
//! everywhere. It is the server Klide *serves* to a Delegate (`mcp_server.rs`),
//! and a connector pointing back at this app would be a loop, not a capability.
//!
//! Storage is non-secret by design, like `custom_providers.rs`: a connector's
//! `env` is exactly what the source config held. A token that lives in another
//! tool's config file is already on disk in plain text — Klide copying it does
//! not make that worse, but it is why a connector's env is shown in the UI as
//! the sensitive thing it is rather than folded away.

use crate::mcp_client::{Probe, StdioServer, PROBE_TIMEOUT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The id Klide's own embedded server is registered under in every CLI's
/// config (`delegate::Delegate::mcp_wiring`). Never a connector.
const OWN_SERVER_ID: &str = "klide";

/// One MCP server Klide may use. `id` is a slug, unique in the store, and the
/// name the Harness will eventually namespace this server's tools under.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    /// What the user sees. Defaults to the id when imported.
    pub label: String,
    pub server: StdioServer,
    /// A disabled connector stays in the store with its config intact — the
    /// off switch for one flaky server, not a reason to retype it later.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Where this came from: `manual`, or the tool whose config it was
    /// imported from. Shown on the row, and the reason an import can tell the
    /// user "you already have this" instead of silently duplicating it.
    #[serde(default)]
    pub origin: String,
}

fn yes() -> bool {
    true
}

/// A server found in someone else's config that Klide does not have yet.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub id: String,
    pub label: String,
    pub origin: String,
    /// The file it was read from, shown so an import is never a mystery.
    pub source_path: String,
    pub server: StdioServer,
    /// True when a connector with this id is already in Klide's store.
    pub already_added: bool,
}

/// `~/.klide/connectors.json`.
fn store_path() -> Option<PathBuf> {
    crate::cli::home_dir_path().map(|home| home.join(".klide").join("connectors.json"))
}

/// Read the store. A missing or unreadable file is "no connectors", not an
/// error — the feature is opt-in and the file appears with the first one.
pub fn list() -> Vec<Connector> {
    let Some(path) = store_path() else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_all(connectors: &[Connector]) -> Result<(), String> {
    let path = store_path().ok_or_else(|| "Could not resolve home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {parent:?}: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(connectors).map_err(|e| e.to_string())?;
    // Private mode: a connector's env is where an imported API token ends up.
    crate::durable::write_atomic_private(&path, &json)
}

/// Insert or replace one connector, keyed by id. Returns the whole store so a
/// caller re-renders from one answer.
pub fn upsert(mut connector: Connector) -> Result<Vec<Connector>, String> {
    connector.id = slug(&connector.id);
    if connector.id.is_empty() {
        return Err("A connector needs a name".to_string());
    }
    if connector.id == OWN_SERVER_ID {
        return Err(format!(
            "`{OWN_SERVER_ID}` is Klide's own server, which it serves to delegate CLIs. Pick another name."
        ));
    }
    if connector.server.command.trim().is_empty() {
        return Err("A connector needs a command to run".to_string());
    }
    if connector.label.trim().is_empty() {
        connector.label = connector.id.clone();
    }
    let mut all = list();
    match all.iter_mut().find(|c| c.id == connector.id) {
        Some(existing) => *existing = connector,
        None => all.push(connector),
    }
    all.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    write_all(&all)?;
    Ok(all)
}

/// Drop one connector. Removing something Klide never had is not an error —
/// the caller's intent ("it should not be there") already holds.
pub fn remove(id: &str) -> Result<Vec<Connector>, String> {
    let mut all = list();
    all.retain(|c| c.id != id);
    write_all(&all)?;
    Ok(all)
}

/// Lowercase, `-`-separated, safe as a filename and as a tool-name prefix.
fn slug(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/* --------------------------------------------------------------- discovery --*/

/// Every MCP server configured in the tools Klide already drives, minus the
/// ones already imported. `workspace` scopes the project-local sources; `None`
/// reads only the user-level ones.
pub fn discover(workspace: Option<&Path>) -> Vec<Discovered> {
    let existing = list();
    let mut found: Vec<Discovered> = Vec::new();
    let mut push = |mut candidate: Discovered| {
        if candidate.id == OWN_SERVER_ID || candidate.server.command.trim().is_empty() {
            return;
        }
        // First source wins. A server configured in three CLIs is one offer,
        // labelled with wherever it was seen first, not three identical rows.
        if found.iter().any(|f| f.id == candidate.id) {
            return;
        }
        candidate.already_added = existing.iter().any(|c| c.id == candidate.id);
        found.push(candidate);
    };

    if let Some(home) = crate::cli::home_dir_path() {
        let claude = home.join(".claude.json");
        for candidate in from_claude_json(&claude, workspace) {
            push(candidate);
        }
        for candidate in from_mcp_servers_file(&home.join(".mcp.json"), "claude-code") {
            push(candidate);
        }
        for candidate in from_codex_toml(&home.join(".codex").join("config.toml")) {
            push(candidate);
        }
        for path in [
            home.join(".config").join("opencode").join("opencode.json"),
            home.join(".config").join("opencode").join("cli.json"),
        ] {
            for candidate in from_opencode_json(&path) {
                push(candidate);
            }
        }
    }
    if let Some(workspace) = workspace {
        for candidate in from_mcp_servers_file(&workspace.join(".mcp.json"), "workspace") {
            push(candidate);
        }
        for candidate in from_opencode_json(&workspace.join("opencode.json")) {
            push(candidate);
        }
    }
    found.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    found
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The `{ "mcpServers": { name: { command, args, env } } }` shape — Claude
/// Code's `.mcp.json`, and the block Klide itself writes for a delegate.
fn from_mcp_servers_file(path: &Path, origin: &str) -> Vec<Discovered> {
    let Some(json) = read_json(path) else {
        return Vec::new();
    };
    mcp_servers_block(json.get("mcpServers"), origin, path)
}

/// Claude Code's `~/.claude.json`: user-level servers at the top, plus a
/// per-project block keyed by absolute path. Both are real places a user's
/// connectors live, so both are offered — the project's only when its path is
/// the workspace open right now.
fn from_claude_json(path: &Path, workspace: Option<&Path>) -> Vec<Discovered> {
    let Some(json) = read_json(path) else {
        return Vec::new();
    };
    let mut found = mcp_servers_block(json.get("mcpServers"), "claude-code", path);
    if let Some(workspace) = workspace.and_then(|w| w.to_str()) {
        let project = json.get("projects").and_then(|p| p.get(workspace));
        found.extend(mcp_servers_block(
            project.and_then(|p| p.get("mcpServers")),
            "claude-code",
            path,
        ));
    }
    found
}

fn mcp_servers_block(block: Option<&Value>, origin: &str, path: &Path) -> Vec<Discovered> {
    let Some(map) = block.and_then(Value::as_object) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(name, entry)| {
            // A remote connector (`"type": "http"`, `"url": …`) is real config
            // but not something this slice can launch. Skipped rather than
            // imported as a broken stdio row; the transport lands with the
            // HTTP variant in mcp_client.rs.
            let command = entry.get("command")?;
            Some(discovered(
                name,
                origin,
                path,
                StdioServer {
                    command: command.as_str()?.to_string(),
                    args: string_list(entry.get("args")),
                    env: string_map(entry.get("env")),
                    cwd: None,
                },
            ))
        })
        .collect()
}

/// OpenCode keeps its servers under `mcp` (v1) or `mcp.servers` (v2), with the
/// program and its arguments in one `command` array and the environment under
/// `environment`.
fn from_opencode_json(path: &Path) -> Vec<Discovered> {
    let Some(json) = read_json(path) else {
        return Vec::new();
    };
    let block = json
        .get("mcp")
        .and_then(|mcp| mcp.get("servers").or(Some(mcp)))
        .and_then(Value::as_object);
    let Some(map) = block else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(name, entry)| {
            let mut command = string_list(entry.get("command"));
            if command.is_empty() {
                return None;
            }
            Some(discovered(
                name,
                "opencode",
                path,
                StdioServer {
                    command: command.remove(0),
                    args: command,
                    env: string_map(entry.get("environment").or_else(|| entry.get("env"))),
                    cwd: None,
                },
            ))
        })
        .collect()
}

fn discovered(name: &str, origin: &str, path: &Path, server: StdioServer) -> Discovered {
    Discovered {
        id: slug(name),
        label: name.to_string(),
        origin: origin.to_string(),
        source_path: path.to_string_lossy().to_string(),
        server,
        already_added: false,
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/* ------------------------------------------------------------- codex toml --*/

/// Codex writes `[mcp_servers.<name>]` blocks in `~/.codex/config.toml`.
///
/// Read by hand rather than with a TOML crate: a handful of key shapes in one
/// table kind, from a file Klide only ever reads. Anything it does not
/// understand is skipped, which is the right failure — a connector Klide cannot
/// offer is a missing row, never a broken import.
///
/// Two shapes both appear in the wild and both matter, because a connector
/// imported without its environment starts and then fails at the first call:
/// `env = { KEY = "v" }` inline, and a `[mcp_servers.<name>.env]` sub-table.
fn from_codex_toml(path: &Path) -> Vec<Discovered> {
    /// Which table the reader is inside. Any other sub-table of a server
    /// (`.tool_timeouts`, a future one) is ignored without ending the server.
    enum In {
        Server,
        Env,
        Other,
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut current: Option<(String, StdioServer)> = None;
    let mut section = In::Other;
    let flush = |current: &mut Option<(String, StdioServer)>, found: &mut Vec<Discovered>| {
        if let Some((name, server)) = current.take() {
            if !server.command.is_empty() {
                found.push(discovered(&name, "codex", path, server));
            }
        }
    };
    for line in text.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let Some(rest) = header.strip_prefix("mcp_servers.") else {
                flush(&mut current, &mut found);
                section = In::Other;
                continue;
            };
            match rest.split_once('.') {
                // A sub-table of the server being read.
                Some((name, "env")) if current.as_ref().is_some_and(|(c, _)| c == &unquote(name)) => {
                    section = In::Env;
                }
                Some(_) => section = In::Other,
                None => {
                    flush(&mut current, &mut found);
                    current = Some((unquote(rest).to_string(), StdioServer::default()));
                    section = In::Server;
                }
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let Some((_, server)) = current.as_mut() else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match section {
            In::Env => {
                server.env.insert(unquote(key).to_string(), unquote(value).to_string());
            }
            In::Server => match key {
                "command" => server.command = unquote(value).to_string(),
                "args" => server.args = toml_string_array(value),
                "env" => server.env = toml_inline_table(value),
                // A relative cwd is relative to the CLI that wrote it, which is
                // not Klide — only an absolute one can be carried over.
                "cwd" => {
                    let cwd = unquote(value);
                    if Path::new(cwd).is_absolute() {
                        server.cwd = Some(cwd.to_string());
                    }
                }
                _ => {}
            },
            In::Other => {}
        }
    }
    flush(&mut current, &mut found);
    found
}

fn unquote(raw: &str) -> &str {
    raw.trim().trim_matches('"').trim_matches('\'')
}

fn toml_string_array(raw: &str) -> Vec<String> {
    raw.trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(unquote)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn toml_inline_table(raw: &str) -> BTreeMap<String, String> {
    raw.trim_start_matches('{')
        .trim_end_matches('}')
        .split(',')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            let (k, v) = (unquote(k), unquote(v));
            (!k.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

/* ---------------------------------------------------------------- commands --*/

#[tauri::command]
pub(crate) async fn connectors_list() -> Result<Vec<Connector>, String> {
    crate::blocking::run(|| Ok(list())).await
}

#[tauri::command]
pub(crate) async fn connectors_upsert(connector: Connector) -> Result<Vec<Connector>, String> {
    crate::blocking::run(move || upsert(connector)).await
}

#[tauri::command]
pub(crate) async fn connectors_remove(id: String) -> Result<Vec<Connector>, String> {
    crate::blocking::run(move || remove(&id)).await
}

#[tauri::command]
pub(crate) async fn connectors_discover(workspace: Option<String>) -> Result<Vec<Discovered>, String> {
    crate::blocking::run(move || Ok(discover(workspace.as_deref().map(Path::new)))).await
}

/// Start one connector, ask what it can do, stop it. The page calls this for a
/// row the user asks about — never on a loop, because each call is a process
/// spawn and, the first time, an `npx` download.
#[tauri::command]
pub(crate) async fn connectors_probe(server: StdioServer) -> Result<Probe, String> {
    crate::blocking::run(move || crate::mcp_client::probe(&server, PROBE_TIMEOUT)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-connectors-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_the_mcp_servers_shape_every_tool_writes() {
        let dir = temp_dir("mcp-json");
        let path = write(
            &dir,
            ".mcp.json",
            r#"{"mcpServers":{"Linear":{"command":"npx","args":["-y","linear-mcp"],"env":{"LINEAR_KEY":"abc"}}}}"#,
        );
        let found = from_mcp_servers_file(&path, "workspace");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "linear");
        assert_eq!(found[0].label, "Linear");
        assert_eq!(found[0].server.command, "npx");
        assert_eq!(found[0].server.args, ["-y", "linear-mcp"]);
        assert_eq!(found[0].server.env["LINEAR_KEY"], "abc");
    }

    #[test]
    fn a_remote_connector_is_skipped_not_imported_broken() {
        let dir = temp_dir("remote");
        let path = write(
            &dir,
            ".mcp.json",
            r#"{"mcpServers":{"notion":{"type":"http","url":"https://mcp.notion.com/mcp"}}}"#,
        );
        assert!(from_mcp_servers_file(&path, "workspace").is_empty());
    }

    #[test]
    fn reads_codex_toml_blocks() {
        let dir = temp_dir("codex");
        let path = write(
            &dir,
            "config.toml",
            r#"
model = "gpt-5"

[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest"]
env = { PW_HEADLESS = "1" }

[other_table]
command = "not-a-connector"
"#,
        );
        let found = from_codex_toml(&path);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].id, "playwright");
        assert_eq!(found[0].server.args, ["-y", "@playwright/mcp@latest"]);
        assert_eq!(found[0].server.env["PW_HEADLESS"], "1");
    }

    /// The shape Codex actually writes for a server with an environment — the
    /// env is a *sub-table*, and reading it as a new server would both lose the
    /// env and invent a connector called `node_repl.env`.
    #[test]
    fn a_codex_env_sub_table_belongs_to_the_server_above_it() {
        let dir = temp_dir("codex-env");
        let path = write(
            &dir,
            "config.toml",
            r#"
[mcp_servers.node_repl]
command = "/opt/node_repl"
args = []
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_NODE_PATH = "/opt/node"
CODEX_HOME = "/Users/x/.codex"

[mcp_servers.computer-use]
command = "/opt/sky"
args = ["mcp"]
cwd = "."

[features]
web_search = true
"#,
        );
        let found = from_codex_toml(&path);
        let ids: Vec<&str> = found.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["node-repl", "computer-use"], "{ids:?}");
        assert_eq!(found[0].server.env["NODE_REPL_NODE_PATH"], "/opt/node");
        assert_eq!(found[0].server.env["CODEX_HOME"], "/Users/x/.codex");
        // A relative cwd means "wherever Codex ran", which Klide cannot honour.
        assert_eq!(found[1].server.cwd, None);
    }

    #[test]
    fn reads_opencodes_command_array() {
        let dir = temp_dir("opencode");
        let path = write(
            &dir,
            "opencode.json",
            r#"{"mcp":{"fs":{"type":"local","command":["uvx","mcp-server-fs","/tmp"],"environment":{"A":"b"}}}}"#,
        );
        let found = from_opencode_json(&path);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].server.command, "uvx");
        assert_eq!(found[0].server.args, ["mcp-server-fs", "/tmp"]);
        assert_eq!(found[0].server.env["A"], "b");
    }

    #[test]
    fn claude_project_servers_come_from_the_open_workspace_only() {
        let dir = temp_dir("claude");
        let path = write(
            &dir,
            ".claude.json",
            r#"{"mcpServers":{"global":{"command":"a"}},
                "projects":{"/work/here":{"mcpServers":{"here":{"command":"b"}}},
                            "/work/elsewhere":{"mcpServers":{"elsewhere":{"command":"c"}}}}}"#,
        );
        let ids: Vec<String> = from_claude_json(&path, Some(Path::new("/work/here")))
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert!(ids.contains(&"global".to_string()), "{ids:?}");
        assert!(ids.contains(&"here".to_string()), "{ids:?}");
        assert!(!ids.contains(&"elsewhere".to_string()), "{ids:?}");
    }

    #[test]
    fn klides_own_server_is_never_a_connector() {
        let dir = temp_dir("own");
        let path = write(
            &dir,
            ".mcp.json",
            r#"{"mcpServers":{"klide":{"command":"/Applications/Klide.app/Contents/MacOS/klide","args":["mcp","coordination"]}}}"#,
        );
        // The reader sees it; `discover`'s filter is what drops it, so assert
        // the filter rather than the reader.
        assert_eq!(from_mcp_servers_file(&path, "claude-code").len(), 1);
        assert!(upsert(Connector {
            id: "klide".to_string(),
            label: "Klide".to_string(),
            server: StdioServer::default(),
            enabled: true,
            origin: "manual".to_string(),
        })
        .is_err());
    }

    #[test]
    fn ids_are_slugs_so_a_tool_prefix_is_always_safe() {
        assert_eq!(slug("  Linear MCP! "), "linear-mcp");
        assert_eq!(slug("@playwright/mcp"), "playwright-mcp");
        assert_eq!(slug("---"), "");
    }
}
