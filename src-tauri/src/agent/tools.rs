use super::types::{AgentMode, ToolResult};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_FILE_BYTES: u64 = 220_000;
const MAX_LIST_ENTRIES: usize = 500;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_WALK_FILES: usize = 6_000;

#[derive(Clone, Debug)]
pub struct NormalizedToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

fn tool_schema(
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

pub fn schemas_for_mode(mode: &AgentMode) -> Option<Vec<serde_json::Value>> {
    match mode {
        AgentMode::Chat => None,
        AgentMode::Plan | AgentMode::Goal => Some(vec![
            tool_schema(
                "read_file",
                "Read the full text contents of a file in the workspace.",
                serde_json::json!({
                    "path": { "type": "string", "description": "Workspace-relative file path." }
                }),
                &["path"],
            ),
            tool_schema(
                "list_dir",
                "List entries in a workspace directory.",
                serde_json::json!({
                    "path": { "type": "string", "description": "Workspace-relative directory path. Use . for the root." }
                }),
                &["path"],
            ),
            tool_schema(
                "glob",
                "Find workspace files matching a glob-like pattern. Supports * and ? wildcards.",
                serde_json::json!({
                    "pattern": { "type": "string", "description": "Pattern such as src/**/*.ts or *.md." },
                    "path": { "type": "string", "description": "Optional workspace-relative directory to search from." }
                }),
                &["pattern"],
            ),
            tool_schema(
                "grep",
                "Search text files in the workspace for a literal pattern.",
                serde_json::json!({
                    "pattern": { "type": "string", "description": "Text pattern to search for." },
                    "path": { "type": "string", "description": "Optional workspace-relative file or directory." },
                    "maxResults": { "type": "number", "description": "Optional cap on returned matches." }
                }),
                &["pattern"],
            ),
            tool_schema(
                "get_git_status",
                "Return git branch and changed files for the workspace.",
                serde_json::json!({}),
                &[],
            ),
            tool_schema(
                "get_git_diff",
                "Return git diff for the workspace or one path.",
                serde_json::json!({
                    "path": { "type": "string", "description": "Optional workspace-relative path." },
                    "staged": { "type": "boolean", "description": "Whether to read staged diff." }
                }),
                &[],
            ),
        ]),
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

pub fn execute_read_only_tool(root: &str, call: &NormalizedToolCall) -> ToolResult {
    match call.name.as_str() {
        "read_file" => read_file(
            root,
            &string_arg(&call.input, "path").unwrap_or_else(|| ".".to_string()),
        ),
        "list_dir" => list_dir(
            root,
            &string_arg(&call.input, "path").unwrap_or_else(|| ".".to_string()),
        ),
        "glob" => glob(root, &call.input),
        "grep" => grep(root, &call.input),
        "get_git_status" => get_git_status(root),
        "get_git_diff" => get_git_diff(root, &call.input),
        other => err(format!("Unknown read-only tool \"{other}\"")),
    }
}

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

fn string_arg(input: &serde_json::Value, key: &str) -> Option<String> {
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

fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

fn clean_user_path(user_path: &str) -> String {
    let trimmed = user_path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        ".".to_string()
    } else {
        trimmed.trim_start_matches('/').to_string()
    }
}

fn resolve_existing_path(root: &Path, user_path: &str) -> Result<PathBuf, String> {
    let root_real = root
        .canonicalize()
        .map_err(|e| format!("Unable to resolve workspace root: {e}"))?;
    let cleaned = clean_user_path(user_path);
    let candidate = if cleaned == "." {
        root_real.clone()
    } else {
        root.join(cleaned)
    };
    let real = candidate
        .canonicalize()
        .map_err(|e| format!("Unable to resolve path \"{user_path}\": {e}"))?;
    if !real.starts_with(&root_real) {
        return Err(format!("Path \"{user_path}\" is outside the workspace"));
    }
    Ok(real)
}

fn read_file(root: &str, path: &str) -> ToolResult {
    let root = Path::new(root);
    let full = match resolve_existing_path(root, path) {
        Ok(path) => path,
        Err(e) => return err(e),
    };
    let metadata = match std::fs::metadata(&full) {
        Ok(metadata) => metadata,
        Err(e) => return err(format!("Unable to read metadata: {e}")),
    };
    if !metadata.is_file() {
        return err(format!("{} is not a file", display_path(root, &full)));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return err(format!(
            "{} is too large to read safely ({} bytes, max {})",
            display_path(root, &full),
            metadata.len(),
            MAX_FILE_BYTES
        ));
    }
    match std::fs::read_to_string(&full) {
        Ok(content) => ok(format!(
            "Contents of {} ({} chars):\n```\n{}\n```",
            display_path(root, &full),
            content.len(),
            content
        )),
        Err(e) => err(format!(
            "Unable to read {} as text: {e}",
            display_path(root, &full)
        )),
    }
}

fn list_dir(root: &str, path: &str) -> ToolResult {
    let root = Path::new(root);
    let full = match resolve_existing_path(root, path) {
        Ok(path) => path,
        Err(e) => return err(e),
    };
    if !full.is_dir() {
        return err(format!("{} is not a directory", display_path(root, &full)));
    }
    let entries = match std::fs::read_dir(&full) {
        Ok(entries) => entries,
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
        display_path(root, &full),
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

fn glob(root: &str, input: &serde_json::Value) -> ToolResult {
    let pattern = match string_arg(input, "pattern") {
        Some(pattern) => pattern,
        None => return err("glob requires a string pattern".to_string()),
    };
    let start_arg = string_arg(input, "path").unwrap_or_else(|| ".".to_string());
    let root = Path::new(root);
    let start = match resolve_existing_path(root, &start_arg) {
        Ok(path) => path,
        Err(e) => return err(e),
    };
    let mut files = Vec::new();
    walk_files(root, &start, &mut files);
    let root_real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut matches: Vec<String> = files
        .into_iter()
        .filter_map(|path| {
            let rel = display_path(&root_real, &path);
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

fn grep(root: &str, input: &serde_json::Value) -> ToolResult {
    let pattern = match string_arg(input, "pattern") {
        Some(pattern) => pattern,
        None => return err("grep requires a string pattern".to_string()),
    };
    let max = usize_arg(input, "maxResults", MAX_SEARCH_RESULTS).min(MAX_SEARCH_RESULTS);
    let path_arg = string_arg(input, "path").unwrap_or_else(|| ".".to_string());
    let root = Path::new(root);
    let start = match resolve_existing_path(root, &path_arg) {
        Ok(path) => path,
        Err(e) => return err(e),
    };
    let mut files = Vec::new();
    if start.is_file() {
        files.push(start);
    } else {
        walk_files(root, &start, &mut files);
    }
    let root_real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
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
                rows.push(format!(
                    "{}:{}: {}",
                    display_path(&root_real, &file),
                    idx + 1,
                    line
                ));
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

fn git_output(root: &str, args: &[&str]) -> Result<String, String> {
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

fn get_git_status(root: &str) -> ToolResult {
    match git_output(root, &["status", "--short", "--branch"]) {
        Ok(output) => ok(format!("Git status:\n{}", output.trim())),
        Err(e) => err(e),
    }
}

fn get_git_diff(root: &str, input: &serde_json::Value) -> ToolResult {
    let staged = bool_arg(input, "staged");
    let path = string_arg(input, "path");
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path.as_deref() {
        args.push("--");
        args.push(path);
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
