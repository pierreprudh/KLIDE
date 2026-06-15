use super::todo;
use super::types::{AgentMode, DiffProposal, ToolResult};
use crate::workspace::Workspace;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

// ── Per-run file snapshot store (omp's `#tag` staleness guard, lite) ──────
// Records the content hash of every file the model has read or written, keyed
// `run_id → workspace-relative path → hash`. write_file consults it to flag an
// edit aimed at a file that changed since the model last saw it. In-memory
// only; an entry is reset at the start of its run.

fn snapshot_store() -> &'static Mutex<HashMap<String, HashMap<String, String>>> {
    static STORE: OnceLock<Mutex<HashMap<String, HashMap<String, String>>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forget every snapshot for a run. Called once at the top of a fresh run so a
/// reused id never inherits a previous run's hashes.
pub fn clear_run_snapshots(run_id: &str) {
    if let Ok(mut store) = snapshot_store().lock() {
        store.remove(run_id);
    }
}

/// Remember that `rel_path` hashed to `hash` the last time the model saw it.
fn record_snapshot(run_id: &str, rel_path: &str, hash: &str) {
    if run_id.is_empty() {
        return;
    }
    if let Ok(mut store) = snapshot_store().lock() {
        store
            .entry(run_id.to_string())
            .or_default()
            .insert(rel_path.to_string(), hash.to_string());
    }
}

/// The hash this file had when the model last read or wrote it this run.
fn last_seen_hash(run_id: &str, rel_path: &str) -> Option<String> {
    let store = snapshot_store().lock().ok()?;
    store.get(run_id)?.get(rel_path).cloned()
}

const MAX_FILE_BYTES: u64 = 220_000;
const MAX_LIST_ENTRIES: usize = 500;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_WALK_FILES: usize = 6_000;
const MAX_WRITE_BYTES: u64 = 220_000;

#[derive(Clone, Debug)]
pub struct NormalizedToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

// ── Tool registry ───────────────────────────────────────────────────────
// Each tool is defined once: its kind, its schema, and its execution function
// live in the same entry. The frontend fetches schemas over IPC instead of
// maintaining its own copy — no drift between the two sides.

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    ReadOnly,
    Write,
    // Pauses the run for user input (Q&A today; future: confirmation prompts).
    // The registry is the source of truth — the harness dispatches on kind, not
    // by name. A Pause entry has no run_read / run_write_preview; the harness's
    // pause arm handles the interaction.
    Pause,
}

// Tool executions receive a `Workspace`, never a raw root string — resolving
// a path without going through the Workspace-rooted checks is unrepresentable.
type ReadToolFn = fn(ws: &Workspace, input: &serde_json::Value) -> ToolResult;
type WritePreviewFn =
    fn(ws: &Workspace, input: &serde_json::Value, run_id: &str) -> Result<DiffProposal, ToolResult>;

// Per-tool one-liner rendered on the `ToolCallStarted` event. Each entry owns
// its own display logic; the harness stops carrying per-tool arg keys.
type SummaryFn = fn(call: &NormalizedToolCall) -> String;

fn default_summary(call: &NormalizedToolCall) -> String {
    call.name.clone()
}

fn path_summary(call: &NormalizedToolCall) -> String {
    call.input
        .get("path")
        .and_then(|v| v.as_str())
        .map(|path| format!("{} {}", call.name, path))
        .unwrap_or_else(|| call.name.clone())
}

fn pattern_summary(call: &NormalizedToolCall) -> String {
    call.input
        .get("pattern")
        .and_then(|v| v.as_str())
        .map(|pattern| format!("{} {}", call.name, pattern))
        .unwrap_or_else(|| call.name.clone())
}

struct ToolEntry {
    kind: ToolKind,
    schema: serde_json::Value,
    run_read: Option<ReadToolFn>,
    run_write_preview: Option<WritePreviewFn>,
    summary: SummaryFn,
}

fn schema(
    name: &str,
    description: &str,
    properties: serde_json::Value,
    required: &[&str],
) -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            }
        }
    })
}

