use super::types::{AgentMode, DiffProposal, ToolResult};
use std::path::{Path, PathBuf};
use std::process::Command;

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
}

type ReadToolFn = fn(root: &str, input: &serde_json::Value) -> ToolResult;
type WritePreviewFn = fn(root: &str, input: &serde_json::Value, run_id: &str) -> Result<DiffProposal, ToolResult>;

struct ToolEntry {
    kind: ToolKind,
    schema: serde_json::Value,
    run_read: Option<ReadToolFn>,
    run_write_preview: Option<WritePreviewFn>,
}

fn schema(name: &str, description: &str, properties: serde_json::Value, required: &[&str]) -> serde_json::Value {
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
            run_read: Some(|root, input| read_file(root, &trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string()))),
            run_write_preview: None,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("list_dir", "List entries in a workspace directory.",
                serde_json::json!({ "path": { "type": "string", "description": "Workspace-relative directory path. Use . for the root." } }),
                &["path"]),
            run_read: Some(|root, input| list_dir(root, &trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string()))),
            run_write_preview: None,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("glob", "Find workspace files matching a glob-like pattern. Supports * and ? wildcards.",
                serde_json::json!({
                    "pattern": { "type": "string", "description": "Pattern such as src/**/*.ts or *.md." },
                    "path": { "type": "string", "description": "Optional workspace-relative directory to search from." }
                }),
                &["pattern"]),
            run_read: Some(|root, input| glob(root, input)),
            run_write_preview: None,
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
            run_read: Some(|root, input| grep(root, input)),
            run_write_preview: None,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("get_git_status", "Return git branch and changed files for the workspace.",
                serde_json::json!({}), &[]),
            run_read: Some(|root, _input| get_git_status(root)),
            run_write_preview: None,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("get_git_diff", "Return git diff for the workspace or one path.",
                serde_json::json!({
                    "path": { "type": "string", "description": "Optional workspace-relative path." },
                    "staged": { "type": "boolean", "description": "Whether to read staged diff." }
                }),
                &[]),
            run_read: Some(|root, input| get_git_diff(root, input)),
            run_write_preview: None,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("clean_context", "Discard tool results that led nowhere (a Glob with 300 paths, a read of the wrong file, a search that came up empty). Each removed result is replaced by '[cleaned: tool_name]' so the agent knows it threw something away. Only the current turn is affected, keeping the prompt cache intact.",
                serde_json::json!({
                    "ids": { "type": "array", "description": "List of tool_call_ids to clean from the current turn." }
                }),
                &["ids"]),
            run_read: Some(|_root, input| {
                let ids: Vec<String> = input.get("ids")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                ok(format!("Context cleaned: {} tool result(s) marked for removal", ids.len()))
            }),
            run_write_preview: None,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("web_search", "Search the web for documentation or current information. Returns up to 10 results with title, URL, and snippet.",
                serde_json::json!({
                    "query": { "type": "string", "description": "The search query." }
                }),
                &["query"]),
            run_read: Some(|_root, input| web_search(input)),
            run_write_preview: None,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("web_fetch", "Fetch the content of a URL and return it as text. Use for reading documentation, blog posts, or API references.",
                serde_json::json!({
                    "url": { "type": "string", "description": "The URL to fetch." }
                }),
                &["url"]),
            run_read: Some(|_root, input| web_fetch(input)),
            run_write_preview: None,
        },
        ToolEntry {
            kind: ToolKind::Write,
            schema: schema("write_file", "Propose a search-and-replace edit to an existing file. The user reviews the diff and approves or rejects it.",
                serde_json::json!({
                    "path": { "type": "string", "description": "Path of the existing file, relative to the workspace root." },
                    "old_str": { "type": "string", "description": "The exact text to find in the file. Must match a unique substring." },
                    "new_str": { "type": "string", "description": "The replacement text. Use an empty string to delete the matched text." }
                }),
                &["path", "old_str", "new_str"]),
            run_read: None,
            run_write_preview: Some(|root, input, run_id| preview_write_file(root, input, run_id)),
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
            run_write_preview: Some(|root, input, run_id| preview_create_file(root, input, run_id)),
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
            run_write_preview: Some(|root, input, run_id| preview_create_skill(root, input, run_id)),
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
    let mut tools: Vec<serde_json::Value> = reg.iter()
        .filter(|e| {
            let kind_ok = kind_filter.map_or(true, |k| e.kind == k);
            if !kind_ok { return false; }
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
    if tools.is_empty() { None } else { Some(tools) }
}

pub fn is_write_tool(name: &str) -> bool {
    registry().iter().any(|e| e.kind == ToolKind::Write && schema_has_name(&e.schema, name))
}

fn schema_has_name(schema: &serde_json::Value, name: &str) -> bool {
    schema
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        == Some(name)
}

pub fn execute_read_only_tool(root: &str, call: &NormalizedToolCall) -> ToolResult {
    // Check dynamic tools first
    if let Some(result) = execute_dynamic_tool(&call.name, &call.input, Some(root)) {
        return result;
    }
    // Then built-in registry
    let entry = registry().into_iter().find(|e| schema_has_name(&e.schema, &call.name));
    match entry.and_then(|e| e.run_read) {
        Some(f) => f(root, &call.input),
        None => err(format!("Unknown tool: {}", call.name)),
    }
}

pub fn execute_write_tool_preview(root: &str, call: &NormalizedToolCall, run_id: &str) -> Result<DiffProposal, ToolResult> {
    let entry = registry().into_iter().find(|e| schema_has_name(&e.schema, &call.name));
    match entry.and_then(|e| e.run_write_preview) {
        // Key the proposal to the tool call's id (unique per call), not the
        // file path — two edits to the same file in one run must not collide.
        Some(f) => f(root, &call.input, run_id).map(|mut proposal| {
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
    #[serde(default = "default_timeout")]
    timeout_secs: u64,
    #[serde(default)]
    cwd: String,
}

fn default_timeout() -> u64 { 30 }

#[derive(serde::Deserialize)]
struct ToolsConfig {
    tools: Vec<DynamicToolDef>,
}

fn load_tools_from(path: &Path) -> Vec<DynamicToolDef> {
    let content = match std::fs::read_to_string(path) { Ok(c) => c, Err(_) => return Vec::new() };
    let config: ToolsConfig = match serde_json::from_str(&content) { Ok(c) => c, Err(_) => return Vec::new() };
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

pub fn execute_dynamic_tool(name: &str, input: &serde_json::Value, workspace_root: Option<&str>) -> Option<ToolResult> {
    let mut all_defs = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();
    all_defs.extend(load_tools_from(&Path::new(&home).join(".agents/tools.json")));
    if let Some(root) = workspace_root {
        all_defs.extend(load_tools_from(&Path::new(root).join(".agents/tools.json")));
    }
    let def = all_defs.iter().find(|d| d.name == name)?;
    let cwd = if def.cwd == "workspace" { workspace_root.unwrap_or(".") } else { "." };
    let args_str = string_arg(input, "args").unwrap_or_default();
    let full_command = if args_str.is_empty() { def.command.clone() } else { format!("{} {}", def.command, args_str) };

    let output = Command::new("sh")
        .arg("-c")
        .arg(&full_command)
        .current_dir(cwd)
        .output();
    let output = match output {
        Ok(o) => o,
        Err(e) => return Some(ToolResult { ok: false, content: format!("Failed to run {}: {e}", def.name), metadata: None }),
    };
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut result = stdout.trim().to_string();
        if !stderr.trim().is_empty() { result.push_str(&format!("\n\nstderr:\n{}", stderr.trim())); }
        if result.is_empty() { result = "(command completed successfully)".to_string(); }
        Some(ToolResult { ok: true, content: result.chars().take(4000).collect(), metadata: None })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Some(ToolResult { ok: false, content: format!("{} failed: {}", def.name, stderr.trim()), metadata: None })
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
            Some(NormalizedToolCall { id, name: name.to_string(), input })
        })
        .collect()
}

// ── Execution helpers ────────────────────────────────────────────────────

fn ok(content: String) -> ToolResult {
    ToolResult { ok: true, content, metadata: None }
}

fn err(content: String) -> ToolResult {
    ToolResult { ok: false, content, metadata: None }
}

/// Raw string argument — preserves whitespace exactly. Use for file contents
/// and edit strings, where leading/trailing whitespace is significant.
fn string_arg(input: &serde_json::Value, key: &str) -> Option<String> {
    input.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Trimmed, non-empty string argument — for paths, patterns, queries, URLs.
fn trimmed_arg(input: &serde_json::Value, key: &str) -> Option<String> {
    input.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn bool_arg(input: &serde_json::Value, key: &str) -> bool {
    input.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn usize_arg(input: &serde_json::Value, key: &str, fallback: usize) -> usize {
    input.get(key).and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(fallback)
}

fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).ok().filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

fn clean_user_path(user_path: &str) -> String {
    let trimmed = user_path.trim();
    if trimmed.is_empty() || trimmed == "/" { ".".to_string() } else { trimmed.trim_start_matches('/').to_string() }
}

fn resolve_existing_path(root: &Path, user_path: &str) -> Result<PathBuf, String> {
    let root_real = root.canonicalize().map_err(|e| format!("Unable to resolve workspace root: {e}"))?;
    let cleaned = clean_user_path(user_path);
    let candidate = if cleaned == "." { root_real.clone() } else { root.join(cleaned) };
    let real = candidate.canonicalize().map_err(|e| format!("Unable to resolve path \"{user_path}\": {e}"))?;
    if !real.starts_with(&root_real) {
        return Err(format!("Path \"{user_path}\" is outside the workspace"));
    }
    Ok(real)
}

/// Resolve a path that may not exist yet (create_file, apply_write), verifying
/// it stays inside the workspace. canonicalize() fails on non-existent paths,
/// so instead we reject any `..`/absolute component outright, then canonicalize
/// the deepest existing ancestor so a symlinked directory can't smuggle the
/// write outside the root.
pub(crate) fn resolve_new_path(root: &Path, user_path: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let root_real = root.canonicalize().map_err(|e| format!("Unable to resolve workspace root: {e}"))?;
    let cleaned = clean_user_path(user_path);
    let rel = Path::new(&cleaned);
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("Path \"{user_path}\" is outside the workspace"));
    }
    let candidate = root_real.join(rel);
    let mut ancestor = candidate.clone();
    while !ancestor.exists() {
        match ancestor.parent() {
            Some(p) => ancestor = p.to_path_buf(),
            None => return Err(format!("Path \"{user_path}\" is outside the workspace")),
        }
    }
    let ancestor_real = ancestor.canonicalize().map_err(|e| format!("Unable to resolve path \"{user_path}\": {e}"))?;
    if !ancestor_real.starts_with(&root_real) {
        return Err(format!("Path \"{user_path}\" is outside the workspace"));
    }
    Ok(candidate)
}

// ── Read-only tools ─────────────────────────────────────────────────────

fn read_file(root: &str, path: &str) -> ToolResult {
    let root = Path::new(root);
    let full = match resolve_existing_path(root, path) { Ok(p) => p, Err(e) => return err(e) };
    let metadata = match std::fs::metadata(&full) { Ok(m) => m, Err(e) => return err(format!("Unable to read metadata: {e}")) };
    if !metadata.is_file() { return err(format!("{} is not a file", display_path(root, &full))); }
    if metadata.len() > MAX_FILE_BYTES {
        return err(format!("{} is too large to read safely ({} bytes, max {})", display_path(root, &full), metadata.len(), MAX_FILE_BYTES));
    }
    match std::fs::read_to_string(&full) {
        Ok(content) => ok(format!("Contents of {} ({} chars):\n```\n{}\n```", display_path(root, &full), content.len(), content)),
        Err(e) => err(format!("Unable to read {} as text: {e}", display_path(root, &full))),
    }
}

fn list_dir(root: &str, path: &str) -> ToolResult {
    let root = Path::new(root);
    let full = match resolve_existing_path(root, path) { Ok(p) => p, Err(e) => return err(e) };
    if !full.is_dir() { return err(format!("{} is not a directory", display_path(root, &full))); }
    let entries = match std::fs::read_dir(&full) { Ok(e) => e, Err(e) => return err(format!("Unable to list directory: {e}")) };
    let mut rows = Vec::new();
    for entry in entries.flatten().take(MAX_LIST_ENTRIES) {
        let file_type = entry.file_type().ok();
        let is_dir = file_type.as_ref().is_some_and(|t| t.is_dir());
        rows.push(format!("{}{}", if is_dir { "[dir] " } else { "      " }, entry.file_name().to_string_lossy()));
    }
    rows.sort();
    ok(format!("Entries in {}:\n{}", display_path(root, &full), if rows.is_empty() { "(empty)".to_string() } else { rows.join("\n") }))
}

fn ignored_dir(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".turbo" | ".cache" | "coverage" | ".venv" | "__pycache__")
}

fn walk_files(root: &Path, start: &Path, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_WALK_FILES { return; }
    let Ok(entries) = std::fs::read_dir(start) else { return; };
    for entry in entries.flatten() {
        if out.len() >= MAX_WALK_FILES { return; }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue; };
        if ft.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !ignored_dir(&name) { walk_files(root, &path, out); }
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
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) { pi += 1; ti += 1; }
        else if pi < p.len() && p[pi] == b'*' { star = Some(pi); mark = ti; pi += 1; }
        else if let Some(s) = star { pi = s + 1; mark += 1; ti = mark; }
        else { return false; }
    }
    while pi < p.len() && p[pi] == b'*' { pi += 1; }
    pi == p.len()
}

fn glob(root: &str, input: &serde_json::Value) -> ToolResult {
    let pattern = match trimmed_arg(input, "pattern") { Some(p) => p, None => return err("glob requires a string pattern".to_string()) };
    let start_arg = trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string());
    let root = Path::new(root);
    let start = match resolve_existing_path(root, &start_arg) { Ok(p) => p, Err(e) => return err(e) };
    let mut files = Vec::new();
    walk_files(root, &start, &mut files);
    let root_real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut matches: Vec<String> = files.into_iter()
        .filter_map(|path| {
            let rel = display_path(&root_real, &path);
            if wildcard_match(&pattern, &rel) || wildcard_match(&pattern.replace("**/", ""), &rel) { Some(rel) } else { None }
        })
        .take(MAX_SEARCH_RESULTS).collect();
    matches.sort();
    ok(format!("Glob matches for {pattern}:\n{}", if matches.is_empty() { "(none)".to_string() } else { matches.join("\n") }))
}

