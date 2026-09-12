#[path = "spreadsheet_tools.rs"]
mod spreadsheets;
use super::conversation_search;
use super::todo;
use super::glob_match::wildcard_match;
use super::types::{AgentMode, DiffProposal, ToolResult};
use crate::workspace::{
    is_sensitive_path, Access, Workspace, AGENT_MAX_READ_BYTES, AGENT_MAX_WRITE_BYTES,
};
use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
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

const MAX_LIST_ENTRIES: usize = 500;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_WALK_FILES: usize = 6_000;
const MAX_WEB_RESPONSE_BYTES: u64 = 1_000_000;
const MAX_WEB_REDIRECTS: usize = 5;

/// The advisor-consult tool name. A side-effect-free Pause tool available in
/// both Plan and Goal (unlike other Pause tools, which are Goal-only). Named
/// once here so the offer filter, the mode gate, and the loop dispatch agree.
pub const ADVISOR_TOOL: &str = "consult_advisor";
/// The builtin shell-command tool name. Every other command-capability tool
/// is a dynamic tool from `.agents/tools.json`.
pub const RUN_COMMAND_TOOL: &str = "run_command";

/// Which Pause ceremony a Pause entry runs. Tool identity is registry data:
/// the run loop dispatches on this, never on a tool-name literal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseFlavor {
    /// `userAnswerQuestion` — ask the user, feed the verbatim answer back.
    Question,
    /// `spawn_subagent` — run a nested child Run in Rust and report back.
    Subagent,
    /// `consult_advisor` — park while a stronger model answers one question.
    Advisor,
}

/// The Pause flavor for a tool name, `None` for non-Pause tools. Lives beside
/// the registry entries so the mapping can't drift from them unnoticed —
/// `every_pause_entry_has_a_flavor` pins that.
pub fn pause_flavor(name: &str) -> Option<PauseFlavor> {
    match name {
        "userAnswerQuestion" => Some(PauseFlavor::Question),
        "spawn_subagent" => Some(PauseFlavor::Subagent),
        ADVISOR_TOOL => Some(PauseFlavor::Advisor),
        _ => None,
    }
}

/// Which authenticated coordination operation a registry entry performs.
/// The Harness dispatches on this enum so Tool names stay registry data rather
/// than becoming a second, drifting switch in the run loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinationFlavor {
    List,
    Send,
    Wait,
    Cancel,
    ReadResult,
}

pub fn coordination_flavor(name: &str) -> Option<CoordinationFlavor> {
    match name {
        "agent_list" => Some(CoordinationFlavor::List),
        "agent_send" => Some(CoordinationFlavor::Send),
        "agent_wait" => Some(CoordinationFlavor::Wait),
        "agent_cancel" => Some(CoordinationFlavor::Cancel),
        "agent_read_result" => Some(CoordinationFlavor::ReadResult),
        _ => None,
    }
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolKind {
    ReadOnly,
    // Reads app-owned durable Transcripts from prior Conversations in the
    // current Workspace. Distinct from ReadOnly because the audit record must
    // not claim the Tool read workspace files.
    ConversationHistory,
    // Reads Klide's reviewed, Workspace-scoped Project Memory. Distinct from
    // workspace file reads and conversation history so Transcripts preserve
    // which knowledge boundary a model crossed.
    ProjectMemory,
    // Mutates only Klide's app-owned planning metadata. It is intentionally
    // available in Plan mode, but is not a workspace read.
    PlanState,
    // Reads from the network. Goal-only and routed through the network
    // permission/profile gate in the Harness loop.
    Network,
    Write,
    // Pauses the run for user input (Q&A today; future: confirmation prompts).
    // The registry is the source of truth — the harness dispatches on kind, not
    // by name. A Pause entry has no run_read / run_write_preview; the harness's
    // pause arm handles the interaction.
    Pause,
    // Authenticated inter-agent coordination. These Tools read or append the
    // Rust-owned journal and are available in Plan and Goal modes. They never
    // mutate workspace files or run through a frontend dispatcher.
    Coordination,
    // Runs a shell command after the user approves it (permission gate, like
    // diff review is for edits). The harness's Command arm emits a permission
    // request, waits for approval, then calls `run_command_capture`. Goal-mode
    // only — any command can mutate the workspace.
    Command,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCapability {
    ReadWorkspace,
    ReadConversationHistory,
    ReadProjectMemory,
    UpdatePlanState,
    WriteWorkspace,
    RunCommand,
    PauseForUser,
    CoordinateAgents,
    Network,
}

impl ToolKind {
    pub fn capability(self) -> ToolCapability {
        match self {
            ToolKind::ReadOnly => ToolCapability::ReadWorkspace,
            ToolKind::ConversationHistory => ToolCapability::ReadConversationHistory,
            ToolKind::ProjectMemory => ToolCapability::ReadProjectMemory,
            ToolKind::PlanState => ToolCapability::UpdatePlanState,
            ToolKind::Network => ToolCapability::Network,
            ToolKind::Write => ToolCapability::WriteWorkspace,
            ToolKind::Command => ToolCapability::RunCommand,
            ToolKind::Pause => ToolCapability::PauseForUser,
            ToolKind::Coordination => ToolCapability::CoordinateAgents,
        }
    }
}

pub fn tool_allowed_in_mode(mode: &AgentMode, kind: ToolKind) -> bool {
    match mode {
        // Chat touches nothing in the Workspace — no files, no shell, no
        // memory — but every conversation is on the coordination plane, so it
        // may address its peers. Coordination tools never act on the project;
        // they append to a journal the receiving operator reviews.
        AgentMode::Chat => matches!(kind, ToolKind::Coordination),
        AgentMode::Plan => matches!(
            kind,
            ToolKind::ReadOnly
                | ToolKind::ConversationHistory
                | ToolKind::ProjectMemory
                | ToolKind::PlanState
                | ToolKind::Coordination
        ),
        AgentMode::Goal => true,
    }
}

pub fn tool_kind_label(kind: ToolKind) -> &'static str {
    tool_capability_label(kind.capability())
}

pub fn tool_capability_label(capability: ToolCapability) -> &'static str {
    match capability {
        ToolCapability::ReadWorkspace => "read workspace",
        ToolCapability::ReadConversationHistory => "read conversation history",
        ToolCapability::ReadProjectMemory => "read project memory",
        ToolCapability::UpdatePlanState => "update plan state",
        ToolCapability::WriteWorkspace => "write workspace",
        ToolCapability::RunCommand => "run command",
        ToolCapability::PauseForUser => "pause for user",
        ToolCapability::CoordinateAgents => "coordinate agents",
        ToolCapability::Network => "network",
    }
}

impl ToolCapability {
    /// The stable wire spelling recorded on `ToolCallStarted`, so a Transcript
    /// says what a Tool *was* instead of leaving every later reader to re-derive
    /// it from the Tool's name. `tool_capability_label` is prose for humans;
    /// this is the contract.
    pub fn wire(self) -> &'static str {
        match self {
            ToolCapability::ReadWorkspace => "read_workspace",
            ToolCapability::ReadConversationHistory => "read_conversation_history",
            ToolCapability::ReadProjectMemory => "read_project_memory",
            ToolCapability::UpdatePlanState => "update_plan_state",
            ToolCapability::WriteWorkspace => "write_workspace",
            ToolCapability::RunCommand => "run_command",
            ToolCapability::PauseForUser => "pause_for_user",
            ToolCapability::CoordinateAgents => "coordinate_agents",
            ToolCapability::Network => "network",
        }
    }
}

/// Every Tool whose capability is `PauseForUser` — the ones that stop a run to
/// ask a human or another agent something.
///
/// A headless caller (a Mission attempt with no surface attached) has to turn
/// these off, and used to do it with a hand-written list of three names. That
/// list cannot notice a fourth Pause tool being added, which would then be
/// offered to a model that has nothing to answer it. Ask the registry instead.
///
/// Note this is *not* the same as "every tool that can pause": the permission
/// gate on a Command tool and the diff gate on a Write tool also pause, and
/// they stay enabled because they have durable supervisor state and can be
/// resolved after a surface reattaches.
pub fn interactive_tool_names() -> Vec<String> {
    registry()
        .into_iter()
        .filter(|e| e.kind.capability() == ToolCapability::PauseForUser)
        .filter_map(|e| {
            e.schema["function"]["name"]
                .as_str()
                .map(|n| n.to_string())
        })
        .collect()
}

// Tool executions receive a `Workspace`, never a raw root string — resolving
// a path without going through the Workspace-rooted checks is unrepresentable.
type ReadToolFn = fn(
    ws: &Workspace,
    input: &serde_json::Value,
    run_id: &str,
    runs_dir: Option<&Path>,
) -> ToolResult;
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

fn query_summary(call: &NormalizedToolCall) -> String {
    call.input
        .get("query")
        .and_then(|v| v.as_str())
        .map(|query| format!("{} {}", call.name, query))
        .unwrap_or_else(|| call.name.clone())
}

fn peek_summary(call: &NormalizedToolCall) -> String {
    let id = call.input.get("id").and_then(|v| v.as_str()).unwrap_or("?");
    match call.input.get("query").and_then(|v| v.as_str()) {
        Some(query) => format!("{} #{id} \"{query}\"", call.name),
        None => format!("{} #{id}", call.name),
    }
}

fn run_conversation_search(
    ws: &Workspace,
    input: &serde_json::Value,
    run_id: &str,
    runs_dir: Option<&Path>,
) -> ToolResult {
    let query = input
        .get("query")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if query.is_empty() {
        return err("search_conversations requires a non-empty query.".to_string());
    }
    let limit = input
        .get("maxResults")
        .and_then(|value| value.as_u64())
        .unwrap_or(8)
        .clamp(1, 20) as usize;
    let Some(runs_dir) = runs_dir else {
        return err(
            "Conversation history is unavailable in this Harness environment.".to_string(),
        );
    };
    match conversation_search::search_conversations(runs_dir, ws.root(), run_id, query, limit) {
        Ok(matches) if matches.is_empty() => ok(format!(
            "No previous Klide conversations in this workspace matched {query:?}."
        )),
        Ok(matches) => {
            let mut content = format!(
                "Found {} previous Klide conversation{} in this workspace matching {query:?}:",
                matches.len(),
                if matches.len() == 1 { "" } else { "s" },
            );
            for (index, item) in matches.iter().enumerate() {
                content.push_str(&format!(
                    "\n\n{}. {}\n   conversationId: {}\n   updatedMs: {}\n   match: {} — {}",
                    index + 1,
                    item.title,
                    item.conversation_id,
                    item.updated_ms,
                    item.role,
                    item.snippet,
                ));
                if item.match_count > 1 {
                    content.push_str(&format!("\n   matching messages: {}", item.match_count));
                }
            }
            ToolResult {
                ok: true,
                content,
                metadata: Some(serde_json::json!({ "matches": matches })),
            }
        }
        Err(error) => err(error),
    }
}

/// Tool metadata is stamped into the durable Transcript and feeds Mission
/// Control, evidence export, and (later) the MCP adapter — the absolute local
/// `path` must never cross that boundary. `relPath` identifies the file.
fn memory_entry_metadata(entry: &crate::memory::MemoryEntry) -> serde_json::Value {
    let mut value = serde_json::to_value(entry).unwrap_or(serde_json::Value::Null);
    if let Some(map) = value.as_object_mut() {
        map.remove("path");
    }
    value
}