fn registry() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("read_file", "Read the full text contents of a file in the workspace.",
                serde_json::json!({ "path": { "type": "string", "description": "Workspace-relative file path." } }),
                &["path"]),
            run_read: Some(|ws, input| read_file(ws, &trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string()))),
            run_write_preview: None,
            summary: path_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("list_dir", "List entries in a workspace directory.",
                serde_json::json!({ "path": { "type": "string", "description": "Workspace-relative directory path. Use . for the root." } }),
                &["path"]),
            run_read: Some(|ws, input| list_dir(ws, &trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string()))),
            run_write_preview: None,
            summary: path_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("glob", "Find workspace files matching a glob-like pattern. Supports * and ? wildcards.",
                serde_json::json!({
                    "pattern": { "type": "string", "description": "Pattern such as src/**/*.ts or *.md." },
                    "path": { "type": "string", "description": "Optional workspace-relative directory to search from." }
                }),
                &["pattern"]),
            run_read: Some(glob),
            run_write_preview: None,
            summary: pattern_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("grep", "Search text files in the workspace for a literal pattern.",
                serde_json::json!({
                    "pattern": { "type": "string", "description": "Text pattern to search for." },
                    "path": { "type": "string", "description": "Optional workspace-relative file or directory." },
                    "maxResults": { "type": "number", "description": "Optional cap on returned matches." }
                }),
                &["pattern"]),
            run_read: Some(grep),
            run_write_preview: None,
            summary: pattern_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("get_git_status", "Return git branch and changed files for the workspace.",
                serde_json::json!({}), &[]),
            run_read: Some(|ws, _input| get_git_status(ws.root())),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("get_git_diff", "Return git diff for the workspace or one path.",
                serde_json::json!({
                    "path": { "type": "string", "description": "Optional workspace-relative path." },
                    "staged": { "type": "boolean", "description": "Whether to read staged diff." }
                }),
                &[]),
            run_read: Some(|ws, input| get_git_diff(ws.root(), input)),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("get_git_log", "Return recent commit history (hash, subject, relative date, author) so you can understand how the codebase has been evolving. Use this to learn what recent work led to the current state.",
                serde_json::json!({
                    "count": { "type": "integer", "description": "How many commits to return (default 20, max 100)." },
                    "path": { "type": "string", "description": "Optional workspace-relative path to limit history to one file or folder." }
                }),
                &[]),
            run_read: Some(|ws, input| get_git_log(ws.root(), input)),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("clean_context", "Discard tool results that led nowhere (a Glob with 300 paths, a read of the wrong file, a search that came up empty). Each removed result is replaced by '[cleaned: tool_name]' so the agent knows it threw something away. Only the current turn is affected, keeping the prompt cache intact.",
                serde_json::json!({
                    "ids": { "type": "array", "description": "List of tool_call_ids to clean from the current turn." }
                }),
                &["ids"]),
            run_read: Some(|_ws, input| {
                let ids: Vec<String> = input.get("ids")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                ok(format!("Context cleaned: {} tool result(s) marked for removal", ids.len()))
            }),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("web_search", "Search the web for documentation or current information. Returns up to 10 results with title, URL, and snippet.",
                serde_json::json!({
                    "query": { "type": "string", "description": "The search query." }
                }),
                &["query"]),
            run_read: Some(|_ws, input| web_search(input)),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("web_fetch", "Fetch the content of a URL and return it as text. Use for reading documentation, blog posts, or API references.",
                serde_json::json!({
                    "url": { "type": "string", "description": "The URL to fetch." }
                }),
                &["url"]),
            run_read: Some(|_ws, input| web_fetch(input)),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("get_todo_list", "Read the current TODO list. Each item has an id (e.g. T1, T2) and a done/pending status. Returns empty if no todos exist.",
                serde_json::json!({}), &[]),
            run_read: Some(|ws, _input| {
                let root = ws.root().to_string_lossy();
                match todo::list_todos_text(&root) {
                    Some(text) => ok(format!("TODO list:\n{text}")),
                    None => ok("No todos yet. Use update_todo_list to add one.".to_string()),
                }
            }),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("update_todo_list", "Add, complete, uncomplete, edit, remove, or clear todos. This directly modifies the project's task list for multi-session continuity. Returns the updated list.",
                serde_json::json!({
                    "action": {
                        "type": "string",
                        "enum": ["add", "complete", "uncomplete", "edit", "remove", "clear_done"],
                        "description": "add=create new, complete=mark done, uncomplete=mark pending, edit=change text, remove=delete by id, clear_done=remove all completed."
                    },
                    "id": { "type": "string", "description": "Item id (e.g. T1). Required for complete/uncomplete/edit/remove." },
                    "text": { "type": "string", "description": "Task text. Required for add and edit." }
                }),
                &["action"]),
            run_read: Some(|ws, input| {
                let root = &ws.root().to_string_lossy();
                let action = match input.get("action").and_then(|v| v.as_str()) {
                    Some(a) => a,
                    None => return err("update_todo_list requires an action.".to_string()),
                };
                let result = match action {
                    "add" => {
                        let text = match input.get("text").and_then(|v| v.as_str()) {
                            Some(t) => t.to_string(),
                            None => return err("add action requires text.".to_string()),
                        };
                        todo::add_todo(root, text)
                    }
                    "complete" | "uncomplete" => {
                        let id = match input.get("id").and_then(|v| v.as_str()) {
                            Some(i) => i,
                            None => return err("{action} action requires an id.".to_string()),
                        };
                        // Toggle the status; if already in the requested state,
                        // the result still reports the current state.
                        todo::toggle_todo(root, id)
                    }
                    "edit" => {
                        let id = match input.get("id").and_then(|v| v.as_str()) {
                            Some(i) => i,
                            None => return err("edit action requires an id.".to_string()),
                        };
                        let text = match input.get("text").and_then(|v| v.as_str()) {
                            Some(t) => t.to_string(),
                            None => return err("edit action requires text.".to_string()),
                        };
                        todo::update_text(root, id, text)
                    }
                    "remove" => {
                        let id = match input.get("id").and_then(|v| v.as_str()) {
                            Some(i) => i,
                            None => return err("remove action requires an id.".to_string()),
                        };
                        todo::remove_todo(root, id)
                    }
                    "clear_done" => todo::clear_done(root),
                    _ => return err(format!("Unknown action: {action}")),
                };
                match result {
                    Ok(msg) => {
                        let list = todo::list_todos_text(root)
                            .map(|t| format!("\n\nCurrent todos:\n{t}"))
                            .unwrap_or_default();
                        ok(format!("{msg}{list}"))
                    }
                    Err(e) => err(e),
                }
            }),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::Write,
            schema: schema("write_file", "Propose a search-and-replace edit to an existing file. The user reviews the diff and approves or rejects it. old_str should be a unique snippet copied from the file; matching is tolerant of indentation differences and of leading `N: ` line-number prefixes from read_file output.",
                serde_json::json!({
                    "path": { "type": "string", "description": "Path of the existing file, relative to the workspace root." },
                    "old_str": { "type": "string", "description": "Text to find. Copy it from the file (line-number prefixes and exact indentation are optional). Must locate a unique region." },
                    "new_str": { "type": "string", "description": "The replacement text. Use an empty string to delete the matched region." }
                }),
                &["path", "old_str", "new_str"]),
            run_read: None,
            run_write_preview: Some(preview_write_file),
            summary: path_summary,
        },
        ToolEntry {
            kind: ToolKind::Write,
            schema: schema("create_file", "Propose creating a brand-new file with the given contents. Fails if the file already exists.",
                serde_json::json!({
                    "path": { "type": "string", "description": "Path of the new file, relative to the workspace root." },
                    "contents": { "type": "string", "description": "Full text contents of the new file." }
                }),
                &["path", "contents"]),
            run_read: None,
            run_write_preview: Some(preview_create_file),
            summary: path_summary,
        },
        ToolEntry {
            kind: ToolKind::Write,
            schema: schema("create_skill", "Save a reusable skill to .agents/skills/<name>/SKILL.md. Use after solving a problem so it's never solved from scratch again.",
                serde_json::json!({
                    "name": { "type": "string", "description": "Folder name, e.g. 'react-hooks'." },
                    "title": { "type": "string", "description": "Human title." },
                    "description": { "type": "string", "description": "What it does." },
                    "instructions": { "type": "string", "description": "Markdown instructions." }
                }),
                &["name", "title", "instructions"]),
            run_read: None,
            run_write_preview: Some(preview_create_skill),
            summary: default_summary,
        },
        // The `userAnswerQuestion` tool does not actually execute — the agent
        // loop dispatches on `kind == ToolKind::Pause` and pauses the run via
        // a oneshot channel (see mod.rs). It lives in the registry only so the
        // model sees a valid schema and knows the tool exists. `run_read` and
        // `run_write_preview` stay None: the loop returns "Unknown tool" only
        // if the kind-based dispatch regresses.
        ToolEntry {
            kind: ToolKind::Pause,
            schema: schema("userAnswerQuestion", "Pause the run and ask the user a single free-form question. The user's typed answer is returned as the tool result. Use this to capture tribal knowledge — design decisions, naming rationale, project history — that isn't in the code or README. One question at a time; the harness queues follow-ups on the next turn.",
                serde_json::json!({
                    "question": { "type": "string", "description": "The question to ask. One sentence, focused on something only the user can answer." }
                }),
                &["question"]),
            run_read: None,
            run_write_preview: None,
            summary: default_summary,
        },
    ]
}

pub fn list_tools(mode: &AgentMode, disabled: &[String]) -> Vec<serde_json::Value> {
    let reg = registry();
    let kind_filter = match mode {
        AgentMode::Chat => return Vec::new(),
        AgentMode::Plan => Some(ToolKind::ReadOnly),
        AgentMode::Goal => None,
    };
    let mut tools: Vec<serde_json::Value> = reg
        .iter()
        .filter(|e| {
            let kind_ok = kind_filter.is_none_or(|k| e.kind == k);
            if !kind_ok {
                return false;
            }
            let name = e.schema["function"]["name"].as_str().unwrap_or("");
            !disabled.iter().any(|d| d == name)
        })
        .map(|e| e.schema.clone())
        .collect();
    // Dynamic tools always available in Plan/Goal
    if mode != &AgentMode::Chat {
        tools.extend(load_dynamic_tools(None));
    }
    tools
}

pub fn schemas_for_mode(mode: &AgentMode, disabled: &[String]) -> Option<Vec<serde_json::Value>> {
    let tools = list_tools(mode, disabled);
    if tools.is_empty() {
        None
    } else {
        Some(tools)
    }
}

/// Look up a tool by name and return its kind. The registry is the only
/// module that names a tool; callers (the run loop, the parallel pre-execute
/// filter) dispatch on this kind, not on a string match.
pub fn find_tool_kind(name: &str) -> Option<ToolKind> {
    registry()
        .into_iter()
        .find(|e| schema_has_name(&e.schema, name))
        .map(|e| e.kind)
}

/// Render the per-tool one-liner used on the `ToolCallStarted` event. The
/// summary fn lives on the registry entry, so the harness stops carrying
/// per-tool arg keys.
pub fn tool_summary(call: &NormalizedToolCall) -> String {
    registry()
        .into_iter()
        .find(|e| schema_has_name(&e.schema, &call.name))
        .map(|e| (e.summary)(call))
        .unwrap_or_else(|| call.name.clone())
}

fn schema_has_name(schema: &serde_json::Value, name: &str) -> bool {
    schema
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        == Some(name)
}

pub fn execute_read_only_tool(root: &str, call: &NormalizedToolCall, run_id: &str) -> ToolResult {
    // Check dynamic tools first
    if let Some(result) = execute_dynamic_tool(&call.name, &call.input, Some(root)) {
        return result;
    }
    // Then built-in registry
    let ws = match Workspace::new(root) {
        Ok(ws) => ws,
        Err(e) => return err(e),
    };
    let entry = registry()
        .into_iter()
        .find(|e| schema_has_name(&e.schema, &call.name));
    let result = match entry.and_then(|e| e.run_read) {
        Some(f) => f(&ws, &call.input),
        None => err(format!("Unknown tool: {}", call.name)),
    };
    // A successful read of a file carries a `{snapshotPath, snapshotHash}` blob
    // in its metadata — record it so write_file can later tell whether the file
    // changed since the model read it.
    if result.ok {
        if let Some(meta) = &result.metadata {
            if let (Some(path), Some(hash)) = (
                meta.get("snapshotPath").and_then(|v| v.as_str()),
                meta.get("snapshotHash").and_then(|v| v.as_str()),
            ) {
                record_snapshot(run_id, path, hash);
            }
        }
    }
    result
}

pub fn execute_write_tool_preview(
    root: &str,
    call: &NormalizedToolCall,
    run_id: &str,
) -> Result<DiffProposal, ToolResult> {
    let ws = Workspace::new(root).map_err(err)?;
    let entry = registry()
        .into_iter()
        .find(|e| schema_has_name(&e.schema, &call.name));
    match entry.and_then(|e| e.run_write_preview) {
        // Key the proposal to the tool call's id (unique per call), not the
        // file path — two edits to the same file in one run must not collide.
        Some(f) => f(&ws, &call.input, run_id).map(|mut proposal| {
            proposal.tool_call_id = call.id.clone();
            proposal.id = format!("diff_{}_{}", run_id, call.id);
            proposal
        }),
        None => Err(err(format!("Not a write tool: {}", call.name))),
    }
}