fn grep(root: &str, input: &serde_json::Value) -> ToolResult {
    // Grep patterns keep their whitespace (a leading space can be the point),
    // but an empty pattern would match every line.
    let pattern = match string_arg(input, "pattern").filter(|p| !p.is_empty()) { Some(p) => p, None => return err("grep requires a string pattern".to_string()) };
    let max = usize_arg(input, "maxResults", MAX_SEARCH_RESULTS).min(MAX_SEARCH_RESULTS);
    let path_arg = trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string());
    let root = Path::new(root);
    let start = match resolve_existing_path(root, &path_arg) { Ok(p) => p, Err(e) => return err(e) };
    let mut files = Vec::new();
    if start.is_file() { files.push(start); } else { walk_files(root, &start, &mut files); }
    let root_real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut rows = Vec::new();
    for file in files {
        if rows.len() >= max { break; }
        if std::fs::metadata(&file).map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) { continue; }
        let Ok(content) = std::fs::read_to_string(&file) else { continue; };
        for (idx, line) in content.lines().enumerate() {
            if line.contains(&pattern) {
                rows.push(format!("{}:{}: {}", display_path(&root_real, &file), idx + 1, line));
                if rows.len() >= max { break; }
            }
        }
    }
    ok(format!("Grep matches for {pattern}:\n{}", if rows.is_empty() { "(none)".to_string() } else { rows.join("\n") }))
}