fn run_memory_search(
    ws: &Workspace,
    input: &serde_json::Value,
    _run_id: &str,
    _runs_dir: Option<&Path>,
) -> ToolResult {
    let query = input
        .get("query")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if query.is_empty() {
        return err("memory_search requires a non-empty query.".to_string());
    }
    let limit = input
        .get("maxResults")
        .and_then(|value| value.as_u64())
        .unwrap_or(5)
        .clamp(1, 20) as usize;
    let include_inactive = input
        .get("includeInactive")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let mut kinds = Vec::new();
    if let Some(values) = input.get("kinds").and_then(|value| value.as_array()) {
        for value in values {
            let Some(raw) = value.as_str() else {
                return err("memory_search kinds must be strings.".to_string());
            };
            let Some(kind) = crate::memory::MemoryKind::parse(raw) else {
                return err(format!("Unknown Project Memory kind `{raw}`."));
            };
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
    }

    match crate::memory::search_workspace_memory(ws, query, &kinds, limit, include_inactive) {
        Ok(hits) if hits.is_empty() => ToolResult {
            ok: true,
            content: format!(
                "No reviewed Project Memory in this workspace matched {query:?}."
            ),
            // The schema promises `{query, hits}` on every search result.
            metadata: Some(serde_json::json!({ "query": query, "hits": [] })),
        },
        Ok(hits) => {
            let mut content = format!(
                "Found {} Project Memory entr{} matching {query:?}:",
                hits.len(),
                if hits.len() == 1 { "y" } else { "ies" },
            );
            for (index, hit) in hits.iter().enumerate() {
                let entry = &hit.entry;
                content.push_str(&format!(
                    "\n\n{}. {} [{}]\n   memoryId: {}\n   score: {}\n   matched: {}",
                    index + 1,
                    entry.title,
                    entry.kind.as_str(),
                    entry.id,
                    hit.score,
                    hit.matched_fields.join(", "),
                ));
                if !hit.excerpt.is_empty() {
                    content.push_str(&format!("\n   excerpt: {}", hit.excerpt));
                }
                if !entry.source_refs.is_empty() {
                    content.push_str(&format!("\n   sources: {}", entry.source_refs.len()));
                }
            }
            let hits_meta: Vec<serde_json::Value> = hits
                .iter()
                .map(|hit| {
                    serde_json::json!({
                        "entry": memory_entry_metadata(&hit.entry),
                        "score": hit.score,
                        "matchedFields": hit.matched_fields,
                        "excerpt": hit.excerpt,
                    })
                })
                .collect();
            ToolResult {
                ok: true,
                content,
                metadata: Some(serde_json::json!({ "query": query, "hits": hits_meta })),
            }
        }
        Err(error) => err(error),
    }
}

fn run_memory_read(
    ws: &Workspace,
    input: &serde_json::Value,
    _run_id: &str,
    _runs_dir: Option<&Path>,
) -> ToolResult {
    let id = input
        .get("memoryId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if id.is_empty() {
        return err("memory_read requires memoryId.".to_string());
    }
    let include_inactive = input
        .get("includeInactive")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    match crate::memory::read_workspace_memory_entry(ws, id) {
        Ok((entry, markdown)) => {
            // ReadProjectMemory reads *reviewed* entries. Historical evidence
            // (proposed/superseded/stale) is an explicit opt-in and arrives
            // clearly marked, never as current guidance.
            let state = entry.review_state;
            if state != crate::memory::MemoryReviewState::Reviewed {
                if !include_inactive {
                    return err(format!(
                        "Project Memory `{}` is {} and excluded from normal recall. \
Call memory_read again with includeInactive: true to view it as historical evidence.",
                        entry.id,
                        state.as_str()
                    ));
                }
                return ToolResult {
                    ok: true,
                    content: format!(
                        "[historical evidence — reviewState: {}. Do not treat this as current guidance.]\n\n{markdown}",
                        state.as_str()
                    ),
                    metadata: Some(serde_json::json!({ "entry": memory_entry_metadata(&entry) })),
                };
            }
            ToolResult {
                ok: true,
                content: markdown,
                metadata: Some(serde_json::json!({ "entry": memory_entry_metadata(&entry) })),
            }
        }
        Err(error) => err(error),
    }
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
            schema: schema("inspect_spreadsheet", "Read and recalculate an Excel workbook. Returns cells, formulas, results, errors and a hash required for updates. No file changes.",
                serde_json::json!({"path":{"type":"string"},"sheet":{"type":"string","description":"Optional sheet name to inspect."},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":500}}), &["path"]),
            run_read: Some(spreadsheets::inspect), run_write_preview: None, summary: path_summary,
        },
        ToolEntry {
            kind: ToolKind::Write,
            schema: schema("write_spreadsheet", "Create or update a real .xlsx file with built-in calculation and export. No shell, Excel installation or manual export needed. Omit expected_hash to create; for updates supply the hash from inspect_spreadsheet. Updates patch named sheets/cells and preserve other cells. Formula errors block saving. Imported complex Excel features may not survive: use a new output path and source_path to save a copy.",
                serde_json::json!({
                    "path":{"type":"string","description":"Workspace-relative .xlsx output path."},
                    "source_path":{"type":"string","description":"Optional existing .xlsx to copy and update. Output path must be new."},
                    "expected_hash":{"type":"string","description":"Hash returned by inspect_spreadsheet; required to overwrite an existing workbook."},
                    "sheets":{"type":"array","minItems":1,"maxItems":50,"items":{"type":"object","properties":{
                        "name":{"type":"string"},
                        "widths":{"type":"array","items":{"type":"number"}},
                        "cells":{"type":"object","additionalProperties":{"type":"object","properties":{
                            "value":{"type":["string","number","boolean","null"],"description":"Strings beginning = are formulas. Other strings remain text; null clears a cell."},
                            "format":{"type":"string"},"bold":{"type":"boolean"},"color":{"type":"string"},"fill":{"type":"string"}
                        },"required":["value"],"additionalProperties":false}}
                    },"required":["name","cells"],"additionalProperties":false}}
                }), &["path","sheets"]),
            run_read: None, run_write_preview: Some(spreadsheets::preview), summary: path_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("read_file", "Read the full text contents of a file in the workspace.",
                serde_json::json!({ "path": { "type": "string", "description": "Workspace-relative file path." } }),
                &["path"]),
            run_read: Some(|ws, input, _run_id, _runs_dir| read_file(ws, &trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string()))),
            run_write_preview: None,
            summary: path_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("list_dir", "List entries in a workspace directory.",
                serde_json::json!({ "path": { "type": "string", "description": "Workspace-relative directory path. Use . for the root." } }),
                &["path"]),
            run_read: Some(|ws, input, _run_id, _runs_dir| list_dir(ws, &trimmed_arg(input, "path").unwrap_or_else(|| ".".to_string()))),
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
            run_read: Some(|ws, input, _run_id, _runs_dir| glob(ws, input)),
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
            run_read: Some(|ws, input, _run_id, _runs_dir| grep(ws, input)),
            run_write_preview: None,
            summary: pattern_summary,
        },
        ToolEntry {
            kind: ToolKind::ConversationHistory,
            schema: schema("search_conversations", "Search user and assistant messages from prior Klide Harness conversations in the current workspace. Use this when the user refers to an earlier discussion, decision, or request. Returns one concise match per conversation and excludes the current conversation.",
                serde_json::json!({
                    "query": { "type": "string", "description": "Words or phrase to find in previous conversations." },
                    "maxResults": { "type": "integer", "minimum": 1, "maximum": 20, "description": "Optional result cap (default 8, maximum 20)." }
                }),
                &["query"]),
            run_read: Some(run_conversation_search),
            run_write_preview: None,
            summary: query_summary,
        },
        ToolEntry {
            kind: ToolKind::ProjectMemory,
            schema: schema("memory_search", "Search reviewed Project Memory in the current workspace. Use this when a task may depend on a prior decision, convention, failure, handoff, or successful pattern. Results include stable memory ids, matched fields, excerpts, and provenance counts.",
                serde_json::json!({
                    "query": { "type": "string", "description": "Words, file paths, run ids, or concepts to find. Every query term must match the same memory entry." },
                    "kinds": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["run", "handoff", "decision", "convention", "fact", "failure", "pattern"] },
                        "description": "Optional memory-kind filter."
                    },
                    "maxResults": { "type": "integer", "minimum": 1, "maximum": 20, "description": "Optional result cap (default 5, maximum 20)." },
                    "includeInactive": { "type": "boolean", "description": "Include superseded or stale evidence. Defaults to false." }
                }),
                &["query"]),
            run_read: Some(run_memory_search),
            run_write_preview: None,
            summary: query_summary,
        },
        ToolEntry {
            kind: ToolKind::ProjectMemory,
            schema: schema("memory_read", "Read one Project Memory entry by the stable id returned from memory_search. Returns the authoritative Markdown plus structured provenance metadata. Reads reviewed entries; superseded/stale evidence requires includeInactive.",
                serde_json::json!({
                    "memoryId": { "type": "string", "description": "Stable Project Memory id from memory_search." },
                    "includeInactive": { "type": "boolean", "description": "Read a superseded or stale entry as clearly-marked historical evidence. Defaults to false." }
                }),
                &["memoryId"]),
            run_read: Some(run_memory_read),
            run_write_preview: None,
            summary: |call| call.input.get("memoryId").and_then(|value| value.as_str())
                .map(|id| format!("memory_read {id}"))
                .unwrap_or_else(|| "memory_read".to_string()),
        },
        ToolEntry {
            // Reads this run's own retained tool outputs — app-owned run data,
            // never workspace files, so it shares the conversation-history
            // capability rather than claiming a workspace read.
            kind: ToolKind::ConversationHistory,
            schema: schema("peek_value", "Read part of a large retained tool output from earlier in this conversation. When a tool result is too large to keep in context it is replaced by a [retained #id] stub; this tool reads the full stored output. Give start_line/end_line for a slice (up to 400 lines), or query to search all lines for a substring.",
                serde_json::json!({
                    "id": { "type": "string", "description": "The retained output id from a [retained #id] stub." },
                    "start_line": { "type": "integer", "minimum": 1, "description": "First line to read, 1-based (default 1)." },
                    "end_line": { "type": "integer", "minimum": 1, "description": "Last line to read, inclusive (default start_line + 199, capped at 400 lines per call)." },
                    "query": { "type": "string", "description": "Case-insensitive substring to search for instead of reading a range. Returns matching lines with their line numbers." }
                }),
                &["id"]),
            run_read: Some(|_ws, input, run_id, runs_dir| {
                match super::retained::peek(runs_dir, run_id, input) {
                    Ok(content) => ok(content),
                    Err(error) => err(error),
                }
            }),
            run_write_preview: None,
            summary: peek_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("get_git_status", "Return git branch and changed files for the workspace.",
                serde_json::json!({}), &[]),
            run_read: Some(|ws, _input, _run_id, _runs_dir| get_git_status(ws.root())),
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
            run_read: Some(|ws, input, _run_id, _runs_dir| get_git_diff(ws.root(), input)),
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
            run_read: Some(|ws, input, _run_id, _runs_dir| get_git_log(ws.root(), input)),
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
            run_read: Some(|_ws, input, _run_id, _runs_dir| {
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
            kind: ToolKind::Network,
            schema: schema("web_search", "Search the web for documentation or current information. Returns up to 10 results with title, URL, and snippet.",
                serde_json::json!({
                    "query": { "type": "string", "description": "The search query." }
                }),
                &["query"]),
            run_read: Some(|_ws, input, _run_id, _runs_dir| web_search(input)),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::Network,
            schema: schema("web_fetch", "Fetch the content of a URL and return it as text. Use for reading documentation, blog posts, or API references.",
                serde_json::json!({
                    "url": { "type": "string", "description": "The URL to fetch." }
                }),
                &["url"]),
            run_read: Some(|_ws, input, _run_id, _runs_dir| web_fetch(input)),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::ReadOnly,
            schema: schema("get_todo_list", "Read the current TODO list. Each item has an id (e.g. T1, T2) and a done/pending status. Returns empty if no todos exist.",
                serde_json::json!({}), &[]),
            run_read: Some(|ws, _input, run_id, _runs_dir| {
                let root = ws.root().to_string_lossy();
                match todo::list_todos_text(&root, run_id) {
                    Some(text) => ok(format!("TODO list:\n{text}")),
                    None => ok("No todos yet. Use update_todo_list to add one.".to_string()),
                }
            }),
            run_write_preview: None,
            summary: default_summary,
        },
        ToolEntry {
            kind: ToolKind::PlanState,
            schema: schema("update_todo_list", "Add, complete, uncomplete, edit, remove, or clear todos. This directly modifies the project's task list for multi-session continuity. Returns the updated list. IMPORTANT: before laying out a brand-new plan, call action 'clear' once to remove the previous plan's leftover items, then 'add' the new steps.",
                serde_json::json!({
                    "action": {
                        "type": "string",
                        "enum": ["add", "complete", "uncomplete", "edit", "remove", "clear_done", "clear"],
                        "description": "add=create new, complete=mark done, uncomplete=mark pending, edit=change text, remove=delete by id, clear_done=remove all completed, clear=remove ALL todos to start a fresh plan."
                    },
                    "id": { "type": "string", "description": "Item id (e.g. T1). Required for complete/uncomplete/edit/remove." },
                    "text": { "type": "string", "description": "Task text. Required for add and edit." }
                }),
                &["action"]),
            run_read: Some(|ws, input, run_id, _runs_dir| {
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
                        todo::add_todo(root, run_id, text)
                    }
                    "complete" | "uncomplete" => {
                        let id = match input.get("id").and_then(|v| v.as_str()) {
                            Some(i) => i,
                            None => return err("{action} action requires an id.".to_string()),
                        };
                        todo::set_todo_done(root, run_id, id, action == "complete")
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
                        todo::update_text(root, run_id, id, text)
                    }
                    "remove" => {
                        let id = match input.get("id").and_then(|v| v.as_str()) {
                            Some(i) => i,
                            None => return err("remove action requires an id.".to_string()),
                        };
                        todo::remove_todo(root, run_id, id)
                    }
                    "clear_done" => todo::clear_done(root, run_id),
                    "clear" => todo::clear_all(root, run_id),
                    _ => return err(format!("Unknown action: {action}")),
                };
                match result {
                    Ok(msg) => {
                        let list = todo::list_todos_text(root, run_id)
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
            kind: ToolKind::Coordination,
            schema: schema(
                "agent_list",
                "List the coordinated Runs this Run is authorized to contact: itself, direct parent/children, and peers in the same Mission. Returns durable state and labels; unrelated Runs are never exposed.",
                serde_json::json!({}),
                &[],
            ),
            run_read: None,
            run_write_preview: None,
            summary: |_| "inspect agent network".to_string(),
        },
        ToolEntry {
            kind: ToolKind::Coordination,
            schema: schema(
                "agent_send",
                "Send a durable instruction, question, answer, progress update, or handoff to an authorized Run. Set waitForReply for an atomic ask-and-wait; delivery happens only at the recipient's safe turn boundary.",
                serde_json::json!({
                    "toRunId": { "type": "string", "description": "Exact target Run id returned by agent_list." },
                    "body": { "type": "string", "description": "The semantic message to deliver." },
                    "kind": { "type": "string", "enum": ["instruction", "question", "answer", "progress", "handoff"], "description": "Message kind. Defaults to instruction." },
                    "replyTo": { "type": "string", "description": "Envelope id being answered, when this is a reply." },
                    "correlationId": { "type": "string", "description": "Optional stable id grouping a multi-message exchange." },
                    "idempotencyKey": { "type": "string", "description": "Optional retry key. Reusing it with different intent is rejected." },
                    "waitForReply": { "type": "boolean", "description": "When true, wait for a reply to this exact envelope before returning." },
                    "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 120, "description": "Wait timeout when waitForReply is true. Defaults to 30 seconds." }
                }),
                &["toRunId", "body"],
            ),
            run_read: None,
            run_write_preview: None,
            summary: |call| call.input.get("toRunId").and_then(|v| v.as_str())
                .map(|id| format!("message → @{id}"))
                .unwrap_or_else(|| "message agent".to_string()),
        },
        ToolEntry {
            kind: ToolKind::Coordination,
            schema: schema(
                "agent_wait",
                "Wait for a durable coordination message addressed to this Run. Optionally narrow to one sender or one envelope reply. The Run remains cancellable while waiting.",
                serde_json::json!({
                    "fromRunId": { "type": "string", "description": "Optional sender Run id to wait for." },
                    "replyTo": { "type": "string", "description": "Optional envelope id whose reply should unblock the wait." },
                    "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 120, "description": "Maximum wait. Defaults to 30 seconds." }
                }),
                &[],
            ),
            run_read: None,
            run_write_preview: None,
            summary: |call| call.input.get("fromRunId").and_then(|v| v.as_str())
                .map(|id| format!("wait for @{id}"))
                .unwrap_or_else(|| "wait for agent message".to_string()),
        },
        ToolEntry {
            kind: ToolKind::Coordination,
            schema: schema(
                "agent_cancel",
                "Request cancellation of this Run or one of its direct children. The durable request is recorded before the live cancellation token is triggered.",
                serde_json::json!({
                    "runId": { "type": "string", "description": "Target Run id." },
                    "reason": { "type": "string", "description": "Optional concise cancellation reason." }
                }),
                &["runId"],
            ),
            run_read: None,
            run_write_preview: None,
            summary: |call| call.input.get("runId").and_then(|v| v.as_str())
                .map(|id| format!("cancel @{id}"))
                .unwrap_or_else(|| "cancel agent".to_string()),
        },
        ToolEntry {
            kind: ToolKind::Coordination,
            schema: schema(
                "agent_read_result",
                "Read the structured result published by an authorized Run. Returns a calm not-ready response while the Run is still working.",
                serde_json::json!({
                    "runId": { "type": "string", "description": "Target Run id returned by agent_list." }
                }),
                &["runId"],
            ),
            run_read: None,
            run_write_preview: None,
            summary: |call| call.input.get("runId").and_then(|v| v.as_str())
                .map(|id| format!("result ← @{id}"))
                .unwrap_or_else(|| "read agent result".to_string()),
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
        // `run_command` does not execute here — the loop dispatches on
        // `kind == ToolKind::Command`, emits a permission request, and only
        // runs the command (via `run_command_capture`) once the user approves.
        ToolEntry {
            kind: ToolKind::Command,
            schema: schema("run_command", "Run a shell command in the workspace and return its stdout, stderr, and exit code. Use this to run tests, build, typecheck, lint, install dependencies, or any CLI step — it is how you verify your own work. Every command is shown to the user for approval before it runs. Commands run from the workspace root; keep them non-interactive (no prompts/pagers).",
                serde_json::json!({
                    "command": { "type": "string", "description": "The shell command to run, e.g. 'npm test' or 'cargo check'." }
                }),
                &["command"]),
            run_read: None,
            run_write_preview: None,
            summary: |call| call.input.get("command").and_then(|v| v.as_str())
                .map(|c| format!("$ {c}")).unwrap_or_else(|| "run_command".to_string()),
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
        // `spawn_subagent` does not execute in Rust like a read/write tool: the
        // loop dispatches it to `process_subagent_tool`, which resolves the role
        // from `agent::subagents` and drives a nested child Run to completion
        // through the supervisor seam. It stays `Pause`-kinded so that
        // `interactive_tool_names()` keeps excluding it from runs with nothing
        // attached to host a child — headless Mission dispatch, and the children
        // themselves, which is also what bounds subagent recursion.
        ToolEntry {
            kind: ToolKind::Pause,
            schema: schema("spawn_subagent", "Delegate a focused, read-only investigation to a named subagent and get its report back as the tool result. Use this to parallelise discovery without spending your own context — e.g. have the explorer map a subsystem or the reviewer critique a file. The subagent cannot edit; it returns findings only.",
                serde_json::json!({
                    "subagent": { "type": "string", "enum": crate::agent::subagents::model_selectable_ids(), "description": "Which subagent to delegate to: 'explorer' locates and maps code; 'reviewer' critiques code for bugs and clarity." },
                    "task": { "type": "string", "description": "The focused task for the subagent, with enough context for it to act standalone." }
                }),
                &["subagent", "task"]),
            run_read: None,
            run_write_preview: None,
            summary: |call| call.input.get("subagent").and_then(|v| v.as_str())
                .map(|s| format!("delegate → @{s}")).unwrap_or_else(|| "spawn_subagent".to_string()),
        },
        // `consult_advisor` is a Pause tool, like spawn_subagent: it does not
        // execute in Rust. The loop dispatches it to `process_advisor_tool`,
        // which emits AdvisorRequested and parks on the shared question oneshot.
        // The frontend puts the question to a stronger advisor model (or a
        // Claude Code session) and resolves with the advice as the tool result.
        // This is the "advisor strategy": a cheap executor drives the task and
        // escalates a hard decision to a bigger model only when it needs to.
        ToolEntry {
            kind: ToolKind::Pause,
            schema: schema("consult_advisor", "Consult a stronger advisor model for guidance on a hard decision, WITHOUT handing off the whole task. Use SPARINGLY, at genuine forks: before committing to an approach you're unsure of, when the same error keeps recurring, or before declaring the task done. The advisor sees only what you write here, so make the question self-contained. It returns advice (a plan, a correction, or a stop signal) — you stay in control and apply it yourself.",
                serde_json::json!({
                    "question": { "type": "string", "description": "The specific decision or blocker to get advice on. Be concrete and self-contained." },
                    "context": { "type": "string", "description": "Optional: what you've already tried or observed, relevant file paths, and the constraints — so the advisor can answer without re-deriving everything." }
                }),
                &["question"]),
            run_read: None,
            run_write_preview: None,
            summary: |call| call.input.get("question").and_then(|v| v.as_str())
                .map(|q| {
                    let q = q.trim();
                    let short: String = q.chars().take(60).collect();
                    format!("consult advisor: {}{}", short, if q.chars().count() > 60 { "…" } else { "" })
                })
                .unwrap_or_else(|| "consult_advisor".to_string()),
        },
    ]
}

pub fn list_tools(mode: &AgentMode, disabled: &[String]) -> Vec<serde_json::Value> {
    list_tools_for_workspace(mode, disabled, None)
}

pub fn list_tools_for_workspace(
    mode: &AgentMode,
    disabled: &[String],
    workspace_root: Option<&str>,
) -> Vec<serde_json::Value> {
    let reg = registry();
    let mut tools: Vec<serde_json::Value> = reg
        .iter()
        .filter(|e| {
            let name = e.schema["function"]["name"].as_str().unwrap_or("");
            let kind_ok = tool_allowed_in_mode(mode, e.kind)
                // consult_advisor is a side-effect-free Pause tool — escalating
                // a hard decision to a stronger model is as useful while
                // planning as while executing. Offer it in Plan too, even
                // though other Pause tools stay Goal-only.
                || (matches!(mode, AgentMode::Plan) && name == ADVISOR_TOOL);
            if !kind_ok {
                return false;
            }
            !disabled.iter().any(|d| d == name)
        })
        .map(|e| e.schema.clone())
        .collect();
    // Dynamic tools are shell-backed command tools. They are Goal-only and go
    // through the same permission gate as run_command; Plan stays read-only.
    if mode == &AgentMode::Goal {
        tools.extend(
            load_dynamic_tools(workspace_root)
                .into_iter()
                .filter(|schema| {
                    let name = schema["function"]["name"].as_str().unwrap_or("");
                    !disabled.iter().any(|d| d == name) && find_builtin_tool_kind(name).is_none()
                }),
        );
    }
    tools
}

pub fn schemas_for_mode(
    mode: &AgentMode,
    disabled: &[String],
    workspace_root: Option<&str>,
) -> Option<Vec<serde_json::Value>> {
    let tools = list_tools_for_workspace(mode, disabled, workspace_root);
    if tools.is_empty() {
        None
    } else {
        Some(tools)
    }
}

fn find_builtin_tool_kind(name: &str) -> Option<ToolKind> {
    registry()
        .into_iter()
        .find(|e| schema_has_name(&e.schema, name))
        .map(|e| e.kind)
}

/// Look up a tool by name and return its kind. The registry is the only
/// module that names a tool; callers (the run loop, the parallel pre-execute
/// filter) dispatch on this kind, not on a string match. Workspace-aware:
/// dynamic (workspace-defined) tools resolve to `Command` so they pass through
/// the same permission gate as `run_command`.
pub fn find_tool_kind_for_workspace(name: &str, workspace_root: Option<&str>) -> Option<ToolKind> {
    find_builtin_tool_kind(name)
        .or_else(|| find_dynamic_tool_def(name, workspace_root).map(|_| ToolKind::Command))
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

pub fn tool_summary_for_workspace(
    call: &NormalizedToolCall,
    workspace_root: Option<&str>,
) -> String {
    tool_summary(call).or_else_dynamic(call, workspace_root)
}

trait DynamicSummary {
    fn or_else_dynamic(self, call: &NormalizedToolCall, workspace_root: Option<&str>) -> String;
}

impl DynamicSummary for String {
    fn or_else_dynamic(self, call: &NormalizedToolCall, workspace_root: Option<&str>) -> String {
        if self != call.name {
            return self;
        }
        match dynamic_tool_command(&call.name, &call.input, workspace_root.unwrap_or("")) {
            Some(Ok(invocation)) => invocation.summary,
            _ => self,
        }
    }
}

fn schema_has_name(schema: &serde_json::Value, name: &str) -> bool {
    schema
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        == Some(name)
}

/// Whether a resolved tool list (from [`schemas_for_mode`]) offers a tool by
/// name. The run loop gates retention on `peek_value` being callable — a
/// stub that tells the model to call a tool this run doesn't have would be
/// a dead end.
pub fn tools_include(tools: &Option<Vec<serde_json::Value>>, name: &str) -> bool {
    tools
        .as_deref()
        .is_some_and(|list| list.iter().any(|schema| schema_has_name(schema, name)))
}

pub fn execute_read_only_tool(root: &str, call: &NormalizedToolCall, run_id: &str) -> ToolResult {
    execute_non_mutating_tool(root, call, run_id, None)
}

/// Production read dispatch with access to Klide's app-owned Run store.
/// Workspace tools ignore `runs_dir`; conversation-history tools require it.
pub fn execute_read_only_tool_with_runs_dir(
    root: &str,
    call: &NormalizedToolCall,
    run_id: &str,
    runs_dir: &Path,
) -> ToolResult {
    execute_non_mutating_tool(root, call, run_id, Some(runs_dir))
}

fn execute_non_mutating_tool(
    root: &str,
    call: &NormalizedToolCall,
    run_id: &str,
    runs_dir: Option<&Path>,
) -> ToolResult {
    let ws = match Workspace::new(root) {
        Ok(ws) => ws,
        Err(e) => return err(e),
    };
    let entry = registry()
        .into_iter()
        .find(|e| schema_has_name(&e.schema, &call.name));
    let result = match entry.and_then(|e| e.run_read) {
        Some(f) => f(&ws, &call.input, run_id, runs_dir),
        None if find_dynamic_tool_def(&call.name, Some(root)).is_some() => err(format!(
            "Dynamic tool '{}' is a command-capability tool. It is available only through the Goal-mode permission gate, not read-only dispatch.",
            call.name
        )),
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

#[derive(Clone, Debug, serde::Deserialize)]
struct DynamicToolDef {
    name: String,
    description: String,
    command: String,
    #[serde(default = "default_timeout", alias = "timeout_secs")]
    timeout_secs: u64,
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

fn dynamic_tool_defs(workspace_root: Option<&str>) -> Vec<DynamicToolDef> {
    let mut defs = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();

    let global_path = Path::new(&home).join(".agents/tools.json");
    defs.extend(load_tools_from(&global_path));

    if let Some(root) = workspace_root {
        let workspace_path = Path::new(root).join(".agents/tools.json");
        defs.extend(load_tools_from(&workspace_path));
    }

    defs
}

fn find_dynamic_tool_def(name: &str, workspace_root: Option<&str>) -> Option<DynamicToolDef> {
    if find_builtin_tool_kind(name).is_some() {
        return None;
    }
    dynamic_tool_defs(workspace_root)
        .into_iter()
        .find(|d| d.name == name)
}

pub fn load_dynamic_tools(workspace_root: Option<&str>) -> Vec<serde_json::Value> {
    dynamic_tool_defs(workspace_root)
        .into_iter()
        .filter(|def| find_builtin_tool_kind(&def.name).is_none())
        .map(|def| dynamic_tool_schema(&def))
        .collect()
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandInvocation {
    pub tool_name: String,
    pub command: String,
    pub cwd: String,
    pub timeout_secs: u64,
    pub summary: String,
    pub reason: String,
}

/// Resolve a command-capability call into the concrete invocation the
/// permission gate shows the user. The registry owns which name is which:
/// the builtin `run_command` reads its `command` input and runs at the
/// workspace root; every other command-capability name is a dynamic tool
/// whose command comes from its `.agents/tools.json` template.
pub fn command_invocation(
    call: &NormalizedToolCall,
    workspace_root: &str,
    default_timeout_secs: u64,
) -> Result<CommandInvocation, ToolResult> {
    if call.name == RUN_COMMAND_TOOL {
        let command = call
            .input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if command.is_empty() {
            return Err(err("run_command requires a non-empty command.".to_string()));
        }
        return Ok(CommandInvocation {
            tool_name: RUN_COMMAND_TOOL.to_string(),
            summary: format!("$ {command}"),
            reason: "The agent wants to run a shell command in the workspace.".to_string(),
            command,
            cwd: workspace_root.to_string(),
            // Clamped so a bad setting can't disable the runaway guard.
            timeout_secs: default_timeout_secs.clamp(1, 1800),
        });
    }
    match dynamic_tool_command(&call.name, &call.input, workspace_root) {
        Some(result) => result,
        None => Err(err(format!(
            "Unknown command-capability tool: {}",
            call.name
        ))),
    }
}

pub fn dynamic_tool_command(
    name: &str,
    input: &serde_json::Value,
    workspace_root: &str,
) -> Option<Result<CommandInvocation, ToolResult>> {
    let def = find_dynamic_tool_def(name, Some(workspace_root))?;
    let ws = match Workspace::new(workspace_root) {
        Ok(ws) => ws,
        Err(e) => return Some(Err(err(format!("Cannot run dynamic tool {name}: {e}")))),
    };
    let cwd = match resolve_dynamic_tool_cwd(&ws, &def.cwd) {
        Ok(cwd) => cwd,
        Err(e) => return Some(Err(err(e))),
    };
    let args_str = string_arg(input, "args").unwrap_or_default();
    let full_command = if args_str.is_empty() {
        def.command.clone()
    } else {
        format!("{} {}", def.command, args_str)
    };
    let timeout_secs = def.timeout_secs.clamp(1, 1800);

    Some(Ok(CommandInvocation {
        tool_name: def.name.clone(),
        summary: format!("{}: $ {}", def.name, full_command),
        reason: format!(
            "The dynamic tool '{}' wants to run a shell command in the workspace.",
            def.name
        ),
        command: full_command,
        cwd,
        timeout_secs,
    }))
}

fn resolve_dynamic_tool_cwd(ws: &Workspace, cwd: &str) -> Result<String, String> {
    let trimmed = cwd.trim();
    let path = if trimmed.is_empty() || trimmed == "workspace" || trimmed == "." {
        ws.root().to_path_buf()
    } else {
        ws.resolve_existing(trimmed)?
    };
    if !path.is_dir() {
        return Err(format!(
            "Dynamic tool cwd must resolve to a workspace directory: {}",
            ws.display(&path)
        ));
    }
    Ok(path.to_string_lossy().to_string())
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
    if calls.is_empty() {
        let (applied, applied_cleaned) = recover_applied_tool_call_text(content);
        if !applied.is_empty() {
            return (applied, applied_cleaned);
        }
        return recover_json_action_calls(content);
    }
    (calls, cleaned.trim().to_string())
}

/// Last-resort recovery for the bare JSON "action" shape some small models
/// (notably LFM2.5) fall into when they drop out of native tool-calling:
///
/// ```json
/// { "action": "read_file", "path": "./README.md" }
/// ```
///
/// The tool is named by an `action` / `tool` / `tool_name` key (or a `name`
/// key paired with `arguments`), and the arguments are either an explicit
/// `action_input` / `arguments` / `parameters` / `input` object or the object's
/// remaining sibling keys. Scans the content for balanced top-level `{…}`
/// objects, converts every action-shaped one to a call, and returns the content
/// with those objects stripped. Anything that isn't an action object (ordinary
/// prose, JSON the model wrote as an answer) is left untouched.
fn recover_json_action_calls(content: &str) -> (Vec<NormalizedToolCall>, String) {
    let bytes = content.as_bytes();
    let mut calls = Vec::new();
    let mut cleaned = String::new();
    let mut last_kept = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = balanced_object_end(content, i) {
                if let Some((name, input)) = json_action_call(&content[i..end]) {
                    cleaned.push_str(&content[last_kept..i]);
                    calls.push(NormalizedToolCall {
                        id: format!("tool_{}", calls.len()),
                        name,
                        input,
                    });
                    last_kept = end;
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }
    if calls.is_empty() {
        return (Vec::new(), content.to_string());
    }
    cleaned.push_str(&content[last_kept..]);
    (calls, cleaned.trim().to_string())
}

/// Byte offset just past the `}` that closes the object opened at `start`,
/// respecting strings and escapes. `None` if the braces never balance.
fn balanced_object_end(s: &str, start: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for i in start..bytes.len() {
        let c = bytes[i];
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Parse one balanced JSON object as an action-shaped tool call, or `None` if
/// it doesn't carry a tool name.
fn json_action_call(slice: &str) -> Option<(String, serde_json::Value)> {
    const NAME_KEYS: [&str; 3] = ["action", "tool", "tool_name"];
    const ARG_KEYS: [&str; 4] = ["action_input", "arguments", "parameters", "input"];
    let value: serde_json::Value = serde_json::from_str(slice).ok()?;
    let obj = value.as_object()?;
    let (name_key, name) = NAME_KEYS
        .iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()).map(|s| (*k, s)))
        .or_else(|| {
            // Structured {"name":…,"arguments":…} emitted without the special
            // tokens — only treat `name` as the tool when args accompany it,
            // so plain prose objects with a "name" field aren't hijacked.
            (obj.contains_key("arguments") || obj.contains_key("parameters"))
                .then(|| {
                    obj.get("name")
                        .and_then(|v| v.as_str())
                        .map(|s| ("name", s))
                })
                .flatten()
        })?;
    if name.is_empty() {
        return None;
    }
    let input = ARG_KEYS
        .iter()
        .find_map(|k| obj.get(*k))
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| {
            let mut m = serde_json::Map::new();
            for (k, v) in obj {
                if k == name_key || ARG_KEYS.contains(&k.as_str()) {
                    continue;
                }
                m.insert(k.clone(), v.clone());
            }
            serde_json::Value::Object(m)
        });
    Some((name.to_string(), input))
}

fn recover_applied_tool_call_text(content: &str) -> (Vec<NormalizedToolCall>, String) {
    let mut cleaned = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        let Some(after) = trimmed.strip_prefix("Applied:") else {
            cleaned.push(line);
            continue;
        };
        let parsed = parse_pythonic_calls(after.trim());
        if parsed.is_empty() {
            cleaned.push(line);
            continue;
        }
        let calls = parsed
            .into_iter()
            .enumerate()
            .map(|(idx, (name, input))| NormalizedToolCall {
                id: format!("tool_{idx}"),
                name,
                input,
            })
            .collect();
        return (calls, cleaned.join("\n").trim().to_string());
    }
    (Vec::new(), content.to_string())
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

/// Cut the middle out of an oversized tool result, keeping both ends.
///
/// A head-only cut removes exactly the lines the command was run for: a test
/// run states its verdict in the last few lines, a build in its last error, a
/// script in its exit status. The model then has to re-run the command to see
/// how it ended — a wasted turn on output we already had. Keeping both ends
/// costs nothing and gives up the middle, which is the part a caller is least
/// likely to have run the command for.
///
/// The elision marker is charged to `max_bytes` rather than appended after it,
/// so the result never exceeds the budget the caller set. Cuts snap to a line
/// boundary when one is close, so neither end starts or stops mid-line.
fn truncate_middle(body: &str, max_bytes: usize) -> String {
    if body.len() <= max_bytes {
        return body.to_string();
    }
    // Upper bound on the marker: the elided count can never exceed the whole
    // body, and its digit count grows monotonically, so formatting with
    // `body.len()` reserves at least as many bytes as the real marker needs.
    let marker_reserve = format!("\n…({} bytes elided)…\n", body.len()).len();
    let Some(keep) = max_bytes.checked_sub(marker_reserve).filter(|k| *k > 0) else {
        // Budget too small to say anything about what was dropped. Fall back to
        // a plain head cut rather than return a string that is all marker.
        let mut cut = max_bytes.min(body.len());
        while cut > 0 && !body.is_char_boundary(cut) {
            cut -= 1;
        }
        return body[..cut].to_string();
    };

    let head_budget = keep / 2;
    let tail_budget = keep - head_budget;

    // How far a cut may travel to land on a newline. Bounded so a single very
    // long line (minified JS, a one-line JSON body) can't collapse either end.
    const SNAP: usize = 200;

    let mut head_end = head_budget;
    while head_end > 0 && !body.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut snap_from = head_end.saturating_sub(SNAP);
    while snap_from < head_end && !body.is_char_boundary(snap_from) {
        snap_from += 1;
    }
    if let Some(nl) = body[snap_from..head_end].rfind('\n') {
        head_end = snap_from + nl;
    }

    let mut tail_start = body.len() - tail_budget;
    while tail_start < body.len() && !body.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    let mut snap_to = (tail_start + SNAP).min(body.len());
    while snap_to > tail_start && !body.is_char_boundary(snap_to) {
        snap_to -= 1;
    }
    if let Some(nl) = body[tail_start..snap_to].find('\n') {
        tail_start += nl + 1;
    }

    // Snapping only ever shrinks the kept ends, so the total stays under budget.
    let elided = tail_start.saturating_sub(head_end);
    format!(
        "{}\n…({elided} bytes elided)…\n{}",
        &body[..head_end],
        &body[tail_start..]
    )
}

/// Run an approved shell command from the workspace root and capture its
/// output. Called by the harness's Command arm only *after* the user approves
/// the permission request — never directly from the tool registry. stdout and
/// stderr are returned together with the exit code; output is truncated so a
/// chatty build can't blow the context window. The result is `ok: true` only on
/// a zero exit so the model can tell success from failure.
///
/// Convenience wrapper that runs in the workspace root. Production paths call
/// `run_command_capture_in` with an explicit cwd (dynamic tools may set one);
/// this root-cwd form is used by the eval harness and tool tests.
#[allow(dead_code)]
pub async fn run_command_capture(root: &str, command: &str, timeout_secs: u64) -> ToolResult {
    run_command_capture_in(root, root, command, timeout_secs).await
}

pub async fn run_command_capture_in(
    root: &str,
    cwd: &str,
    command: &str,
    timeout_secs: u64,
) -> ToolResult {
    const MAX_OUTPUT: usize = 16_000;
    // Go through Workspace so the run dir honors the same root invariant the
    // file tools use (and fails clearly if no workspace is open).
    let ws = match Workspace::new(root) {
        Ok(ws) => ws,
        Err(e) => return err(format!("Cannot run command: {e}")),
    };
    let cwd = match resolve_command_cwd(&ws, cwd) {
        Ok(cwd) => cwd,
        Err(e) => return err(format!("Cannot run command: {e}")),
    };
    // `kill_on_drop(true)` + a timeout around `wait_with_output` means a command
    // that never exits (a dev server, a watch task, an interactive prompt) is
    // killed when the timeout future is dropped — the run can't hang forever.
    let spawned = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let child = match spawned {
        Ok(c) => c,
        Err(e) => return err(format!("Failed to run command: {e}")),
    };
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return err(format!("Failed to run command: {e}")),
        Err(_) => {
            return err(format!(
                "Command timed out after {timeout_secs}s and was stopped. \
                 If it legitimately needs longer, raise the command timeout in \
                 Settings → Harness; otherwise run a faster, non-interactive command."
            ))
        }
    };
    let code = output.status.code();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut body = String::new();
    if !stdout.trim().is_empty() {
        body.push_str(stdout.trim_end());
    }
    if !stderr.trim().is_empty() {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str("stderr:\n");
        body.push_str(stderr.trim_end());
    }
    if body.is_empty() {
        body.push_str("(no output)");
    }
    if body.len() > MAX_OUTPUT {
        body = truncate_middle(&body, MAX_OUTPUT);
    }
    let header = match code {
        Some(0) => "Command succeeded (exit 0).".to_string(),
        Some(c) => format!("Command failed (exit {c})."),
        None => "Command terminated by a signal.".to_string(),
    };
    ToolResult {
        ok: code == Some(0),
        content: format!("{header}\n\n{body}"),
        metadata: None,
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandPreflight {
    pub external_paths: Vec<String>,
}

/// Best-effort scan that surfaces command arguments resolving *outside* the
/// workspace, so the permission prompt can show them. This is transparency, not
/// a sandbox: the command still runs an arbitrary shell. We tokenize, expand
/// `~`, `$HOME`/`$PWD`, resolve relative paths against the command's `cwd`, and
/// flag anything that normalizes outside the (canonical) workspace root.
///
/// We only treat a token as a path when it is absolute, tilde/var-prefixed, or
/// contains a `/` (or is `..`) — a bare word like `test` or `--all` is never a
/// path candidate, which keeps false positives near zero. (OpenCode's upstream
/// uses a tree-sitter bash grammar for this; we trade that fidelity for far
/// fewer moving parts.)
pub fn preflight_command(root: &str, cwd: &str, command: &str) -> CommandPreflight {
    let Ok(ws) = Workspace::new(root) else {
        return CommandPreflight::default();
    };
    let root = normalize_path(ws.root());
    // Relative arguments resolve against the command's working directory.
    let base = resolve_command_cwd(&ws, cwd).unwrap_or_else(|_| ws.root().to_path_buf());
    let home = std::env::var("HOME").ok();

    let tokens = shell_words::split(command).unwrap_or_else(|_| {
        command
            .split_whitespace()
            .map(str::to_string)
            .collect::<Vec<_>>()
    });
    let mut external_paths = Vec::new();
    for token in tokens {
        for candidate in path_candidates(&token, home.as_deref(), &base) {
            let path = normalize_command_path(&candidate);
            if !path.starts_with(&root) {
                let display = path.to_string_lossy().to_string();
                if !external_paths.iter().any(|p| p == &display) {
                    external_paths.push(display);
                }
            }
        }
    }
    CommandPreflight { external_paths }
}

/// Pull candidate paths out of one shell token. Splits on `=` so env
/// assignments (`FOO=/x`) and `--flag=path` forms are both seen; expands `~`
/// and `$HOME`/`$PWD`; joins genuinely-relative paths onto `base`.
fn path_candidates(token: &str, home: Option<&str>, base: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for raw in token.split('=') {
        let trimmed = raw
            .trim_start_matches(['<', '>', '&', '"', '\''])
            .trim_end_matches([',', ';', '"', '\'']);
        if trimmed.is_empty() {
            continue;
        }
        let expanded =
            expand_tilde(trimmed, home).unwrap_or_else(|| expand_vars(trimmed, home, base));
        if expanded.starts_with('/') {
            out.push(PathBuf::from(expanded));
        } else if expanded == ".." || expanded.contains('/') {
            // Relative — only worth resolving when it can actually point
            // outside (a `/` or a bare `..`); resolve against the command cwd.
            out.push(base.join(&expanded));
        }
    }
    out
}

fn expand_tilde(segment: &str, home: Option<&str>) -> Option<String> {
    let home = home?;
    if segment == "~" {
        return Some(home.to_string());
    }
    segment
        .strip_prefix("~/")
        .map(|rest| format!("{}/{}", home.trim_end_matches('/'), rest))
}

fn expand_vars(segment: &str, home: Option<&str>, base: &Path) -> String {
    let mut out = segment.to_string();
    if let Some(home) = home {
        out = out.replace("${HOME}", home).replace("$HOME", home);
    }
    let base = base.to_string_lossy();
    out.replace("${PWD}", &base).replace("$PWD", &base)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn normalize_command_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return normalize_path(&canonical);
    }

    let mut missing = Vec::new();
    let mut cursor = path;
    while !cursor.exists() {
        match cursor.file_name() {
            Some(name) => missing.push(name.to_os_string()),
            None => return normalize_path(path),
        }
        match cursor.parent() {
            Some(parent) => cursor = parent,
            None => return normalize_path(path),
        }
    }

    let mut out = std::fs::canonicalize(cursor)
        .map(|p| normalize_path(&p))
        .unwrap_or_else(|_| normalize_path(cursor));
    for part in missing.iter().rev() {
        out.push(part);
    }
    normalize_path(&out)
}

fn resolve_command_cwd(ws: &Workspace, cwd: &str) -> Result<PathBuf, String> {
    let trimmed = cwd.trim();
    let path = if trimmed.is_empty() || trimmed == "workspace" || trimmed == "." {
        ws.root().to_path_buf()
    } else if Path::new(trimmed).is_absolute() {
        ws.resolve_abs_read(trimmed)?
    } else {
        ws.resolve_existing(trimmed)?
    };
    if !path.is_dir() {
        return Err(format!(
            "command cwd must resolve to a workspace directory: {}",
            ws.display(&path)
        ));
    }
    Ok(path)
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
    match ws.read_text(&full, Access::Agent) {
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
                    rel,
                    line_count,
                    content.len(),
                    numbered
                ),
                // The execution wrapper reads this back to record a read
                // snapshot, so a later write_file can flag a stale edit.
                metadata: Some(serde_json::json!({
                    "snapshotPath": rel,
                    "snapshotHash": hash_content(&content),
                })),
            }
        }
        // read_text's errors are already complete sentences (guard, cap,
        // not-a-file, read failure).
        Err(e) => err(e),
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
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut omitted = 0usize;
    for entry in entries.flatten().take(MAX_LIST_ENTRIES) {
        let name = entry.file_name().to_string_lossy().to_string();
        if ignored_dir(&name) || name.starts_with('.') {
            omitted += 1;
            continue;
        }
        let file_type = entry.file_type().ok();
        let is_dir = file_type.as_ref().is_some_and(|t| t.is_dir());
        if is_dir {
            dirs.push(name);
        } else {
            files.push(name);
        }
    }
    dirs.sort();
    files.sort();
    let mut out = Vec::new();
    out.push(format!("Direct entries in {}:", ws.display(&full)));
    out.push(format!(
        "Folders:\n{}",
        if dirs.is_empty() {
            "(none)".to_string()
        } else {
            dirs.join("\n")
        }
    ));
    out.push(format!(
        "Files:\n{}",
        if files.is_empty() {
            "(none)".to_string()
        } else {
            files.join("\n")
        }
    ));
    if omitted > 0 {
        out.push(format!(
            "Omitted {omitted} hidden/internal entr{}.",
            if omitted == 1 { "y" } else { "ies" }
        ));
    }
    ok(if dirs.is_empty() && files.is_empty() && omitted == 0 {
        format!("Direct entries in {}:\n(empty)", ws.display(&full))
    } else {
        out.join("\n\n")
    })
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
        if is_sensitive_path(root, &path) {
            continue;
        }
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
    if let Err(e) = ws.guard(&start, Access::Agent) {
        return err(e);
    }
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
    if let Err(e) = ws.guard(&start, Access::Agent) {
        return err(e);
    }
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
            .map(|m| m.len() > AGENT_MAX_READ_BYTES)
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
        if p.starts_with(':')
            || Path::new(p).is_absolute()
            || Path::new(p)
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return err("Git diff path must be a plain workspace-relative path.".to_string());
        }
        if is_sensitive_path(root, &root.join(p)) {
            return err(format!(
                "Access to {p} is blocked because it may contain credentials or private keys. \
Open it locally yourself if needed; do not send its contents to a model."
            ));
        }
        args.push("--");
        args.push(p);
    } else {
        args.extend([
            "--",
            ".",
            ":(exclude,glob)**/.env",
            ":(exclude,glob)**/.env.*",
            ":(exclude,glob)**/.npmrc",
            ":(exclude,glob)**/.pypirc",
            ":(exclude,glob)**/.netrc",
            ":(exclude,glob)**/.git-credentials",
            ":(exclude,glob)**/*.pem",
            ":(exclude,glob)**/*.key",
            ":(exclude,glob)**/*.p12",
            ":(exclude,glob)**/*.pfx",
            ":(exclude,glob)**/*.jks",
            ":(exclude,glob)**/.ssh/**",
            ":(exclude,glob)**/.aws/**",
            ":(exclude,glob)**/.gnupg/**",
            ":(exclude,glob)**/.azure/**",
            ":(exclude,glob)**/.kube/**",
            ":(exclude,glob)**/.config/gcloud/**",
        ]);
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

    let resp = match fetch_public_body(&url) {
        Ok(body) => body,
        Err(_) => {
            return err("Web search timed out or failed. Try a more specific query.".to_string())
        }
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
    let requested_url = match trimmed_arg(input, "url") {
        Some(u) => u,
        None => return err("web_fetch requires a url".to_string()),
    };
    let body = match fetch_public_body(&requested_url) {
        Ok(body) => body,
        Err(error) => return err(error),
    };

    let text = strip_html(&body);
    let truncated: String = text.chars().take(6000).collect();
    let note = if text.chars().count() > 6000 {
        "\n\n…(truncated)"
    } else {
        ""
    };
    ok(format!("Content of {requested_url}:\n\n{truncated}{note}"))
}

fn fetch_public_body(requested_url: &str) -> Result<String, String> {
    let (mut current_url, original_host, _) = resolve_public_url(requested_url)?;
    let mut redirect_count = 0usize;
    'redirects: loop {
        let (_, host, addresses) = resolve_public_url(current_url.as_str())?;
        if !host.eq_ignore_ascii_case(&original_host) {
            return Err(
                "Cross-host redirects are blocked. Fetch the destination URL explicitly.".into(),
            );
        }
        let client = reqwest::blocking::Client::builder()
            .user_agent("Klide/1.0")
            .timeout(std::time::Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|error| format!("Unable to prepare web fetch: {error}"))?;
        let response = client
            .get(current_url.clone())
            .send()
            .map_err(|error| format!("Web fetch failed: {error}"))?;
        if response.status().is_redirection() {
            let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
                return Err("Redirect response did not include a destination.".into());
            };
            let location = location
                .to_str()
                .map_err(|_| "Redirect destination was not valid text.".to_string())?;
            current_url = current_url
                .join(location)
                .map_err(|_| "Redirect destination was not a valid URL.".to_string())?;
            redirect_count += 1;
            if redirect_count > MAX_WEB_REDIRECTS {
                return Err("Web fetch exceeded the redirect limit.".into());
            }
            continue 'redirects;
        }
        if !response.status().is_success() {
            return Err(format!("Web fetch returned HTTP {}.", response.status()));
        }
        return read_limited_response(response);
    }
}

fn read_limited_response(response: reqwest::blocking::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_WEB_RESPONSE_BYTES)
    {
        return Err(format!(
            "Web response is too large (max {MAX_WEB_RESPONSE_BYTES} bytes)."
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_WEB_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unable to read web response: {error}"))?;
    if bytes.len() as u64 > MAX_WEB_RESPONSE_BYTES {
        return Err(format!(
            "Web response is too large (max {MAX_WEB_RESPONSE_BYTES} bytes)."
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn resolve_public_url(raw_url: &str) -> Result<(reqwest::Url, String, Vec<SocketAddr>), String> {
    if raw_url.len() > 8_192 {
        return Err("URL is too long.".to_string());
    }
    let mut url = reqwest::Url::parse(raw_url).map_err(|_| "URL is not valid.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("URL must use http:// or https://.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs containing credentials are blocked.".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL must include a host.".to_string())?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    // Pinning below is keyed by this normalized hostname. Rewrite a trailing
    // dot in the URL too, otherwise reqwest could miss the override and perform
    // a second, attacker-raceable DNS lookup for `example.com.`.
    url.set_host(Some(&host))
        .map_err(|_| "URL host is not valid.".to_string())?;
    if host == "localhost" || host.ends_with(".localhost") {
        return Err("Local and private network addresses are blocked.".to_string());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "URL has no usable port.".to_string())?;
    let addresses: Vec<SocketAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| "Unable to resolve the URL host.".to_string())?
        .collect();
    if addresses.is_empty() {
        return Err("Unable to resolve the URL host.".to_string());
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(
            "Local, private, reserved, and link-local network addresses are blocked.".to_string(),
        );
    }
    Ok((url, host, addresses))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => {
            if let Some(ipv4) = ip.to_ipv4() {
                return is_public_ipv4(ipv4);
            }
            let segments = ip.segments();
            !ip.is_unspecified()
                && !ip.is_loopback()
                && !ip.is_multicast()
                && (segments[0] & 0xfe00) != 0xfc00
                && (segments[0] & 0xffc0) != 0xfe80
                && (segments[0] & 0xffc0) != 0xfec0
                && !(segments[0] == 0x0100 && segments[1..].iter().all(|segment| *segment == 0))
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
                && (segments[0] & 0xfff0) != 0x3ff0
        }
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
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

/// Normalize one line for tolerant matching: drop leading `N:` / `N: `
/// line-number gutters, then trim surrounding whitespace so indentation
/// drift doesn't defeat a match. Gutters can stack — peek_value over a
/// retained read_file output numbers lines that already carry the read_file
/// gutter — so stripping loops until no `<digits>:` prefix remains. Both
/// sides of a match normalize through this same function, so a genuine
/// `N:`-looking content line strips identically on each side, and the
/// uniqueness requirement in `locate_edit` still guards placement.
fn normalize_match_line(line: &str) -> &str {
    let mut rest = line.trim();
    loop {
        let bytes = rest.as_bytes();
        let mut i = 0;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i > 0 && i < bytes.len() && bytes[i] == b':' {
            rest = rest[i + 1..].trim_start();
        } else {
            return rest;
        }
    }
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
    // Agent-tier read: an edit to a credential-shaped file is refused here,
    // before a diff is ever proposed — the diff gate is review, not the guard.
    let current = ws.read_text(&full, Access::Agent).map_err(err)?;
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
    if new_content.len() as u64 > AGENT_MAX_WRITE_BYTES {
        return Err(err("Resulting file would be too large".to_string()));
    }
    Ok(DiffProposal {
        binary: None,
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
    ws.guard(&candidate, Access::Agent).map_err(err)?;
    let rel = ws.display(&candidate);
    if candidate.exists() {
        return Err(err(format!(
            "{rel} already exists. Use write_file to modify an existing file."
        )));
    }
    if contents.len() as u64 > AGENT_MAX_WRITE_BYTES {
        return Err(err("Contents too large".to_string()));
    }
    Ok(DiffProposal {
        binary: None,
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
    ws.guard(&full, Access::Agent).map_err(err)?;
    if full.exists() {
        return Err(err(format!(
            "{rel} already exists. Use write_file to edit it."
        )));
    }
    let content =
        format!("---\nname: {title}\ndescription: {description}\n---\n\n{instructions}\n");
    Ok(DiffProposal {
        binary: None,
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
    // Re-validate at apply time: never trust a proposal path blindly. The
    // agent-tier write also re-applies the sensitive-path refusal, so a
    // proposal that skipped preview can't land on a credential file.
    let full = ws.resolve_new(&diff.path).map_err(err)?;
    if let Some(binary) = &diff.binary {
        ws.guard(&full, Access::Agent).map_err(err)?;
        crate::spreadsheet::save(root, &full.to_string_lossy(), &binary.new_base64, binary.old_base64.as_deref()).map_err(err)?;
        return Ok(ok(format!("Saved {}. Excel export complete; formulas recalculated and checked. Use inspect_spreadsheet to verify key results. {}", diff.path, diff.reason.as_deref().unwrap_or(""))));
    }
    ws.write_text(&full, &diff.new_content, Access::Agent)
        .map_err(err)?;
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

    #[test]
    fn list_dir_reports_direct_visible_entries_only() {
        let dir = std::env::temp_dir().join(format!("klide-list-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(dir.join(".cache")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        std::fs::write(dir.join("src").join("nested.rs"), "").unwrap();

        let ws = Workspace::new(dir.to_str().unwrap()).unwrap();
        let out = list_dir(&ws, ".");
        assert!(out.ok);
        assert!(out.content.contains("Direct entries in .:"));
        assert!(
            out.content.contains("Folders:\ndocs\nsrc"),
            "{}",
            out.content
        );
        assert!(out.content.contains("Files:\nREADME.md"), "{}", out.content);
        assert!(out.content.contains("Omitted 4 hidden/internal entries."));
        assert!(!out.content.contains(".git"));
        assert!(!out.content.contains(".cache"));
        assert!(!out.content.contains("node_modules"));
        assert!(!out.content.contains("nested.rs"));
    }

    #[test]
    fn agent_file_tools_block_common_secret_paths() {
        let dir =
            std::env::temp_dir().join(format!("klide-sensitive-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join(".env"), "TOKEN=secret").unwrap();
        std::fs::write(dir.join("src").join("app.rs"), "TOKEN=public_name").unwrap();
        let ws = Workspace::new(dir.to_str().unwrap()).unwrap();

        let read = read_file(&ws, ".env");
        assert!(!read.ok);
        assert!(read.content.contains("blocked"));

        let grep_result = grep(
            &ws,
            &serde_json::json!({ "pattern": "TOKEN=", "path": "." }),
        );
        assert!(grep_result.ok);
        assert!(grep_result.content.contains("src/app.rs"));
        assert!(!grep_result.content.contains("secret"));

        let glob_result = glob(&ws, &serde_json::json!({ "pattern": "**/*" }));
        assert!(glob_result.ok);
        assert!(!glob_result.content.contains(".env"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_write_paths_block_common_secret_paths() {
        let dir =
            std::env::temp_dir().join(format!("klide-sensitive-writes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), "TOKEN=old").unwrap();
        let ws = Workspace::new(dir.to_str().unwrap()).unwrap();

        // Editing an existing credential file is refused at preview.
        let edit = preview_write_file(
            &ws,
            &serde_json::json!({ "path": ".env", "old_str": "TOKEN=old", "new_str": "TOKEN=new" }),
            "run1",
        );
        let refused = edit.expect_err("editing .env must be refused");
        assert!(refused.content.contains("blocked"), "{}", refused.content);

        // Creating a new credential file is refused at preview.
        let create = preview_create_file(
            &ws,
            &serde_json::json!({ "path": ".env.production", "contents": "TOKEN=new" }),
            "run1",
        );
        let refused = create.expect_err("creating .env.production must be refused");
        assert!(refused.content.contains("blocked"), "{}", refused.content);

        // Apply re-checks: a proposal that skipped preview still can't land
        // on a credential file.
        let diff = DiffProposal {
            binary: None,
            id: "diff_run1_env".to_string(),
            run_id: "run1".to_string(),
            tool_call_id: "write_.env".to_string(),
            path: ".env".to_string(),
            old_content: "TOKEN=old".to_string(),
            new_content: "TOKEN=leaked".to_string(),
            old_hash: hash_content("TOKEN=old"),
            new_hash: hash_content("TOKEN=leaked"),
            unified_diff: String::new(),
            is_create: false,
            reason: None,
        };
        let applied = apply_write(dir.to_str().unwrap(), &diff);
        let refused = applied.expect_err("applying a write to .env must be refused");
        assert!(refused.content.contains("blocked"), "{}", refused.content);
        assert_eq!(
            std::fs::read_to_string(dir.join(".env")).unwrap(),
            "TOKEN=old",
            "the credential file must be untouched"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn web_fetch_url_policy_rejects_local_reserved_and_credentials() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "203.0.113.10",
            "[::1]",
            "[fd00::1]",
            "[fec0::1]",
            "[3fff::1]",
        ] {
            assert!(
                resolve_public_url(&format!("http://{ip}/")).is_err(),
                "{ip} must be blocked"
            );
        }
        assert!(resolve_public_url("file:///etc/passwd").is_err());
        assert!(resolve_public_url("http://user:password@1.1.1.1/").is_err());
        assert!(resolve_public_url("https://1.1.1.1/").is_ok());
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
    fn recovers_applied_tool_call_text_and_drops_fake_result() {
        let content = "Let me check that.\nApplied: list_dir(path=\"public\")\n\nThe files are:\nfavicon.ico\nList_dir tool result: made up";
        let (calls, cleaned) = recover_text_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "list_dir");
        assert_eq!(calls[0].input, serde_json::json!({ "path": "public" }));
        assert_eq!(cleaned, "Let me check that.");
    }

    #[test]
    fn no_recovery_for_plain_content() {
        let content = "Just a normal answer with no tool calls.";
        let (calls, cleaned) = recover_text_tool_calls(content);
        assert!(calls.is_empty());
        assert_eq!(cleaned, content);
    }

    #[test]
    fn recovers_bare_json_action_object() {
        // The shape LFM2.5 leaks: action names the tool, args are siblings.
        let content = "{\n\"action\": \"read_file\",\n\"path\": \"./src/components/Tabs.tsx\"\n}";
        let (calls, cleaned) = recover_text_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(
            calls[0].input,
            serde_json::json!({ "path": "./src/components/Tabs.tsx" })
        );
        assert_eq!(cleaned, "");
    }

    #[test]
    fn recovers_json_action_amid_prose_with_trailing_noise() {
        // A trailing `?` (model unsure) must not defeat the balanced-brace scan,
        // and surrounding prose is preserved.
        let content = "Let me look at the readme.\n{ \"action\": \"read_file\", \"path\": \"./README.md\" } ?";
        let (calls, cleaned) = recover_text_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].input, serde_json::json!({ "path": "./README.md" }));
        assert_eq!(cleaned, "Let me look at the readme.\n ?");
    }

    #[test]
    fn recovers_json_action_with_nested_action_input() {
        let content = "{\"action\":\"grep\",\"action_input\":{\"query\":\"export default\",\"path\":\"src\"}}";
        let (calls, _) = recover_text_tool_calls(content);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "grep");
        assert_eq!(
            calls[0].input,
            serde_json::json!({ "query": "export default", "path": "src" })
        );
    }

    #[test]
    fn json_object_without_action_key_is_left_as_prose() {
        // A plain JSON object the model wrote as an *answer* must not be hijacked.
        let content = "Here is the config: { \"port\": 8080, \"host\": \"localhost\" }";
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
    fn locate_tolerates_stacked_gutters_from_a_peeked_read() {
        // A big read_file result gets retained; the model peeks a slice and
        // pastes it into old_str. Each line then carries TWO gutters: the
        // peek_value number over the read_file number, e.g. "5: 2:     code".
        let current = "fn f() {\n    let y = 2;\n    return y;\n}\n";
        let old = "5: 2:     let y = 2;\n6: 3:     return y;";
        let (s, e) = locate_edit(current, old).expect("double-gutter fuzzy unique");
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
        let dir =
            std::env::temp_dir().join(format!("klide-snapshot-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ws = Workspace::new(dir.to_str().unwrap()).unwrap();
        (ws, dir)
    }

    #[tokio::test]
    async fn run_command_capture_reports_output_and_exit() {
        let dir = std::env::temp_dir().join(format!("klide-runcmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        let ok = run_command_capture(root, "echo hello", 30).await;
        assert!(ok.ok, "exit 0 → ok");
        assert!(
            ok.content.contains("hello"),
            "stdout captured: {}",
            ok.content
        );
        assert!(ok.content.contains("exit 0"));

        let fail = run_command_capture(root, "exit 3", 30).await;
        assert!(!fail.ok, "non-zero exit → not ok");
        assert!(
            fail.content.contains("exit 3"),
            "exit code surfaced: {}",
            fail.content
        );

        // A command that outlives the timeout is killed and reported, not hung.
        let slow = run_command_capture(root, "sleep 10", 1).await;
        assert!(!slow.ok, "timed-out command → not ok");
        assert!(
            slow.content.contains("timed out"),
            "timeout surfaced: {}",
            slow.content
        );
    }

    /// The verdict of a command lives at the end of its output. A head-only cut
    /// dropped it, which cost the model a turn re-running the command to see how
    /// it ended.
    #[test]
    fn truncate_middle_keeps_both_ends_within_budget() {
        let body = format!(
            "FIRST LINE\n{}\nVERDICT: 3 failed",
            "filler line\n".repeat(2000)
        );
        let cut = truncate_middle(&body, 1_000);

        assert!(cut.contains("FIRST LINE"), "head survives: {cut}");
        assert!(cut.contains("VERDICT: 3 failed"), "tail survives: {cut}");
        assert!(cut.contains("bytes elided"), "the gap is marked: {cut}");
        assert!(
            cut.len() <= 1_000,
            "marker is charged to the budget, not appended past it: {} > 1000",
            cut.len()
        );
    }

    /// Under the cap the body is returned verbatim — no marker, no reshaping.
    #[test]
    fn truncate_middle_leaves_short_output_alone() {
        let body = "all of it\n";
        assert_eq!(truncate_middle(body, 1_000), body);
    }

    /// Cuts land on char boundaries even when the output is multi-byte and has
    /// no newline to snap to — a minified body or a one-line JSON payload.
    #[test]
    fn truncate_middle_survives_multibyte_output_without_newlines() {
        let body = "é".repeat(5_000);
        let cut = truncate_middle(&body, 400);
        assert!(cut.len() <= 400, "within budget: {}", cut.len());
        assert!(cut.contains("bytes elided"));
        // Slicing mid-character would have panicked above; this asserts the
        // result is still readable rather than a run of replacement chars.
        assert!(cut.starts_with('é'), "head is intact: {cut}");
        assert!(cut.ends_with('é'), "tail is intact: {cut}");
    }

    /// A budget too small to describe the elision degrades to a plain head cut
    /// instead of returning a string that is all marker.
    #[test]
    fn truncate_middle_degrades_to_a_head_cut_on_a_tiny_budget() {
        let body = "x".repeat(1_000);
        let cut = truncate_middle(&body, 10);
        assert_eq!(cut, "x".repeat(10));
    }

    fn dynamic_tool_sandbox(name: &str, tools_json: &str) -> (String, PathBuf) {
        let dir = std::env::temp_dir().join(format!("klide-dynamic-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".agents")).unwrap();
        std::fs::write(dir.join(".agents/tools.json"), tools_json).unwrap();
        (dir.to_string_lossy().to_string(), dir)
    }

    #[test]
    fn dynamic_command_tools_are_goal_only() {
        let (root, _dir) = dynamic_tool_sandbox(
            "goal-only",
            r#"{"tools":[{"name":"workspace_probe","description":"Probe","command":"pwd","cwd":"workspace"}]}"#,
        );

        let plan = list_tools_for_workspace(&AgentMode::Plan, &[], Some(&root));
        assert!(
            !plan
                .iter()
                .any(|schema| schema["function"]["name"] == "workspace_probe"),
            "Plan mode must not advertise shell-backed dynamic tools"
        );

        let goal = list_tools_for_workspace(&AgentMode::Goal, &[], Some(&root));
        assert!(
            goal.iter()
                .any(|schema| schema["function"]["name"] == "workspace_probe"),
            "Goal mode should advertise dynamic command tools"
        );
    }

    #[test]
    fn dynamic_tools_classify_as_command_capability() {
        let (root, _dir) = dynamic_tool_sandbox(
            "kind",
            r#"{"tools":[{"name":"workspace_probe","description":"Probe","command":"pwd","cwd":"workspace"}]}"#,
        );

        assert_eq!(
            find_tool_kind_for_workspace("read_file", None),
            Some(ToolKind::ReadOnly)
        );
        assert_eq!(
            find_tool_kind_for_workspace("search_conversations", None),
            Some(ToolKind::ConversationHistory)
        );
        assert_eq!(
            find_tool_kind_for_workspace("memory_search", None),
            Some(ToolKind::ProjectMemory)
        );
        assert_eq!(
            find_tool_kind_for_workspace("memory_search", None)
                .map(|kind| kind.capability().wire()),
            Some("read_project_memory")
        );
        assert_eq!(
            find_tool_kind_for_workspace("search_conversations", None)
                .map(|kind| kind.capability().wire()),
            Some("read_conversation_history")
        );
        assert_eq!(
            find_tool_kind_for_workspace("web_search", None),
            Some(ToolKind::Network)
        );
        assert_eq!(
            find_tool_kind_for_workspace("workspace_probe", Some(&root)),
            Some(ToolKind::Command)
        );
        assert_eq!(
            find_tool_kind_for_workspace("workspace_probe", Some(&root))
                .map(|k| k.capability().wire()),
            Some("run_command"),
            "a workspace-defined tool is command-capability whatever it is named"
        );
        assert!(tool_allowed_in_mode(&AgentMode::Goal, ToolKind::Command));
        assert!(!tool_allowed_in_mode(&AgentMode::Plan, ToolKind::Command));
        assert!(tool_allowed_in_mode(&AgentMode::Goal, ToolKind::Network));
        assert!(!tool_allowed_in_mode(&AgentMode::Plan, ToolKind::Network));
        assert!(tool_allowed_in_mode(&AgentMode::Plan, ToolKind::PlanState));
        assert!(tool_allowed_in_mode(
            &AgentMode::Plan,
            ToolKind::ConversationHistory
        ));
        assert!(tool_allowed_in_mode(
            &AgentMode::Plan,
            ToolKind::ProjectMemory
        ));
        let plan = list_tools_for_workspace(&AgentMode::Plan, &[], Some(&root));
        assert!(
            plan.iter()
                .any(|schema| schema["function"]["name"] == "update_todo_list"),
            "Plan mode may update app-owned plan state"
        );
        assert!(
            plan.iter()
                .any(|schema| schema["function"]["name"] == "search_conversations"),
            "Plan mode must advertise conversation-history search"
        );
        assert!(
            plan.iter()
                .any(|schema| schema["function"]["name"] == "memory_search"),
            "Plan mode must advertise Project Memory search"
        );
        assert!(
            plan.iter()
                .any(|schema| schema["function"]["name"] == "memory_read"),
            "Plan mode must advertise Project Memory reads"
        );
        assert!(
            !plan
                .iter()
                .any(|schema| schema["function"]["name"] == "web_search"),
            "Plan mode must not advertise network tools"
        );
        // consult_advisor is the one Pause tool available while planning; its
        // Goal-only sibling spawn_subagent must stay hidden in Plan.
        assert!(
            plan.iter()
                .any(|schema| schema["function"]["name"] == ADVISOR_TOOL),
            "Plan mode must advertise consult_advisor"
        );
        assert!(
            !plan
                .iter()
                .any(|schema| schema["function"]["name"] == "spawn_subagent"),
            "Plan mode must not advertise spawn_subagent"
        );
        // …and it's actually executable in Plan, not just advertised.
        let advisor_call = NormalizedToolCall {
            id: "c1".to_string(),
            name: ADVISOR_TOOL.to_string(),
            input: serde_json::json!({ "question": "A or B?" }),
        };
        assert!(matches!(
            crate::agent::run_core::plan_tool_step(
                &AgentMode::Plan,
                &advisor_call,
                Some(ToolKind::Pause)
            ),
            crate::agent::run_core::ToolStepPlan::Execute { .. }
        ));
    }

    /// Advisor-recursion guard. A consult_advisor call runs its consultation as
    /// a CHAT-mode child (AiPanel runAdvisorConsult). Chat mode must never
    /// expose consult_advisor — or the advisor could escalate forever — nor any
    /// tool that touches the Workspace. What Chat does carry is the
    /// coordination set: every conversation can address its peers, whatever
    /// its Mode, and those tools only append to the reviewed journal.
    #[test]
    fn chat_mode_exposes_only_coordination_tools_so_an_advisor_cannot_recurse() {
        let names: Vec<String> = list_tools_for_workspace(&AgentMode::Chat, &[], None)
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert!(!names.is_empty(), "Chat carries the coordination tools");
        for name in &names {
            assert_ne!(name, ADVISOR_TOOL, "advisor recursion guard");
            assert!(
                coordination_flavor(name).is_some(),
                "Chat exposes nothing but coordination tools, got {name}"
            );
        }
        assert!(schemas_for_mode(&AgentMode::Chat, &[], None).is_some());
    }

    #[test]
    fn command_preflight_surfaces_external_absolute_paths() {
        let dir = std::env::temp_dir().join(format!("klide-preflight-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Canonicalize so the workspace root and resolved candidates share the
        // same symlink form (macOS /var → /private/var).
        let dir = std::fs::canonicalize(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();

        let inside = dir.join("out.txt").to_string_lossy().to_string();
        let preflight = preflight_command(
            &root,
            &root,
            &format!("cat {inside} > /tmp/klide-out && FOO=/var/tmp/cache echo ok"),
        );
        assert!(
            preflight
                .external_paths
                .iter()
                .any(|p| p.ends_with("/tmp/klide-out")),
            "{:?}",
            preflight.external_paths
        );
        assert!(
            preflight
                .external_paths
                .iter()
                .any(|p| p.ends_with("/var/tmp/cache")),
            "{:?}",
            preflight.external_paths
        );
        assert!(
            !preflight.external_paths.iter().any(|p| p == &inside),
            "workspace paths should not be flagged"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn command_preflight_catches_relative_tilde_and_env_escapes() {
        let dir = std::env::temp_dir().join(format!("klide-preflight-rel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();

        // A relative `..` chain that climbs out of the workspace.
        let rel = preflight_command(&root, &root, "cat ../../../etc/klide-escape");
        assert!(
            rel.external_paths
                .iter()
                .any(|p| p.ends_with("/klide-escape")),
            "relative escape must be flagged: {:?}",
            rel.external_paths
        );

        // A relative path that stays inside is left alone.
        let inside = preflight_command(&root, &root, "cat ./src/main.rs");
        assert!(
            inside.external_paths.is_empty(),
            "in-workspace relative paths must not be flagged: {:?}",
            inside.external_paths
        );

        // Bare words (subcommands / flags) are never treated as paths.
        let bare = preflight_command(&root, &root, "cargo test --all-features");
        assert!(
            bare.external_paths.is_empty(),
            "bare words must not be flagged: {:?}",
            bare.external_paths
        );

        // `$HOME` and `~` both expand and resolve outside the workspace.
        if std::env::var("HOME").is_ok() {
            let home = preflight_command(&root, &root, "cat $HOME/.klide-secret && cat ~/other");
            assert!(
                home.external_paths.len() >= 2,
                "tilde and $HOME escapes must be flagged: {:?}",
                home.external_paths
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dynamic_tools_do_not_execute_through_read_only_dispatch() {
        let (root, dir) = dynamic_tool_sandbox(
            "read-dispatch",
            r#"{"tools":[{"name":"workspace_probe","description":"Probe","command":"touch marker","cwd":"workspace"}]}"#,
        );
        let call = NormalizedToolCall {
            id: "call_1".to_string(),
            name: "workspace_probe".to_string(),
            input: serde_json::json!({}),
        };

        let result = execute_read_only_tool(&root, &call, "run-dynamic");
        assert!(!result.ok);
        assert!(result.content.contains("command-capability"));
        assert!(
            !dir.join("marker").exists(),
            "read-only dispatch must not run the dynamic shell command"
        );
    }

    #[test]
    fn conversation_search_tool_reads_the_app_run_store() {
        let base = std::env::temp_dir().join(format!(
            "klide-search-tool-store-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("workspace");
        let runs = base.join("runs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&runs).unwrap();
        let call = NormalizedToolCall {
            id: "search-1".to_string(),
            name: "search_conversations".to_string(),
            input: serde_json::json!({ "query": "authentication" }),
        };

        let unavailable = execute_read_only_tool(root.to_str().unwrap(), &call, "current");
        assert!(!unavailable.ok);
        assert!(unavailable.content.contains("unavailable"));

        let result = execute_read_only_tool_with_runs_dir(
            root.to_str().unwrap(),
            &call,
            "current",
            &runs,
        );
        assert!(result.ok, "{}", result.content);
        assert!(result.content.contains("No previous Klide conversations"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn memory_tools_round_trip_reviewed_markdown_with_provenance() {
        let base = std::env::temp_dir().join(format!(
            "klide-memory-tool-store-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let entry = crate::memory::write_memory(
            base.to_string_lossy().to_string(),
            crate::memory::MemoryInput {
                title: "Keep trust decisions in Rust".to_string(),
                kind: crate::memory::MemoryKind::Decision,
                tags: vec!["harness".to_string()],
                source_refs: vec![crate::memory::MemorySourceRef {
                    source_type: crate::memory::MemorySourceType::Run,
                    id: "run-trust-1".to_string(),
                    label: Some("Trust boundary run".to_string()),
                    ..crate::memory::MemorySourceRef::default()
                }],
                supersedes: None,
                goal: "Keep the command trust boundary inside the Rust Harness".to_string(),
                plan: Vec::new(),
                decisions: vec!["Renderer input never grants command trust".to_string()],
                files_touched: vec!["src-tauri/src/agent/permission.rs".to_string()],
                next_steps: Vec::new(),
                notes: "The audit trail must remain capability-specific.".to_string(),
                run_id: Some("run-trust-1".to_string()),
                provider: Some("klide".to_string()),
                model: Some("test-model".to_string()),
                mode: Some("goal".to_string()),
                status: Some("done".to_string()),
            },
        )
        .unwrap();

        let search = execute_read_only_tool(
            base.to_str().unwrap(),
            &NormalizedToolCall {
                id: "memory-search-1".to_string(),
                name: "memory_search".to_string(),
                input: serde_json::json!({
                    "query": "trust Rust",
                    "kinds": ["decision"]
                }),
            },
            "current-run",
        );
        assert!(search.ok, "{}", search.content);
        assert!(search.content.contains(&entry.id));
        assert_eq!(
            search.metadata.as_ref().unwrap()["hits"][0]["entry"]["sourceRefs"][0]["id"],
            "run-trust-1"
        );

        let read = execute_read_only_tool(
            base.to_str().unwrap(),
            &NormalizedToolCall {
                id: "memory-read-1".to_string(),
                name: "memory_read".to_string(),
                input: serde_json::json!({ "memoryId": entry.id }),
            },
            "current-run",
        );
        assert!(read.ok, "{}", read.content);
        assert!(read.content.contains("title: Keep trust decisions in Rust"));
        assert_eq!(read.metadata.as_ref().unwrap()["entry"]["kind"], "decision");

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn dynamic_tool_command_is_workspace_rooted_and_timeout_bounded() {
        let (root, dir) = dynamic_tool_sandbox(
            "invocation",
            r#"{"tools":[{"name":"workspace_probe","description":"Probe","command":"echo base","cwd":"sub","timeout_secs":9999}]}"#,
        );
        std::fs::create_dir_all(dir.join("sub")).unwrap();

        let invocation = dynamic_tool_command(
            "workspace_probe",
            &serde_json::json!({ "args": "extra" }),
            &root,
        )
        .expect("dynamic tool exists")
        .expect("dynamic tool command resolves");

        assert_eq!(invocation.command, "echo base extra");
        assert_eq!(
            invocation.cwd,
            std::fs::canonicalize(dir.join("sub"))
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        assert_eq!(invocation.timeout_secs, 1800);
        assert!(invocation.summary.contains("workspace_probe"));
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

        let input =
            serde_json::json!({ "path": "a.rs", "old_str": "let x = 1;", "new_str": "let x = 2;" });
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

        let input =
            serde_json::json!({ "path": "a.rs", "old_str": "let x = 1;", "new_str": "let x = 2;" });
        let proposal = preview_write_file(&ws, &input, run).unwrap();
        assert!(
            proposal.reason.is_none(),
            "fresh edit should not be flagged"
        );
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

    #[test]
    fn every_pause_entry_has_a_flavor_and_only_pause_entries_do() {
        // The loop dispatches Pause ceremony on `pause_flavor`, so a fourth
        // Pause tool added to the registry without a flavor would silently
        // fall through to the question ceremony — pin the mapping to the
        // entries, in both directions, with distinct flavors per entry.
        let mut seen = Vec::new();
        for entry in registry() {
            let name = entry.schema["function"]["name"].as_str().unwrap();
            match (entry.kind, pause_flavor(name)) {
                (ToolKind::Pause, Some(flavor)) => {
                    assert!(
                        !seen.contains(&flavor),
                        "{name}: flavor {flavor:?} already used by another Pause entry"
                    );
                    seen.push(flavor);
                }
                (ToolKind::Pause, None) => {
                    panic!("Pause entry {name} has no PauseFlavor — add it to pause_flavor()")
                }
                (_, Some(flavor)) => {
                    panic!("non-Pause entry {name} maps to {flavor:?} — flavor implies Pause")
                }
                (_, None) => {}
            }
        }
        assert_eq!(seen.len(), 3, "expected the three Pause ceremonies");
    }

    #[test]
    fn every_coordination_entry_has_one_native_flavor() {
        let mut seen = Vec::new();
        for entry in registry() {
            let name = entry.schema["function"]["name"].as_str().unwrap();
            match (entry.kind, coordination_flavor(name)) {
                (ToolKind::Coordination, Some(flavor)) => {
                    assert!(!seen.contains(&flavor), "duplicate flavor for {name}");
                    seen.push(flavor);
                }
                (ToolKind::Coordination, None) => {
                    panic!("Coordination entry {name} has no CoordinationFlavor")
                }
                (_, Some(flavor)) => {
                    panic!("non-Coordination entry {name} maps to {flavor:?}")
                }
                (_, None) => {}
            }
        }
        assert_eq!(seen.len(), 5, "expected five native coordination Tools");
        assert!(tool_allowed_in_mode(
            &AgentMode::Plan,
            ToolKind::Coordination
        ));
    }

    #[test]
    fn command_invocation_resolves_builtin_and_dynamic_and_rejects_unknown() {
        let dir = std::env::temp_dir().join(format!("klide-cmd-inv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".agents")).unwrap();
        std::fs::write(
            dir.join(".agents/tools.json"),
            r#"{"tools":[{"name":"lint","description":"Lint","command":"npm run lint","cwd":"workspace","timeout_secs":60}]}"#,
        )
        .unwrap();
        let root = dir.to_str().unwrap();

        // Builtin: reads the `command` input, runs at the workspace root,
        // clamps the timeout.
        let call = NormalizedToolCall {
            id: "t1".to_string(),
            name: RUN_COMMAND_TOOL.to_string(),
            input: serde_json::json!({ "command": "  ls -la  " }),
        };
        let inv = command_invocation(&call, root, 9_999).expect("builtin resolves");
        assert_eq!(inv.command, "ls -la");
        assert_eq!(inv.cwd, root);
        assert_eq!(inv.timeout_secs, 1800, "timeout must clamp to the guard cap");

        // Builtin with an empty command is refused.
        let empty = NormalizedToolCall {
            id: "t2".to_string(),
            name: RUN_COMMAND_TOOL.to_string(),
            input: serde_json::json!({ "command": "   " }),
        };
        assert!(command_invocation(&empty, root, 180).is_err());

        // Dynamic: the template from .agents/tools.json wins.
        let dynamic = NormalizedToolCall {
            id: "t3".to_string(),
            name: "lint".to_string(),
            input: serde_json::json!({}),
        };
        let inv = command_invocation(&dynamic, root, 180).expect("dynamic resolves");
        assert_eq!(inv.command, "npm run lint");

        // Unknown command-capability names are refused, not guessed.
        let unknown = NormalizedToolCall {
            id: "t4".to_string(),
            name: "not_a_tool".to_string(),
            input: serde_json::json!({}),
        };
        let refused = command_invocation(&unknown, root, 180).unwrap_err();
        assert!(refused.content.contains("Unknown command-capability tool"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_tool_names_are_every_pause_tool_and_only_those() {
        let interactive = interactive_tool_names();

        // Exactly the Pause-capability rows, derived rather than listed. A
        // headless Mission attempt disables these; a fourth Pause tool added to
        // the registry has to appear here automatically or it stays silently
        // callable in a run with nothing attached to answer it.
        let mut expected: Vec<String> = registry()
            .into_iter()
            .filter(|e| e.kind == ToolKind::Pause)
            .map(|e| e.schema["function"]["name"].as_str().unwrap().to_string())
            .collect();
        expected.sort();
        let mut got = interactive.clone();
        got.sort();
        assert_eq!(got, expected);

        // The three the Mission path used to hand-list, so this test fails if
        // one is renamed without the Mission side noticing.
        for name in ["userAnswerQuestion", "spawn_subagent", ADVISOR_TOOL] {
            assert!(
                interactive.iter().any(|n| n == name),
                "{name} must be treated as interactive"
            );
        }

        // Gates that pause but are NOT Pause tools: the permission gate on a
        // Command tool and the diff gate on a Write tool both have durable
        // supervisor state and stay enabled headlessly.
        for name in ["run_command", "write_file", "read_file"] {
            assert!(
                !interactive.iter().any(|n| n == name),
                "{name} is not an interactive Tool"
            );
        }
    }

    #[test]
    fn capability_wire_spellings_are_distinct_and_stable() {
        // These land in Transcripts on disk, so a rename silently changes how
        // every past run's Validation contract reads.
        let all = [
            ToolCapability::ReadWorkspace,
            ToolCapability::ReadConversationHistory,
            ToolCapability::ReadProjectMemory,
            ToolCapability::UpdatePlanState,
            ToolCapability::WriteWorkspace,
            ToolCapability::RunCommand,
            ToolCapability::PauseForUser,
            ToolCapability::CoordinateAgents,
            ToolCapability::Network,
        ];
        let mut wires: Vec<&str> = all.iter().map(|c| c.wire()).collect();
        wires.sort_unstable();
        let count = wires.len();
        wires.dedup();
        assert_eq!(wires.len(), count, "wire spellings must be distinct");
        assert_eq!(ToolCapability::RunCommand.wire(), "run_command");
        assert_eq!(
            ToolCapability::ReadConversationHistory.wire(),
            "read_conversation_history"
        );
        assert_eq!(
            ToolCapability::ReadProjectMemory.wire(),
            "read_project_memory"
        );
    }
}