// ── Dynamic tools from .agents/tools.json ───────────────────────────────

#[derive(serde::Deserialize)]
struct DynamicToolDef {
    name: String,
    description: String,
    command: String,
    #[serde(default = "default_timeout", alias = "timeout_secs")]
    _timeout_secs: u64,
    #[serde(default)]
    cwd: String,
}

fn default_timeout() -> u64 {
    30
}

#[derive(serde::Deserialize)]
struct ToolsConfig {
    tools: Vec<DynamicToolDef>,
}

fn load_tools_from(path: &Path) -> Vec<DynamicToolDef> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let config: ToolsConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    config.tools
}

pub fn load_dynamic_tools(workspace_root: Option<&str>) -> Vec<serde_json::Value> {
    let mut tools = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();

    // Load global tools
    let global_path = Path::new(&home).join(".agents/tools.json");
    for def in load_tools_from(&global_path) {
        tools.push(dynamic_tool_schema(&def));
    }

    // Load workspace tools
    if let Some(root) = workspace_root {
        let workspace_path = Path::new(root).join(".agents/tools.json");
        for def in load_tools_from(&workspace_path) {
            tools.push(dynamic_tool_schema(&def));
        }
    }

    tools
}

fn dynamic_tool_schema(def: &DynamicToolDef) -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": def.name,
            "description": def.description,
            "parameters": {
                "type": "object",
                "properties": {
                    "args": { "type": "string", "description": "Optional arguments to pass to the command." }
                }
            }
        }
    })
}

pub fn execute_dynamic_tool(
    name: &str,
    input: &serde_json::Value,
    workspace_root: Option<&str>,
) -> Option<ToolResult> {
    let mut all_defs = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();
    all_defs.extend(load_tools_from(
        &Path::new(&home).join(".agents/tools.json"),
    ));
    if let Some(root) = workspace_root {
        all_defs.extend(load_tools_from(&Path::new(root).join(".agents/tools.json")));
    }
    let def = all_defs.iter().find(|d| d.name == name)?;
    let cwd = if def.cwd == "workspace" {
        workspace_root.unwrap_or(".")
    } else {
        "."
    };
    let args_str = string_arg(input, "args").unwrap_or_default();
    let full_command = if args_str.is_empty() {
        def.command.clone()
    } else {
        format!("{} {}", def.command, args_str)
    };

    let output = Command::new("sh")
        .arg("-c")
        .arg(&full_command)
        .current_dir(cwd)
        .output();
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return Some(ToolResult {
                ok: false,
                content: format!("Failed to run {}: {e}", def.name),
                metadata: None,
            })
        }
    };
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut result = stdout.trim().to_string();
        if !stderr.trim().is_empty() {
            result.push_str(&format!("\n\nstderr:\n{}", stderr.trim()));
        }
        if result.is_empty() {
            result = "(command completed successfully)".to_string();
        }
        Some(ToolResult {
            ok: true,
            content: result.chars().take(4000).collect(),
            metadata: None,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Some(ToolResult {
            ok: false,
            content: format!("{} failed: {}", def.name, stderr.trim()),
            metadata: None,
        })
    }
}

pub fn parse_tool_calls(raw: &[serde_json::Value]) -> Vec<NormalizedToolCall> {
    raw.iter()
        .enumerate()
        .filter_map(|(idx, value)| {
            let function = value.get("function").unwrap_or(value);
            let name = function.get("name").and_then(|v| v.as_str())?;
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("tool_{idx}"));
            let input = match function.get("arguments") {
                Some(serde_json::Value::String(s)) => {
                    serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({ "_raw": s }))
                }
                Some(other) => other.clone(),
                None => serde_json::json!({}),
            };
            Some(NormalizedToolCall {
                id,
                name: name.to_string(),
                input,
            })
        })
        .collect()
}

/// Some local models — notably LFM2 / LFM2.5 — emit tool calls as literal text
/// in the content stream wrapped in `<|tool_call_start|> … <|tool_call_end|>`
/// special tokens instead of populating the structured `tool_calls` field.
/// When that happens the harness sees no tool calls and ends the turn early,
/// rendering the raw tokens to the user. This scans the content for those
/// blocks and recovers the calls, returning them alongside the content with
/// the blocks stripped out. Returns an empty vec (and the content unchanged)
/// when there is nothing to recover — the common case for well-behaved models.
pub fn recover_text_tool_calls(content: &str) -> (Vec<NormalizedToolCall>, String) {
    const START: &str = "<|tool_call_start|>";
    const END: &str = "<|tool_call_end|>";
    let mut calls = Vec::new();
    let mut cleaned = String::new();
    let mut rest = content;
    while let Some(s) = rest.find(START) {
        cleaned.push_str(&rest[..s]);
        let after = &rest[s + START.len()..];
        let Some(e) = after.find(END) else {
            // Unterminated block — keep the remainder verbatim and stop.
            cleaned.push_str(&rest[s..]);
            rest = "";
            break;
        };
        for (name, input) in parse_pythonic_calls(after[..e].trim()) {
            let idx = calls.len();
            calls.push(NormalizedToolCall {
                id: format!("tool_{idx}"),
                name,
                input,
            });
        }
        rest = &after[e + END.len()..];
    }
    cleaned.push_str(rest);
    (calls, cleaned.trim().to_string())
}

/// Parse the LFM2 "pythonic" tool-call payload found between the special
/// tokens, e.g. `[read_file(path='x.md'), grep(query="harness", n=20)]`.
/// Falls back gracefully: anything it can't parse is skipped rather than
/// surfaced as a bogus call. Also accepts a JSON object/array payload
/// (`{"name":…,"arguments":{…}}`) emitted by some other local models.
fn parse_pythonic_calls(block: &str) -> Vec<(String, serde_json::Value)> {
    // JSON payload variant — try it first; it's unambiguous when it parses.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(block) {
        let objs = match &value {
            serde_json::Value::Array(items) => items.clone(),
            other => vec![other.clone()],
        };
        let parsed: Vec<(String, serde_json::Value)> = objs
            .iter()
            .filter_map(|o| {
                let name = o.get("name").and_then(|v| v.as_str())?;
                let input = o
                    .get("arguments")
                    .or_else(|| o.get("parameters"))
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                Some((name.to_string(), input))
            })
            .collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }

    // Pythonic variant: strip the optional surrounding list brackets, then
    // split the top-level calls apart respecting nesting and quotes.
    let inner = block.trim();
    let inner = inner.strip_prefix('[').unwrap_or(inner);
    let inner = inner.strip_suffix(']').unwrap_or(inner);
    split_top_level(inner, ',')
        .into_iter()
        .filter_map(|call| {
            let call = call.trim();
            let open = call.find('(')?;
            if !call.ends_with(')') {
                return None;
            }
            let name = call[..open].trim();
            if name.is_empty() {
                return None;
            }
            let args_str = &call[open + 1..call.len() - 1];
            let mut input = serde_json::Map::new();
            for pair in split_top_level(args_str, ',') {
                let pair = pair.trim();
                if pair.is_empty() {
                    continue;
                }
                let Some(eq) = pair.find('=') else { continue };
                let key = pair[..eq].trim();
                if key.is_empty() {
                    continue;
                }
                input.insert(key.to_string(), parse_pythonic_value(pair[eq + 1..].trim()));
            }
            Some((name.to_string(), serde_json::Value::Object(input)))
        })
        .collect()
}

/// Split `s` on `sep` only at the top level — commas inside quotes or nested
/// `()[]{}` are left intact.
fn split_top_level(s: &str, sep: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut buf = String::new();
    let mut prev = '\0';
    for ch in s.chars() {
        match quote {
            Some(q) => {
                buf.push(ch);
                if ch == q && prev != '\\' {
                    quote = None;
                }
            }
            None => match ch {
                '\'' | '"' => {
                    quote = Some(ch);
                    buf.push(ch);
                }
                '(' | '[' | '{' => {
                    depth += 1;
                    buf.push(ch);
                }
                ')' | ']' | '}' => {
                    depth -= 1;
                    buf.push(ch);
                }
                c if c == sep && depth == 0 => {
                    parts.push(std::mem::take(&mut buf));
                }
                _ => buf.push(ch),
            },
        }
        prev = ch;
    }
    if !buf.trim().is_empty() || !parts.is_empty() {
        parts.push(buf);
    }
    parts
}