fn git_output(root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("-C").arg(root).args(args).output().map_err(|e| format!("Failed to run git: {e}"))?;
    if output.status.success() { Ok(String::from_utf8_lossy(&output.stdout).to_string()) }
    else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

fn get_git_status(root: &str) -> ToolResult {
    match git_output(root, &["status", "--short", "--branch"]) { Ok(o) => ok(format!("Git status:\n{}", o.trim())), Err(e) => err(e) }
}

fn get_git_diff(root: &str, input: &serde_json::Value) -> ToolResult {
    let staged = bool_arg(input, "staged");
    let path = trimmed_arg(input, "path");
    let mut args = vec!["diff"];
    if staged { args.push("--cached"); }
    if let Some(p) = path.as_deref() { args.push("--"); args.push(p); }
    match git_output(root, &args) {
        Ok(output) => ok(format!("Git diff{}:\n{}", if staged { " (staged)" } else { "" }, if output.trim().is_empty() { "(empty)" } else { output.trim() })),
        Err(e) => err(e),
    }
}

// ── Web tools ───────────────────────────────────────────────────────────

fn web_search(input: &serde_json::Value) -> ToolResult {
    let query = match trimmed_arg(input, "query") { Some(q) => q, None => return err("web_search requires a query".to_string()) };
    let url = format!("https://lite.duckduckgo.com/lite/?q={}", urlencoding(&query));

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
    ok(format!("Web results for '{query}':\n\n{}", results.join("\n\n")))
}

fn web_fetch(input: &serde_json::Value) -> ToolResult {
    let url = match trimmed_arg(input, "url") { Some(u) => u, None => return err("web_fetch requires a url".to_string()) };
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
        _ => return err("Web fetch timed out. The page may be too large or unreachable.".to_string()),
    };

    let text = strip_html(&body);
    let truncated: String = text.chars().take(6000).collect();
    let note = if text.chars().count() > 6000 { "\n\n…(truncated)" } else { "" };
    ok(format!("Content of {url}:\n\n{truncated}{note}"))
}