/// Coerce a single pythonic argument value into JSON. Quoted strings lose their
/// quotes; bare `true`/`false`/`null`/numbers map to their JSON kinds; anything
/// else stays a string.
fn parse_pythonic_value(raw: &str) -> serde_json::Value {
    let raw = raw.trim();
    if raw.len() >= 2 {
        let bytes = raw.as_bytes();
        let first = bytes[0] as char;
        if (first == '\'' || first == '"') && raw.ends_with(first) {
            let unquoted = &raw[1..raw.len() - 1];
            return serde_json::Value::String(unquoted.replace("\\'", "'").replace("\\\"", "\""));
        }
    }
    match raw {
        "true" | "True" => return serde_json::Value::Bool(true),
        "false" | "False" => return serde_json::Value::Bool(false),
        "none" | "None" | "null" => return serde_json::Value::Null,
        _ => {}
    }
    if let Ok(i) = raw.parse::<i64>() {
        return serde_json::Value::from(i);
    }
    if let Ok(f) = raw.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(f) {
            return serde_json::Value::Number(n);
        }
    }
    // Fall back to a JSON value if it parses (handles nested objects/arrays),
    // otherwise keep the raw text as a string.
    serde_json::from_str::<serde_json::Value>(raw)
        .unwrap_or_else(|_| serde_json::Value::String(raw.to_string()))
}

// ── Execution helpers ────────────────────────────────────────────────────

fn ok(content: String) -> ToolResult {
    ToolResult {
        ok: true,
        content,
        metadata: None,
    }
}

fn err(content: String) -> ToolResult {
    ToolResult {
        ok: false,
        content,
        metadata: None,
    }
}

/// Raw string argument — preserves whitespace exactly. Use for file contents
/// and edit strings, where leading/trailing whitespace is significant.
fn string_arg(input: &serde_json::Value, key: &str) -> Option<String> {
    input.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Trimmed, non-empty string argument — for paths, patterns, queries, URLs.
fn trimmed_arg(input: &serde_json::Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn bool_arg(input: &serde_json::Value, key: &str) -> bool {
    input.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn usize_arg(input: &serde_json::Value, key: &str, fallback: usize) -> usize {
    input
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(fallback)
}

// ── Read-only tools ─────────────────────────────────────────────────────

fn read_file(ws: &Workspace, path: &str) -> ToolResult {
    let full = match ws.resolve_existing(path) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let metadata = match std::fs::metadata(&full) {
        Ok(m) => m,
        Err(e) => return err(format!("Unable to read metadata: {e}")),
    };
    if !metadata.is_file() {
        return err(format!("{} is not a file", ws.display(&full)));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return err(format!(
            "{} is too large to read safely ({} bytes, max {})",
            ws.display(&full),
            metadata.len(),
            MAX_FILE_BYTES
        ));
    }
    match std::fs::read_to_string(&full) {
        Ok(content) => {
            // Number the lines (1-indexed) the way omp's "hashline" read does:
            // `N: content`. Numbers help the model reason about *where* code is
            // and pair with write_file, which strips a leading `N: ` prefix when
            // it falls back to whitespace-insensitive matching — so a model that
            // copies a numbered line verbatim into `old_str` still edits cleanly.
            let line_count = content.lines().count();
            let numbered = number_lines(&content);
            let rel = ws.display(&full);
            ToolResult {
                ok: true,
                content: format!(
                    "Contents of {} ({} lines, {} chars). Lines are numbered `N: `; \
when editing with write_file, the number prefix is optional — it's stripped \
automatically.\n```\n{}\n```",
                    rel, line_count, content.len(), numbered
                ),
                // The execution wrapper reads this back to record a read
                // snapshot, so a later write_file can flag a stale edit.
                metadata: Some(serde_json::json!({
                    "snapshotPath": rel,
                    "snapshotHash": hash_content(&content),
                })),
            }
        }
        Err(e) => err(format!("Unable to read {} as text: {e}", ws.display(&full))),
    }
}

/// Prefix every line with its 1-indexed number (`N: line`), omp-style.
fn number_lines(content: &str) -> String {
    content
        .lines()
        .enumerate()
        .map(|(i, line)| format!("{}: {}", i + 1, line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn list_dir(ws: &Workspace, path: &str) -> ToolResult {
    let full = match ws.resolve_existing(path) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if !full.is_dir() {
        return err(format!("{} is not a directory", ws.display(&full)));
    }
    let entries = match std::fs::read_dir(&full) {
        Ok(e) => e,
        Err(e) => return err(format!("Unable to list directory: {e}")),
    };
    let mut rows = Vec::new();
    for entry in entries.flatten().take(MAX_LIST_ENTRIES) {
        let file_type = entry.file_type().ok();
        let is_dir = file_type.as_ref().is_some_and(|t| t.is_dir());
        rows.push(format!(
            "{}{}",
            if is_dir { "[dir] " } else { "      " },
            entry.file_name().to_string_lossy()
        ));
    }
    rows.sort();
    ok(format!(
        "Entries in {}:\n{}",
        ws.display(&full),
        if rows.is_empty() {
            "(empty)".to_string()
        } else {
            rows.join("\n")
        }
    ))
}

fn ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | ".cache"
            | "coverage"
            | ".venv"
            | "__pycache__"
    )
}

fn walk_files(root: &Path, start: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_WALK_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(start) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_WALK_FILES {
            return;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !ignored_dir(&name) {
                walk_files(root, &path, out);
            }
        } else if ft.is_file() && path.starts_with(root) {
            out.push(path);
        }
    }
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti, mut star, mut mark) = (0_usize, 0_usize, None, 0_usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

fn glob(ws: &Workspace, input: &serde_json::Value) -> ToolResult {
    let pattern = match trimmed_arg(input, "pattern") {
        Some(p) => p,
        None => return err("glob requires a string pattern".to_string()),
    };
    let start_arg = trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string());
    let start = match ws.resolve_existing(&start_arg) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let mut files = Vec::new();
    walk_files(ws.root(), &start, &mut files);
    let mut matches: Vec<String> = files
        .into_iter()
        .filter_map(|path| {
            let rel = ws.display(&path);
            if wildcard_match(&pattern, &rel) || wildcard_match(&pattern.replace("**/", ""), &rel) {
                Some(rel)
            } else {
                None
            }
        })
        .take(MAX_SEARCH_RESULTS)
        .collect();
    matches.sort();
    ok(format!(
        "Glob matches for {pattern}:\n{}",
        if matches.is_empty() {
            "(none)".to_string()
        } else {
            matches.join("\n")
        }
    ))
}

fn grep(ws: &Workspace, input: &serde_json::Value) -> ToolResult {
    // Grep patterns keep their whitespace (a leading space can be the point),
    // but an empty pattern would match every line.
    let pattern = match string_arg(input, "pattern").filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => return err("grep requires a string pattern".to_string()),
    };
    let max = usize_arg(input, "maxResults", MAX_SEARCH_RESULTS).min(MAX_SEARCH_RESULTS);
    let path_arg = trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string());
    let start = match ws.resolve_existing(&path_arg) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let mut files = Vec::new();
    if start.is_file() {
        files.push(start);
    } else {
        walk_files(ws.root(), &start, &mut files);
    }
    let mut rows = Vec::new();
    for file in files {
        if rows.len() >= max {
            break;
        }
        if std::fs::metadata(&file)
            .map(|m| m.len() > MAX_FILE_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue;
        };
        for (idx, line) in content.lines().enumerate() {
            if line.contains(&pattern) {
                rows.push(format!("{}:{}: {}", ws.display(&file), idx + 1, line));
                if rows.len() >= max {
                    break;
                }
            }
        }
    }
    ok(format!(
        "Grep matches for {pattern}:\n{}",
        if rows.is_empty() {
            "(none)".to_string()
        } else {
            rows.join("\n")
        }
    ))
}

fn git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn get_git_status(root: &Path) -> ToolResult {
    match git_output(root, &["status", "--short", "--branch"]) {
        Ok(o) => ok(format!("Git status:\n{}", o.trim())),
        Err(e) => err(e),
    }
}

fn get_git_diff(root: &Path, input: &serde_json::Value) -> ToolResult {
    let staged = bool_arg(input, "staged");
    let path = trimmed_arg(input, "path");
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(p) = path.as_deref() {
        args.push("--");
        args.push(p);
    }
    match git_output(root, &args) {
        Ok(output) => ok(format!(
            "Git diff{}:\n{}",
            if staged { " (staged)" } else { "" },
            if output.trim().is_empty() {
                "(empty)"
            } else {
                output.trim()
            }
        )),
        Err(e) => err(e),
    }
}

fn get_git_log(root: &Path, input: &serde_json::Value) -> ToolResult {
    let count = input
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .clamp(1, 100);
    let count_arg = format!("-n{count}");
    // Tab-separated so the model can parse cleanly: hash · subject · date · author.
    let mut args = vec![
        "log",
        "--pretty=format:%h\t%s\t%cr\t%an",
        count_arg.as_str(),
    ];
    let path = trimmed_arg(input, "path");
    if let Some(p) = path.as_deref() {
        args.push("--");
        args.push(p);
    }
    match git_output(root, &args) {
        Ok(output) => ok(format!(
            "Git log (most recent first){}:\n{}",
            match path.as_deref() {
                Some(p) => format!(" for {p}"),
                None => String::new(),
            },
            if output.trim().is_empty() {
                "(no commits)"
            } else {
                output.trim()
            }
        )),
        Err(e) => err(e),
    }
}

// ── Web tools ───────────────────────────────────────────────────────────

fn web_search(input: &serde_json::Value) -> ToolResult {
    let query = match trimmed_arg(input, "query") {
        Some(q) => q,
        None => return err("web_search requires a query".to_string()),
    };
    let url = format!(
        "https://lite.duckduckgo.com/lite/?q={}",
        urlencoding(&query)
    );

    let resp = match std::panic::catch_unwind(|| {
        reqwest::blocking::Client::builder()
            .user_agent("Klide/1.0")
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .ok()
            .and_then(|c| c.get(&url).send().ok())
            .and_then(|r| r.text().ok())
    }) {
        Ok(Some(body)) => body,
        _ => return err("Web search timed out or failed. Try a more specific query.".to_string()),
    };

    let mut results: Vec<String> = Vec::new();
    for line in resp.lines() {
        let trimmed = line.trim();
        if let Some(href) = extract_href(trimmed).and_then(|href| normalize_search_href(&href)) {
            if results.len() < 8 {
                let title = strip_tags(trimmed);
                if !title.is_empty() && title.len() > 2 {
                    results.push(format!("{title}\n  {href}"));
                }
            }
        }
    }

    if results.is_empty() {
        return ok(format!("No results found for '{query}'. Try rephrasing."));
    }
    ok(format!(
        "Web results for '{query}':\n\n{}",
        results.join("\n\n")
    ))
}

fn web_fetch(input: &serde_json::Value) -> ToolResult {
    let url = match trimmed_arg(input, "url") {
        Some(u) => u,
        None => return err("web_fetch requires a url".to_string()),
    };
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return err("URL must start with http:// or https://".to_string());
    }
    let body = match std::panic::catch_unwind(|| {
        reqwest::blocking::Client::builder()
            .user_agent("Klide/1.0")
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .ok()
            .and_then(|c| c.get(&url).send().ok())
            .and_then(|r| r.text().ok())
    }) {
        Ok(Some(b)) => b,
        _ => {
            return err(
                "Web fetch timed out. The page may be too large or unreachable.".to_string(),
            )
        }
    };

    let text = strip_html(&body);
    let truncated: String = text.chars().take(6000).collect();
    let note = if text.chars().count() > 6000 {
        "\n\n…(truncated)"
    } else {
        ""
    };
    ok(format!("Content of {url}:\n\n{truncated}{note}"))
}

fn extract_href(line: &str) -> Option<String> {
    let start = line.find("href=\"")?;
    let rest = &line[start + 6..];
    let end = rest.find('"')?;
    let href = decode_html_entities(&rest[..end]);
    if href.is_empty() {
        None
    } else {
        Some(href)
    }
}

fn normalize_search_href(href: &str) -> Option<String> {
    let decoded = decode_html_entities(href);
    if let Some(uddg) = query_param(&decoded, "uddg").and_then(|value| percent_decode(&value)) {
        if uddg.starts_with("http://") || uddg.starts_with("https://") {
            return Some(uddg);
        }
    }
    if decoded.starts_with("//duckduckgo.com/l/?") || decoded.starts_with("/l/?") {
        return None;
    }
    if decoded.starts_with("http://") || decoded.starts_with("https://") {
        if decoded.contains("duckduckgo.com") {
            None
        } else {
            Some(decoded)
        }
    } else {
        None
    }
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for part in query.split('&') {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if name == key {
            return Some(value.to_string());
        }
    }
    None
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = hex_value(bytes[i + 1])?;
                let lo = hex_value(bytes[i + 2])?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            b'%' => return None,
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_html_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn strip_tags(text: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in text.chars() {
        if c == '<' {
            in_tag = true;
            continue;
        }
        if c == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            out.push(c);
        }
    }
    decode_html_entities(out.trim())
}

fn strip_html(input: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut in_script = false;
    let mut skip: usize = 0;

    for (i, c) in input.char_indices() {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        if in_script {
            if c == '<' && input[i..].starts_with("</script") {
                in_script = false;
                in_tag = true;
                continue;
            }
            continue;
        }
        if c == '<' {
            in_tag = true;
            if input[i..].to_lowercase().starts_with("<script") {
                in_script = true;
            }
            if input[i..].to_lowercase().starts_with("<style") {
                in_script = true;
            }
            continue;
        }
        if c == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            if c == '&' {
                if input[i..].starts_with("&amp;") {
                    out.push('&');
                    skip = 4;
                } else if input[i..].starts_with("&lt;") {
                    out.push('<');
                    skip = 3;
                } else if input[i..].starts_with("&gt;") {
                    out.push('>');
                    skip = 3;
                } else if input[i..].starts_with("&quot;") {
                    out.push('"');
                    skip = 5;
                } else if input[i..].starts_with("&#39;") {
                    out.push('\'');
                    skip = 4;
                } else if input[i..].starts_with("&nbsp;") {
                    out.push(' ');
                    skip = 5;
                } else {
                    out.push(c);
                }
            } else {
                out.push(c);
            }
        }
    }
    let compacted: Vec<&str> = out.lines().filter(|l| !l.trim().is_empty()).collect();
    compacted.join("\n")
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

fn hash_content(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    content.len().hash(&mut h);
    content.hash(&mut h);
    format!("{:x}", h.finish())
}

/// Positional line diff for the changed middle of a file. LCS keeps the diff
/// minimal; above MAX_LCS lines per side we fall back to "all removed, all
/// added" (still correct, just not minimal) to bound the O(n*m) table.
fn diff_ops<'a>(old: &[&'a str], new: &[&'a str]) -> Vec<(char, &'a str)> {
    const MAX_LCS: usize = 1500;
    if old.len() > MAX_LCS || new.len() > MAX_LCS {
        return old
            .iter()
            .map(|l| ('-', *l))
            .chain(new.iter().map(|l| ('+', *l)))
            .collect();
    }
    let (n, m) = (old.len(), new.len());
    let width = m + 1;
    let mut table = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i * width + j] = if old[i] == new[j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut ops = Vec::new();
    while i < n && j < m {
        if old[i] == new[j] {
            ops.push((' ', old[i]));
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            ops.push(('-', old[i]));
            i += 1;
        } else {
            ops.push(('+', new[j]));
            j += 1;
        }
    }
    ops.extend(old[i..].iter().map(|l| ('-', *l)));
    ops.extend(new[j..].iter().map(|l| ('+', *l)));
    ops
}