fn extract_href(line: &str) -> Option<String> {
    let start = line.find("href=\"")?;
    let rest = &line[start + 6..];
    let end = rest.find('"')?;
    let href = decode_html_entities(&rest[..end]);
    if href.is_empty() { None } else { Some(href) }
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
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag { out.push(c); }
    }
    decode_html_entities(out.trim())
}

fn strip_html(input: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut in_script = false;
    let mut skip: usize = 0;

    for (i, c) in input.char_indices() {
        if skip > 0 { skip -= 1; continue; }
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
            if input[i..].to_lowercase().starts_with("<script") { in_script = true; }
            if input[i..].to_lowercase().starts_with("<style") { in_script = true; }
            continue;
        }
        if c == '>' { in_tag = false; continue; }
        if !in_tag {
            if c == '&' {
                if input[i..].starts_with("&amp;") { out.push('&'); skip = 4; }
                else if input[i..].starts_with("&lt;") { out.push('<'); skip = 3; }
                else if input[i..].starts_with("&gt;") { out.push('>'); skip = 3; }
                else if input[i..].starts_with("&quot;") { out.push('"'); skip = 5; }
                else if input[i..].starts_with("&#39;") { out.push('\''); skip = 4; }
                else if input[i..].starts_with("&nbsp;") { out.push(' '); skip = 5; }
                else { out.push(c); }
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
        return old.iter().map(|l| ('-', *l)).chain(new.iter().map(|l| ('+', *l))).collect();
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
    if old == new { return String::new(); }
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    let mut prefix = 0;
    let max_prefix = old_lines.len().min(new_lines.len());
    while prefix < max_prefix && old_lines[prefix] == new_lines[prefix] { prefix += 1; }
    let mut suffix = 0;
    let max_suffix = max_prefix - prefix;
    while suffix < max_suffix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix] { suffix += 1; }

    let ops = diff_ops(
        &old_lines[prefix..old_lines.len() - suffix],
        &new_lines[prefix..new_lines.len() - suffix],
    );

    const CONTEXT: usize = 3;
    let ctx_start = prefix.saturating_sub(CONTEXT);
    let lead = old_lines[ctx_start..prefix].iter().map(|l| (' ', *l));
    let tail_end = (old_lines.len() - suffix + CONTEXT).min(old_lines.len());
    let tail = old_lines[old_lines.len() - suffix..tail_end].iter().map(|l| (' ', *l));
    let hunk: Vec<(char, &str)> = lead.chain(ops).chain(tail).collect();

    let old_count = hunk.iter().filter(|(c, _)| *c != '+').count();
    let new_count = hunk.iter().filter(|(c, _)| *c != '-').count();
    let mut out = format!(
        "@@ -{},{} +{},{} @@\n",
        if old_count == 0 { ctx_start } else { ctx_start + 1 }, old_count,
        if new_count == 0 { ctx_start } else { ctx_start + 1 }, new_count,
    );
    for (c, l) in &hunk {
        out.push(*c);
        out.push_str(l);
        out.push('\n');
    }
    out.trim_end().to_string()
}

fn preview_write_file(root: &str, input: &serde_json::Value, run_id: &str) -> Result<DiffProposal, ToolResult> {
    let path = trimmed_arg(input, "path").ok_or_else(|| err("write_file requires a string path".to_string()))?;
    // old_str/new_str must keep their whitespace verbatim — indentation and
    // trailing newlines are part of the match and the replacement.
    let old_str = string_arg(input, "old_str").filter(|s| !s.is_empty()).ok_or_else(|| err("write_file requires old_str".to_string()))?;
    let new_str = string_arg(input, "new_str").unwrap_or_default();
    let root = Path::new(root);
    let full = resolve_existing_path(root, &path).map_err(|e| err(e))?;
    let rel = display_path(root, &full);
    let current = std::fs::read_to_string(&full).map_err(|e| err(format!("Cannot read {rel}: {e}")))?;
    let occurrences = current.matches(&old_str).count();
    if occurrences == 0 { return Err(err(format!("old_str not found in {rel}. Read the file again and use an exact substring."))); }
    if occurrences > 1 { return Err(err(format!("old_str matches {occurrences} locations in {rel}. Include more surrounding context."))); }
    let new_content = current.replacen(&old_str, &new_str, 1);
    if new_content.len() as u64 > MAX_WRITE_BYTES { return Err(err(format!("Resulting file would be too large"))); }
    Ok(DiffProposal {
        id: format!("diff_{}_{}", run_id, format!("write_{}", rel.replace('/', "_"))),
        run_id: run_id.to_string(), tool_call_id: format!("write_{}", rel),
        path: rel, old_content: current.clone(), new_content: new_content.clone(),
        old_hash: hash_content(&current), new_hash: hash_content(&new_content),
        unified_diff: unified_diff_lines(&current, &new_content),
        is_create: false, reason: None,
    })
}

fn preview_create_file(root: &str, input: &serde_json::Value, run_id: &str) -> Result<DiffProposal, ToolResult> {
    let path = trimmed_arg(input, "path").ok_or_else(|| err("create_file requires a string path".to_string()))?;
    // Contents are raw (may legitimately be empty or whitespace-only).
    let contents = string_arg(input, "contents").ok_or_else(|| err("create_file requires string contents".to_string()))?;
    let root = Path::new(root);
    let candidate = resolve_new_path(root, &path).map_err(err)?;
    let rel = clean_user_path(&path);
    if candidate.exists() { return Err(err(format!("{rel} already exists. Use write_file to modify an existing file."))); }
    if contents.len() as u64 > MAX_WRITE_BYTES { return Err(err(format!("Contents too large"))); }
    Ok(DiffProposal {
        id: format!("diff_{}_{}", run_id, format!("create_{}", rel.replace('/', "_"))),
        run_id: run_id.to_string(), tool_call_id: format!("create_{}", rel),
        path: rel, old_content: String::new(), new_content: contents.clone(),
        old_hash: hash_content(""), new_hash: hash_content(&contents),
        unified_diff: format!("@@ -0,0 +1,{} @@\n{}", contents.lines().count(), contents.lines().map(|l| format!("+{}", l)).collect::<Vec<_>>().join("\n")),
        is_create: true, reason: None,
    })
}

fn preview_create_skill(root: &str, input: &serde_json::Value, run_id: &str) -> Result<DiffProposal, ToolResult> {
    let name = string_arg(input, "name").ok_or_else(|| err("create_skill requires a name".to_string()))?;
    let title = string_arg(input, "title").unwrap_or_else(|| name.clone());
    let description = string_arg(input, "description").unwrap_or_default();
    let instructions = string_arg(input, "instructions").ok_or_else(|| err("create_skill requires instructions".to_string()))?;
    let safe_name = name.to_lowercase().replace(|c: char| !c.is_alphanumeric() && c != '-', "-").trim_matches('-').to_string();
    let rel = format!(".agents/skills/{safe_name}/SKILL.md");
    let root_path = Path::new(root);
    let full = root_path.join(&rel);
    if full.exists() {
        return Err(err(format!("{rel} already exists. Use write_file to edit it.")));
    }
    let content = format!(
        "---\nname: {title}\ndescription: {description}\n---\n\n{instructions}\n"
    );
    Ok(DiffProposal {
        id: format!("diff_{}_{}", run_id, safe_name),
        run_id: run_id.to_string(),
        tool_call_id: format!("skill_{}", safe_name),
        path: rel,
        old_content: String::new(),
        new_content: content.clone(),
        old_hash: hash_content(""),
        new_hash: hash_content(&content),
        unified_diff: format!("@@ -0,0 +1,{} @@\n{}", content.lines().count(), content.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n")),
        is_create: true,
        reason: Some(format!("New skill: {title}")),
    })
}

pub fn apply_write(root: &str, diff: &DiffProposal) -> Result<ToolResult, ToolResult> {
    let root_path = Path::new(root);
    // Re-validate at apply time: never trust a proposal path blindly.
    let full = resolve_new_path(root_path, &diff.path).map_err(err)?;
    if let Some(parent) = full.parent() { std::fs::create_dir_all(parent).map_err(|e| err(format!("Cannot create directory: {e}")))?; }
    std::fs::write(&full, &diff.new_content).map_err(|e| err(format!("Cannot write {}: {e}", diff.path)))?;
    let rel = display_path(root_path, &full);
    if diff.is_create { Ok(ok(format!("Applied: created {rel} ({} chars).", diff.new_content.len()))) }
    else { Ok(ok(format!("Applied: edited {rel}."))) }
}

pub fn clean_context_ids(tool_call_ids: &[String], messages: &mut Vec<serde_json::Value>) {
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("tool") { continue; }
        let tc_id = msg.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or_default();
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
        assert_eq!(string_arg(&input, "old_str").as_deref(), Some("    return x;\n"));
    }

    #[test]
    fn trimmed_arg_trims_and_rejects_empty() {
        let input = serde_json::json!({ "path": "  src/main.rs  ", "blank": "   " });
        assert_eq!(trimmed_arg(&input, "path").as_deref(), Some("src/main.rs"));
        assert_eq!(trimmed_arg(&input, "blank"), None);
    }

    #[test]
    fn resolve_new_path_rejects_traversal() {
        let root = std::env::temp_dir();
        assert!(resolve_new_path(&root, "../escape.txt").is_err());
        assert!(resolve_new_path(&root, "a/../../escape.txt").is_err());
        assert!(resolve_new_path(&root, "/etc/passwd").is_ok()); // leading '/' is stripped → etc/passwd inside root
        assert!(resolve_new_path(&root, "sub/dir/new.txt").is_ok());
    }

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
}