/// Unified diff with real line numbers: trim the common prefix/suffix, run a
/// positional diff on the middle, emit one hunk with 3 lines of context.
fn unified_diff_lines(old: &str, new: &str) -> String {
    if old == new {
        return String::new();
    }
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    let mut prefix = 0;
    let max_prefix = old_lines.len().min(new_lines.len());
    while prefix < max_prefix && old_lines[prefix] == new_lines[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    let max_suffix = max_prefix - prefix;
    while suffix < max_suffix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let ops = diff_ops(
        &old_lines[prefix..old_lines.len() - suffix],
        &new_lines[prefix..new_lines.len() - suffix],
    );

    const CONTEXT: usize = 3;
    let ctx_start = prefix.saturating_sub(CONTEXT);
    let lead = old_lines[ctx_start..prefix].iter().map(|l| (' ', *l));
    let tail_end = (old_lines.len() - suffix + CONTEXT).min(old_lines.len());
    let tail = old_lines[old_lines.len() - suffix..tail_end]
        .iter()
        .map(|l| (' ', *l));
    let hunk: Vec<(char, &str)> = lead.chain(ops).chain(tail).collect();

    let old_count = hunk.iter().filter(|(c, _)| *c != '+').count();
    let new_count = hunk.iter().filter(|(c, _)| *c != '-').count();
    let mut out = format!(
        "@@ -{},{} +{},{} @@\n",
        if old_count == 0 {
            ctx_start
        } else {
            ctx_start + 1
        },
        old_count,
        if new_count == 0 {
            ctx_start
        } else {
            ctx_start + 1
        },
        new_count,
    );
    for (c, l) in &hunk {
        out.push(*c);
        out.push_str(l);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Why a `locate_edit` lookup failed: nothing matched, or several regions did.
#[derive(Debug)]
enum LocateError {
    NotFound,
    Multiple(usize),
}

/// Byte `(start, end)` spans of each line in `s`, excluding the trailing `\n`.
fn line_spans(s: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = 0;
    for (i, b) in s.bytes().enumerate() {
        if b == b'\n' {
            spans.push((start, i));
            start = i + 1;
        }
    }
    if start < s.len() {
        spans.push((start, s.len()));
    }
    spans
}

/// Normalize one line for tolerant matching: drop a leading `N:` / `N: `
/// line-number prefix (the read_file gutter), then trim surrounding
/// whitespace so indentation drift doesn't defeat a match. Conservative —
/// the prefix is stripped only when it's exactly `<digits>:`.
fn normalize_match_line(line: &str) -> &str {
    let trimmed = line.trim();
    let bytes = trimmed.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 && i < bytes.len() && bytes[i] == b':' {
        return trimmed[i + 1..].trim_start();
    }
    trimmed
}

/// Locate the unique region of `current` that `old_str` refers to, returning
/// the byte range to replace. Exact substring first (fast, indentation-
/// faithful); then a line-based match that ignores indentation and `N: `
/// gutter prefixes — omp's "hashline" tolerance, minus the engine. Both paths
/// demand a *unique* hit so an edit never lands in the wrong place.
fn locate_edit(current: &str, old_str: &str) -> Result<(usize, usize), LocateError> {
    let exact: Vec<usize> = current.match_indices(old_str).map(|(i, _)| i).collect();
    match exact.len() {
        1 => return Ok((exact[0], exact[0] + old_str.len())),
        n if n > 1 => return Err(LocateError::Multiple(n)),
        _ => {}
    }

    // Normalized old_str lines, trimming blank lines off both ends so a stray
    // leading/trailing newline doesn't widen the window.
    let old_norm: Vec<&str> = old_str.lines().map(normalize_match_line).collect();
    let (Some(first), Some(last)) = (
        old_norm.iter().position(|l| !l.is_empty()),
        old_norm.iter().rposition(|l| !l.is_empty()),
    ) else {
        return Err(LocateError::NotFound); // old_str carried no real content
    };
    let old_core = &old_norm[first..=last];
    let n = old_core.len();

    let spans = line_spans(current);
    let cur_norm: Vec<&str> = spans
        .iter()
        .map(|&(a, b)| normalize_match_line(&current[a..b]))
        .collect();

    let mut windows: Vec<usize> = Vec::new();
    if n <= cur_norm.len() {
        for i in 0..=cur_norm.len() - n {
            if (0..n).all(|k| cur_norm[i + k] == old_core[k]) {
                windows.push(i);
            }
        }
    }
    match windows.len() {
        1 => Ok((spans[windows[0]].0, spans[windows[0] + n - 1].1)),
        0 => Err(LocateError::NotFound),
        m => Err(LocateError::Multiple(m)),
    }
}

/// A short, numbered context hint pointing at where `old_str` *almost* matched
/// — the first file line whose normalized form equals old_str's first real
/// line. Empty when there's no near-miss to show.
fn nearest_hint(current: &str, old_str: &str) -> String {
    let Some(target) = old_str
        .lines()
        .map(normalize_match_line)
        .find(|l| !l.is_empty())
    else {
        return String::new();
    };
    let lines: Vec<&str> = current.lines().collect();
    let Some(hit) = lines.iter().position(|l| normalize_match_line(l) == target) else {
        return String::new();
    };
    let start = hit.saturating_sub(2);
    let end = (hit + 3).min(lines.len());
    let ctx = (start..end)
        .map(|i| format!("{}: {}", i + 1, lines[i]))
        .collect::<Vec<_>>()
        .join("\n");
    format!("\nClosest match near line {}:\n{}", hit + 1, ctx)
}

fn preview_write_file(
    ws: &Workspace,
    input: &serde_json::Value,
    run_id: &str,
) -> Result<DiffProposal, ToolResult> {
    let path = trimmed_arg(input, "path")
        .ok_or_else(|| err("write_file requires a string path".to_string()))?;
    // old_str/new_str must keep their whitespace verbatim — indentation and
    // trailing newlines are part of the match and the replacement.
    let old_str = string_arg(input, "old_str")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err("write_file requires old_str".to_string()))?;
    let new_str = string_arg(input, "new_str").unwrap_or_default();
    let full = ws.resolve_existing(&path).map_err(err)?;
    let rel = ws.display(&full);
    let current =
        std::fs::read_to_string(&full).map_err(|e| err(format!("Cannot read {rel}: {e}")))?;
    // Staleness guard (omp's `#tag`, lite): if the live file no longer hashes
    // to what the model last read, the edit still targets the *current* text
    // (so it's safe to apply), but flag it so the diff reviewer — and the model
    // — know the file moved underneath.
    let stale = matches!(
        last_seen_hash(run_id, &rel),
        Some(prev) if prev != hash_content(&current)
    );
    let new_content = match locate_edit(&current, &old_str) {
        Ok((start, end)) => format!("{}{}{}", &current[..start], new_str, &current[end..]),
        Err(LocateError::NotFound) => {
            return Err(err(format!(
                "old_str not found in {rel} (tried exact and whitespace-insensitive matching).{}\n\
                 Re-read the file and copy a snippet that exists verbatim.",
                nearest_hint(&current, &old_str)
            )));
        }
        Err(LocateError::Multiple(n)) => {
            return Err(err(format!(
                "old_str matches {n} regions in {rel}. Include more surrounding context so it locates exactly one."
            )));
        }
    };
    let stale_reason = if stale {
        Some(format!(
            "⚠ {rel} changed since the agent last read it this run — the edit targets the current contents; review carefully."
        ))
    } else {
        None
    };
    if new_content.len() as u64 > MAX_WRITE_BYTES {
        return Err(err("Resulting file would be too large".to_string()));
    }
    Ok(DiffProposal {
        id: format!(
            "diff_{}_{}",
            run_id,
            format!("write_{}", rel.replace('/', "_"))
        ),
        run_id: run_id.to_string(),
        tool_call_id: format!("write_{}", rel),
        path: rel,
        old_content: current.clone(),
        new_content: new_content.clone(),
        old_hash: hash_content(&current),
        new_hash: hash_content(&new_content),
        unified_diff: unified_diff_lines(&current, &new_content),
        is_create: false,
        reason: stale_reason,
    })
}

fn preview_create_file(
    ws: &Workspace,
    input: &serde_json::Value,
    run_id: &str,
) -> Result<DiffProposal, ToolResult> {
    let path = trimmed_arg(input, "path")
        .ok_or_else(|| err("create_file requires a string path".to_string()))?;
    // Contents are raw (may legitimately be empty or whitespace-only).
    let contents = string_arg(input, "contents")
        .ok_or_else(|| err("create_file requires string contents".to_string()))?;
    let candidate = ws.resolve_new(&path).map_err(err)?;
    let rel = ws.display(&candidate);
    if candidate.exists() {
        return Err(err(format!(
            "{rel} already exists. Use write_file to modify an existing file."
        )));
    }
    if contents.len() as u64 > MAX_WRITE_BYTES {
        return Err(err("Contents too large".to_string()));
    }
    Ok(DiffProposal {
        id: format!(
            "diff_{}_{}",
            run_id,
            format!("create_{}", rel.replace('/', "_"))
        ),
        run_id: run_id.to_string(),
        tool_call_id: format!("create_{}", rel),
        path: rel,
        old_content: String::new(),
        new_content: contents.clone(),
        old_hash: hash_content(""),
        new_hash: hash_content(&contents),
        unified_diff: format!(
            "@@ -0,0 +1,{} @@\n{}",
            contents.lines().count(),
            contents
                .lines()
                .map(|l| format!("+{}", l))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        is_create: true,
        reason: None,
    })
}

fn preview_create_skill(
    ws: &Workspace,
    input: &serde_json::Value,
    run_id: &str,
) -> Result<DiffProposal, ToolResult> {
    let name =
        string_arg(input, "name").ok_or_else(|| err("create_skill requires a name".to_string()))?;
    let title = string_arg(input, "title").unwrap_or_else(|| name.clone());
    let description = string_arg(input, "description").unwrap_or_default();
    let instructions = string_arg(input, "instructions")
        .ok_or_else(|| err("create_skill requires instructions".to_string()))?;
    let safe_name = name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let rel = format!(".agents/skills/{safe_name}/SKILL.md");
    let full = ws.resolve_new(&rel).map_err(err)?;
    if full.exists() {
        return Err(err(format!(
            "{rel} already exists. Use write_file to edit it."
        )));
    }
    let content =
        format!("---\nname: {title}\ndescription: {description}\n---\n\n{instructions}\n");
    Ok(DiffProposal {
        id: format!("diff_{}_{}", run_id, safe_name),
        run_id: run_id.to_string(),
        tool_call_id: format!("skill_{}", safe_name),
        path: rel,
        old_content: String::new(),
        new_content: content.clone(),
        old_hash: hash_content(""),
        new_hash: hash_content(&content),
        unified_diff: format!(
            "@@ -0,0 +1,{} @@\n{}",
            content.lines().count(),
            content
                .lines()
                .map(|l| format!("+{l}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        is_create: true,
        reason: Some(format!("New skill: {title}")),
    })
}

/// Is this `.json` path actually JSONC (comments / trailing commas allowed)?
/// Strict JSON validation would false-alarm on these, so we skip them.
fn is_jsonc_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let base = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    base == "tsconfig.json"
        || base.starts_with("tsconfig.")
        || base == "jsconfig.json"
        || base == "settings.json"
        || base == "launch.json"
        || base == "devcontainer.json"
        || lower.contains("/.vscode/")
}

/// Cheap, in-process syntax check of freshly-written content, keyed off the
/// file extension. Returns `Some(summary)` only when the content is
/// *definitely* malformed; `None` when it parses or the language has no
/// trustworthy in-process parser (omp's post-edit diagnostics, lite). Advisory
/// only — it never blocks a write, it rides the tool result so the model can
/// fix its own mistake on the next turn. Languages without a reliable Rust
/// parser (e.g. TypeScript) are deliberately skipped rather than risk a false
/// alarm from a brace-counting heuristic.
fn verify_syntax(path: &str, content: &str) -> Option<String> {
    if content.trim().is_empty() {
        return None;
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    let problem = match ext.as_str() {
        "json" if !is_jsonc_path(path) => serde_json::from_str::<serde_json::Value>(content)
            .err()
            .map(|e| format!("invalid JSON — {e}")),
        "rs" => syn::parse_file(content)
            .err()
            .map(|e| format!("Rust parse error — {e}")),
        _ => None,
    }?;
    Some(format!(
        "⚠ Syntax check failed: {problem}. The edit was applied; re-read and fix the syntax."
    ))
}

pub fn apply_write(root: &str, diff: &DiffProposal) -> Result<ToolResult, ToolResult> {
    let ws = Workspace::new(root).map_err(err)?;
    // Re-validate at apply time: never trust a proposal path blindly.
    let full = ws.resolve_new(&diff.path).map_err(err)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| err(format!("Cannot create directory: {e}")))?;
    }
    std::fs::write(&full, &diff.new_content)
        .map_err(|e| err(format!("Cannot write {}: {e}", diff.path)))?;
    // The model just wrote this file, so its current hash is the new one — keep
    // the snapshot fresh so a follow-up edit isn't falsely flagged as stale.
    record_snapshot(&diff.run_id, &diff.path, &diff.new_hash);
    let rel = ws.display(&full);
    // A staleness note (set at preview time) rides along into the result so the
    // model learns the file had moved under it and can re-read if it matters.
    let note = diff
        .reason
        .as_deref()
        .filter(|r| r.starts_with('⚠'))
        .map(|r| format!("\n{r}"))
        .unwrap_or_default();
    // Post-edit syntax verification: a definite parse error is appended so the
    // model can fix it next turn (the write still happened — the agent owns the
    // correction, same as omp's diagnostics).
    let syntax = verify_syntax(&diff.path, &diff.new_content)
        .map(|s| format!("\n{s}"))
        .unwrap_or_default();
    if diff.is_create {
        Ok(ok(format!(
            "Applied: created {rel} ({} chars).{note}{syntax}",
            diff.new_content.len()
        )))
    } else {
        Ok(ok(format!("Applied: edited {rel}.{note}{syntax}")))
    }
}

pub fn clean_context_ids(tool_call_ids: &[String], messages: &mut Vec<serde_json::Value>) {
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("tool") {
            continue;
        }
        let tc_id = msg
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if tool_call_ids.iter().any(|id| id == tc_id) {
            let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
            msg["content"] = serde_json::Value::String(format!("[cleaned: {name}]"));
            if let Some(obj) = msg.as_object_mut() {
                obj.remove("name");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_arg_preserves_whitespace() {
        let input = serde_json::json!({ "old_str": "    return x;\n" });
        assert_eq!(
            string_arg(&input, "old_str").as_deref(),
            Some("    return x;\n")
        );
    }

    #[test]
    fn trimmed_arg_trims_and_rejects_empty() {
        let input = serde_json::json!({ "path": "  src/main.rs  ", "blank": "   " });
        assert_eq!(trimmed_arg(&input, "path").as_deref(), Some("src/main.rs"));
        assert_eq!(trimmed_arg(&input, "blank"), None);
    }

    // Path-containment tests live with the Workspace module (src/workspace.rs).

    #[test]
    fn unified_diff_reports_real_positions() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let new = "a\nb\nc\nd\nX\nf\ng\nh\n";
        let diff = unified_diff_lines(old, new);
        // Change is on line 5; with 3 context lines the hunk starts at line 2.
        assert!(diff.starts_with("@@ -2,7 +2,7 @@"), "got: {diff}");
        assert!(diff.contains("-e\n+X"), "got: {diff}");
    }

    #[test]
    fn unified_diff_handles_repeated_lines() {
        // A removed blank line that also appears elsewhere must show as removed.
        let old = "a\n\nb\n\nc\n";
        let new = "a\n\nb\nc\n";
        let diff = unified_diff_lines(old, new);
        assert_eq!(diff.matches("\n-").count(), 1, "got: {diff}");
        // No added lines (the hunk header's "+1,4" doesn't count).
        assert_eq!(diff.matches("\n+").count(), 0, "got: {diff}");
    }

    #[test]
    fn unified_diff_identical_inputs_is_empty() {
        assert_eq!(unified_diff_lines("same\n", "same\n"), "");
    }

    #[test]
    fn recovers_lfm2_text_tool_call() {
        // The exact shape seen leaking into the chat from LFM2.5.
        let content = "I'll read the file.\n\
            <|tool_call_start|>[read_file(path='KLIDE_AGENT_HARNESS_IMPLEMENTATION.md')]<|tool_call_end|>";
        let (calls, cleaned) = recover_text_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(
            calls[0].input,
            serde_json::json!({ "path": "KLIDE_AGENT_HARNESS_IMPLEMENTATION.md" })
        );
        // The special-token block is stripped from the user-visible content.
        assert_eq!(cleaned, "I'll read the file.");
    }

    #[test]
    fn recovers_no_arg_call() {
        // A tool with no parameters, exactly as LFM2.5 emits it:
        // `get_git_status()` with empty parens. Earlier coverage only had
        // calls *with* args, so the empty-arg path went untested.
        let content = "<|tool_call_start|>[get_git_status()]<|tool_call_end|>";
        let (calls, cleaned) = recover_text_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "get_git_status");
        assert_eq!(calls[0].input, serde_json::json!({}));
        assert_eq!(cleaned, "");
    }

    #[test]
    fn recovers_multiple_calls_with_mixed_arg_types() {
        let content =
            "<|tool_call_start|>[grep(query=\"harness\", limit=20, regex=true), list_dir(path='.')]<|tool_call_end|>";
        let (calls, _) = recover_text_tool_calls(content);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "grep");
        assert_eq!(
            calls[0].input,
            serde_json::json!({ "query": "harness", "limit": 20, "regex": true })
        );
        assert_eq!(calls[1].name, "list_dir");
        assert_eq!(calls[1].input, serde_json::json!({ "path": "." }));
    }

    #[test]
    fn recovers_json_payload_variant() {
        let content =
            "<|tool_call_start|>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.rs\"}}<|tool_call_end|>";
        let (calls, _) = recover_text_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].input, serde_json::json!({ "path": "a.rs" }));
    }

    #[test]
    fn no_recovery_for_plain_content() {
        let content = "Just a normal answer with no tool calls.";
        let (calls, cleaned) = recover_text_tool_calls(content);
        assert!(calls.is_empty());
        assert_eq!(cleaned, content);
    }

    #[test]
    fn recovered_calls_round_trip_through_synthesized_payload() {
        // The run loop recovers calls, synthesizes a structured `tool_calls`
        // payload from them, then replays that payload to the model on later
        // turns via `parse_tool_calls`. This guards that round-trip so the
        // assistant turn stays coherent (call → result) for the next turn.
        let content = "<|tool_call_start|>[read_file(path='a.rs'), grep(query=\"x\", limit=5)]<|tool_call_end|>";
        let (recovered, _) = recover_text_tool_calls(content);

        let synthesized: Vec<serde_json::Value> = recovered
            .iter()
            .map(|c| serde_json::json!({ "function": { "name": c.name, "arguments": c.input } }))
            .collect();

        let reparsed = parse_tool_calls(&synthesized);
        assert_eq!(reparsed.len(), recovered.len());
        for (a, b) in recovered.iter().zip(reparsed.iter()) {
            assert_eq!(a.name, b.name);
            assert_eq!(a.input, b.input);
        }
    }

    #[test]
    fn unterminated_block_is_left_intact() {
        // A truncated stream must not drop content or invent a call.
        let content = "text <|tool_call_start|>[read_file(path='x";
        let (calls, cleaned) = recover_text_tool_calls(content);
        assert!(calls.is_empty());
        assert_eq!(cleaned, content);
    }

    // ── Tolerant edit matching (omp-inspired) ────────────────────────────

    #[test]
    fn number_lines_is_one_indexed() {
        assert_eq!(number_lines("a\nb\nc"), "1: a\n2: b\n3: c");
    }

    #[test]
    fn normalize_strips_gutter_and_indentation() {
        assert_eq!(normalize_match_line("    let x = 1;"), "let x = 1;");
        assert_eq!(normalize_match_line("42:    let x = 1;"), "let x = 1;");
        assert_eq!(normalize_match_line("42: let x = 1;"), "let x = 1;");
        // A real `key:` line with no leading digits is left alone after trim.
        assert_eq!(normalize_match_line("  name: value"), "name: value");
        // Blank / whitespace-only lines normalize to empty.
        assert_eq!(normalize_match_line("   "), "");
    }

    #[test]
    fn locate_exact_unique() {
        let current = "fn a() {}\nfn b() {}\n";
        let (s, e) = locate_edit(current, "fn b() {}").expect("unique");
        assert_eq!(&current[s..e], "fn b() {}");
    }

    #[test]
    fn locate_exact_multiple_is_error() {
        let current = "x = 1\nx = 1\n";
        assert!(matches!(
            locate_edit(current, "x = 1"),
            Err(LocateError::Multiple(2))
        ));
    }

    #[test]
    fn locate_tolerates_indentation_drift() {
        // Model copied the body with the wrong indentation (2 spaces vs 4).
        let current = "fn f() {\n    let y = 2;\n    return y;\n}\n";
        let old = "  let y = 2;\n  return y;";
        let (s, e) = locate_edit(current, old).expect("fuzzy unique");
        // The matched region is the real (4-space) file text, byte-exact.
        assert_eq!(&current[s..e], "    let y = 2;\n    return y;");
    }

    #[test]
    fn locate_tolerates_line_number_prefixes() {
        // Model pasted numbered lines straight from read_file output.
        let current = "fn f() {\n    let y = 2;\n    return y;\n}\n";
        let old = "2:     let y = 2;\n3:     return y;";
        let (s, e) = locate_edit(current, old).expect("numbered fuzzy unique");
        assert_eq!(&current[s..e], "    let y = 2;\n    return y;");
    }

    #[test]
    fn locate_fuzzy_requires_uniqueness() {
        // Two indentation-equal regions ⇒ ambiguous ⇒ error, never a guess.
        let current = "if a {\n    do_it();\n}\nif b {\n    do_it();\n}\n";
        assert!(matches!(
            locate_edit(current, "do_it();"),
            // "do_it();" appears exactly twice as a substring → exact-multiple.
            Err(LocateError::Multiple(2))
        ));
    }

    #[test]
    fn locate_not_found_gives_a_hint() {
        let current = "fn alpha() {\n    let count = 0;\n}\n";
        // Right line, wrong content on the surrounding lines.
        assert!(matches!(
            locate_edit(current, "let count = 999;"),
            Err(LocateError::NotFound)
        ));
        let hint = nearest_hint(current, "    let count = 0;");
        assert!(hint.contains("Closest match near line 2"), "got: {hint}");
        assert!(hint.contains("2:     let count = 0;"), "got: {hint}");
    }

    // ── Staleness guard (omp's `#tag`, lite) ─────────────────────────────

    fn snapshot_sandbox(label: &str) -> (Workspace, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "klide-snapshot-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ws = Workspace::new(dir.to_str().unwrap()).unwrap();
        (ws, dir)
    }

    #[test]
    fn write_flags_a_file_changed_since_last_read() {
        let (ws, dir) = snapshot_sandbox("stale");
        let run = "run-stale";
        clear_run_snapshots(run);
        std::fs::write(dir.join("a.rs"), "let x = 1;\n").unwrap();
        let rel = ws.display(&ws.resolve_existing("a.rs").unwrap());

        // The model "read" an older version (a different hash).
        record_snapshot(run, &rel, &hash_content("let x = 0;\n"));

        let input = serde_json::json!({ "path": "a.rs", "old_str": "let x = 1;", "new_str": "let x = 2;" });
        let proposal = preview_write_file(&ws, &input, run).unwrap();
        let reason = proposal.reason.expect("stale edit should carry a reason");
        assert!(reason.contains("changed since"), "got: {reason}");
    }

    #[test]
    fn write_is_not_flagged_when_hash_matches_last_read() {
        let (ws, dir) = snapshot_sandbox("fresh");
        let run = "run-fresh";
        clear_run_snapshots(run);
        let body = "let x = 1;\n";
        std::fs::write(dir.join("a.rs"), body).unwrap();
        let rel = ws.display(&ws.resolve_existing("a.rs").unwrap());

        // The model read exactly the current content.
        record_snapshot(run, &rel, &hash_content(body));

        let input = serde_json::json!({ "path": "a.rs", "old_str": "let x = 1;", "new_str": "let x = 2;" });
        let proposal = preview_write_file(&ws, &input, run).unwrap();
        assert!(proposal.reason.is_none(), "fresh edit should not be flagged");
    }

    // ── Post-edit syntax verification (omp's diagnostics, lite) ──────────

    #[test]
    fn verify_passes_valid_rust_and_json() {
        assert!(verify_syntax("src/main.rs", "fn main() {\n    let x = 1;\n}\n").is_none());
        assert!(verify_syntax("package.json", "{\n  \"name\": \"k\"\n}\n").is_none());
    }

    #[test]
    fn verify_flags_broken_rust() {
        // Missing closing brace.
        let v = verify_syntax("src/lib.rs", "fn main() {\n    let x = 1;\n").expect("rust err");
        assert!(v.contains("Syntax check failed"), "got: {v}");
        assert!(v.contains("Rust parse error"), "got: {v}");
    }

    #[test]
    fn verify_flags_broken_json() {
        let v = verify_syntax("data.json", "{ \"a\": 1, }").expect("json err");
        assert!(v.contains("invalid JSON"), "got: {v}");
    }

    #[test]
    fn verify_skips_jsonc_and_unknown_languages() {
        // tsconfig.json is JSONC — comments/trailing commas are legal, so we
        // must not flag it.
        assert!(verify_syntax("tsconfig.json", "{ // ok\n  \"compilerOptions\": {}, }").is_none());
        assert!(verify_syntax(".vscode/settings.json", "{ /* c */ }").is_none());
        // TypeScript has no trustworthy in-process parser here — skipped.
        assert!(verify_syntax("src/App.tsx", "const x = (").is_none());
        // Empty / whitespace content is never flagged.
        assert!(verify_syntax("a.rs", "   \n").is_none());
    }

    #[test]
    fn clear_run_snapshots_forgets_the_run() {
        let run = "run-clear";
        record_snapshot(run, "x.rs", "abc");
        assert_eq!(last_seen_hash(run, "x.rs").as_deref(), Some("abc"));
        clear_run_snapshots(run);
        assert_eq!(last_seen_hash(run, "x.rs"), None);
    }

    #[test]
    fn line_spans_round_trip() {
        let s = "alpha\nbeta\ngamma";
        let spans = line_spans(s);
        assert_eq!(spans.len(), 3);
        assert_eq!(&s[spans[0].0..spans[0].1], "alpha");
        assert_eq!(&s[spans[2].0..spans[2].1], "gamma");
        // Trailing newline does not create a phantom empty line.
        assert_eq!(line_spans("a\n").len(), 1);
    }
}
