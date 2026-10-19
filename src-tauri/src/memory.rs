pub mod proposals;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const MEMORY_SCHEMA_VERSION: u32 = 1;

/// The durable knowledge shape. A Run can produce several kinds of memory;
/// keeping the kind explicit lets retrieval prefer a prior failure over a
/// generic handoff when the query asks about the same error.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Run,
    #[default]
    Handoff,
    Decision,
    Convention,
    Fact,
    Failure,
    Pattern,
}

impl MemoryKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Handoff => "handoff",
            Self::Decision => "decision",
            Self::Convention => "convention",
            Self::Fact => "fact",
            Self::Failure => "failure",
            Self::Pattern => "pattern",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "run" => Some(Self::Run),
            "handoff" => Some(Self::Handoff),
            "decision" => Some(Self::Decision),
            "convention" => Some(Self::Convention),
            "fact" => Some(Self::Fact),
            "failure" => Some(Self::Failure),
            "pattern" => Some(Self::Pattern),
            _ => None,
        }
    }
}

/// Only reviewed entries live in the durable Markdown store today. Keeping the
/// state on the record makes future consolidation explicit and allows readers
/// to exclude superseded/stale knowledge without deleting its evidence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryReviewState {
    Proposed,
    #[default]
    Reviewed,
    Superseded,
    Stale,
}

impl MemoryReviewState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Proposed => "proposed",
            Self::Reviewed => "reviewed",
            Self::Superseded => "superseded",
            Self::Stale => "stale",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "proposed" => Some(Self::Proposed),
            "reviewed" => Some(Self::Reviewed),
            "superseded" => Some(Self::Superseded),
            "stale" => Some(Self::Stale),
            _ => None,
        }
    }
}

/// A link back to the evidence that produced a memory. The fields are broad
/// enough for Run/Transcript/commit/file sources without forcing every source
/// to invent a different wire shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySourceType {
    #[default]
    Run,
    Transcript,
    Commit,
    File,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySourceRef {
    pub source_type: MemorySourceType,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_end: Option<u32>,
}

/// A single memory entry — one per handoff / summary. Stored as a markdown
/// file with a YAML-ish frontmatter block at the top so the file is
/// self-describing and grep-friendly.
///
/// Layout (single line per frontmatter key, blank line, then markdown body):
/// ```text
/// ---
/// schemaVersion: 1
/// date: 2026-06-07T19:30:00Z
/// runId: ses_abc123
/// provider: klide
/// model: llama3.1:8b
/// mode: plan
/// status: done
/// title: Add Mission Control v2
/// kind: decision
/// reviewState: reviewed
/// tags: ["missions","handoff"]
/// sourceRefs: [{"sourceType":"run","id":"ses_abc123"}]
/// ---
///
/// # Goal
/// ...
/// ```
///
/// The file lives at `<workspace>/.klide/memory/YYYY-MM-DD-HHMM-<slug>.md` so
/// it's project-readable, git-friendly, and stable to sort by date.

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    /// Version of the durable JSON/Markdown schema represented by this entry.
    pub schema_version: u32,
    /// Stable id (also the file stem: `2026-06-07-1930-add-mc-v2`).
    pub id: String,
    /// Absolute path on disk.
    pub path: String,
    /// Workspace-relative path (for display + git).
    pub rel_path: String,
    /// Creation time in unix millis.
    pub created_at_ms: i64,
    /// ISO-8601 string for the date header.
    pub date_iso: String,
    /// The short title shown in lists; also the `<slug>` in the filename.
    pub title: String,
    /// Whether this is a handoff, decision, failure, convention, etc.
    pub kind: MemoryKind,
    /// Durable notes are reviewed; retained superseded/stale notes are hidden
    /// from normal recall but remain inspectable evidence.
    pub review_state: MemoryReviewState,
    /// Small user/model-authored retrieval hints.
    pub tags: Vec<String>,
    /// Evidence links back to Runs, Transcript regions, files, or commits.
    pub source_refs: Vec<MemorySourceRef>,
    /// The older memory this record replaces, when consolidation has occurred.
    pub supersedes: Option<String>,
    /// Goal — first sentence of the note.
    pub goal: String,
    /// Plan bullets.
    pub plan: Vec<String>,
    /// Decision bullets.
    pub decisions: Vec<String>,
    /// Files touched (relative to the workspace).
    pub files_touched: Vec<String>,
    /// Next-step bullets.
    pub next_steps: Vec<String>,
    /// Free-form notes from the summarizer.
    pub notes: String,
    /// Optional run id this memory was written from.
    pub run_id: Option<String>,
    /// Provider that produced the summary.
    pub provider: Option<String>,
    /// Model used.
    pub model: Option<String>,
    /// Agent mode (chat, plan, goal).
    pub mode: Option<String>,
    /// Run status (done, cancelled, error).
    pub status: Option<String>,
}

/// Input shape for `memory_write`. Rust fills the derived identity/time fields
/// and stamps `reviewState: reviewed` at the durable acceptance boundary.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    pub title: String,
    #[serde(default)]
    pub kind: MemoryKind,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_refs: Vec<MemorySourceRef>,
    #[serde(default)]
    pub supersedes: Option<String>,
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub plan: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub files_touched: Vec<String>,
    #[serde(default)]
    pub next_steps: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchHit {
    pub entry: MemoryEntry,
    pub score: u32,
    pub matched_fields: Vec<String>,
    pub excerpt: String,
}

/// Create-on-write only. Read paths must never mutate the workspace (Plan
/// mode cannot write files; a fresh per-run worktree stays clean), so they
/// resolve the store with `resolve_existing` and treat a missing dir as empty.
fn ensure_memory_dir(workspace: &Workspace) -> Result<PathBuf, String> {
    let dir = workspace.resolve_new(".klide/memory")?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Unable to create .klide/memory directory: {e}"))?;
    workspace.resolve_existing(".klide/memory")
}

/// A linked git worktree's `.git` is a *file* — `gitdir: <main>/.git/worktrees/<name>`.
/// Walk it back to the main checkout (the directory that owns the real `.git`).
fn main_checkout_root(root: &Path) -> Option<PathBuf> {
    let git_marker = root.join(".git");
    if !std::fs::symlink_metadata(&git_marker).ok()?.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(&git_marker).ok()?;
    let gitdir = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    let gitdir_path = if Path::new(gitdir).is_absolute() {
        PathBuf::from(gitdir)
    } else {
        root.join(gitdir)
    };
    let canonical = std::fs::canonicalize(&gitdir_path).ok()?;
    let mut current = canonical.as_path();
    while let Some(parent) = current.parent() {
        if current.file_name().and_then(|name| name.to_str()) == Some(".git") {
            return Some(parent.to_path_buf());
        }
        current = parent;
    }
    None
}

/// Memory must survive run isolation. Races/Tasks/Missions open a linked git
/// worktree as their workspace, but `.klide/memory/` is git-ignored and not
/// copied by worktree setup — resolving it against the worktree would make
/// recall silently empty and plant a stray store. Hop to the main checkout so
/// every run shares the one durable store. Returns `None` (caller keeps the
/// run's own workspace) when the root is not a linked worktree or the hop
/// cannot be resolved — same behavior as a plain checkout.
fn resolve_memory_workspace(workspace: &Workspace) -> Option<Workspace> {
    let main_root = main_checkout_root(workspace.root())?;
    if main_root == workspace.root() {
        return None;
    }
    Workspace::new(main_root.to_str()?).ok()
}

fn slugify(input: &str) -> String {
    let lower = input.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut last_dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(60);
    if out.is_empty() {
        out.push_str("note");
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn date_stamp(ms: i64) -> String {
    // YYYY-MM-DD-HHMM in UTC. Cheap format — no chrono dep, no time crate.
    let total_secs = (ms / 1000).max(0);
    let day_secs = (total_secs % 86_400) as u32;
    let days = total_secs / 86_400;
    let (h, m, _) = (day_secs / 3600, (day_secs / 60) % 60, day_secs % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}-{h:02}{m:02}")
}

fn iso_date(ms: i64) -> String {
    let total_secs = (ms / 1000).max(0);
    let day_secs = (total_secs % 86_400) as u32;
    let days = total_secs / 86_400;
    let (h, mi, s) = (day_secs / 3600, (day_secs / 60) % 60, day_secs % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn opt_str(s: &Option<String>) -> Option<String> {
    s.as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Frontmatter values render one per line, and the parser is last-key-wins —
/// so a value carrying a newline could forge the Rust-stamped keys (e.g. a
/// supersedes of `"x\nreviewState: stale"`). Strip control characters before
/// any free string reaches the block. Tags/sourceRefs are JSON-escaped by
/// serde and safe as-is.
fn frontmatter_value(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .trim()
        .to_string()
}

fn render_markdown(entry: &MemoryEntry) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("schemaVersion: {}\n", entry.schema_version));
    out.push_str(&format!("date: {}\n", entry.date_iso));
    if let Some(v) = opt_str(&entry.run_id) {
        out.push_str(&format!("runId: {}\n", frontmatter_value(&v)));
    }
    if let Some(v) = opt_str(&entry.provider) {
        out.push_str(&format!("provider: {}\n", frontmatter_value(&v)));
    }
    if let Some(v) = opt_str(&entry.model) {
        out.push_str(&format!("model: {}\n", frontmatter_value(&v)));
    }
    if let Some(v) = opt_str(&entry.mode) {
        out.push_str(&format!("mode: {}\n", frontmatter_value(&v)));
    }
    if let Some(v) = opt_str(&entry.status) {
        out.push_str(&format!("status: {}\n", frontmatter_value(&v)));
    }
    out.push_str(&format!("title: {}\n", frontmatter_value(&entry.title)));
    out.push_str(&format!("kind: {}\n", entry.kind.as_str()));
    out.push_str(&format!("reviewState: {}\n", entry.review_state.as_str()));
    if !entry.tags.is_empty() {
        if let Ok(tags) = serde_json::to_string(&entry.tags) {
            out.push_str(&format!("tags: {tags}\n"));
        }
    }
    if !entry.source_refs.is_empty() {
        if let Ok(refs) = serde_json::to_string(&entry.source_refs) {
            out.push_str(&format!("sourceRefs: {refs}\n"));
        }
    }
    if let Some(v) = opt_str(&entry.supersedes) {
        out.push_str(&format!("supersedes: {}\n", frontmatter_value(&v)));
    }
    out.push_str("---\n\n");
    if !entry.goal.is_empty() {
        out.push_str("# Goal\n\n");
        out.push_str(entry.goal.trim());
        out.push_str("\n\n");
    }
    if !entry.plan.is_empty() {
        out.push_str("# Plan\n\n");
        for line in &entry.plan {
            out.push_str(&format!("- {}\n", line.trim()));
        }
        out.push('\n');
    }
    if !entry.decisions.is_empty() {
        out.push_str("# Decisions\n\n");
        for line in &entry.decisions {
            out.push_str(&format!("- {}\n", line.trim()));
        }
        out.push('\n');
    }
    if !entry.files_touched.is_empty() {
        out.push_str("# Files touched\n\n");
        for path in &entry.files_touched {
            out.push_str(&format!("- `{}`\n", path.trim()));
        }
        out.push('\n');
    }
    if !entry.next_steps.is_empty() {
        out.push_str("# Next steps\n\n");
        for line in &entry.next_steps {
            out.push_str(&format!("- {}\n", line.trim()));
        }
        out.push('\n');
    }
    if !entry.notes.trim().is_empty() {
        out.push_str("# Notes\n\n");
        out.push_str(entry.notes.trim());
        out.push('\n');
    }
    out
}

fn parse_entry_from_file(path: &Path, workspace_root: &Path) -> Option<MemoryEntry> {
    let content = std::fs::read_to_string(path).ok()?;
    let rel_path = path
        .strip_prefix(workspace_root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string());
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Naive frontmatter parser: lines between the first pair of `---`.
    let mut lines = content.lines();
    let mut schema_version = MEMORY_SCHEMA_VERSION;
    let mut date_iso = String::new();
    let mut run_id = None;
    let mut provider = None;
    let mut model = None;
    let mut mode = None;
    let mut status = None;
    let mut title = String::new();
    let mut kind = MemoryKind::default();
    let mut review_state = MemoryReviewState::default();
    let mut tags = Vec::new();
    let mut source_refs = Vec::new();
    let mut supersedes = None;
    // Markdown is authoritative and hand-editable, so unknown enum values are
    // expected (typos, states a later Klide added). Fail closed: an entry we
    // can't fully interpret is kept as inspectable evidence but never re-enters
    // normal recall as if it were reviewed.
    let mut unknown_enum_value = false;

    if lines.next() == Some("---") {
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
            if let Some((k, v)) = line.split_once(':') {
                let key = k.trim();
                let value = v.trim().to_string();
                if value.is_empty() {
                    continue;
                }
                match key {
                    "schemaVersion" => {
                        // A version we can't parse is a shape we don't know —
                        // treat it as future, never coerce it back to v1.
                        schema_version = value.parse().unwrap_or(MEMORY_SCHEMA_VERSION + 1)
                    }
                    "date" => date_iso = value,
                    "runId" => run_id = Some(value),
                    "provider" => provider = Some(value),
                    "model" => model = Some(value),
                    "mode" => mode = Some(value),
                    "status" => status = Some(value),
                    "title" => title = value,
                    "kind" => match MemoryKind::parse(&value) {
                        Some(parsed) => kind = parsed,
                        None => unknown_enum_value = true,
                    },
                    "reviewState" => match MemoryReviewState::parse(&value) {
                        Some(parsed) => review_state = parsed,
                        None => unknown_enum_value = true,
                    },
                    "tags" => tags = serde_json::from_str(&value).unwrap_or_default(),
                    "sourceRefs" => source_refs = serde_json::from_str(&value).unwrap_or_default(),
                    "supersedes" => supersedes = Some(value),
                    _ => {}
                }
            }
        }
    }
    let created_at_ms = if date_iso.is_empty() {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    } else {
        // Parse YYYY-MM-DDTHH:MM:SSZ back to millis. Cheap and good enough
        // for files we wrote ourselves.
        parse_iso_ms(&date_iso).unwrap_or(0)
    };
    // Never reinterpret a future durable shape with today's semantics — and
    // never silently skip it either. Surface an inert stub: visible in lists,
    // stale so it stays out of normal recall, body left uninterpreted.
    if schema_version > MEMORY_SCHEMA_VERSION {
        return Some(MemoryEntry {
            schema_version,
            id: id.clone(),
            path: path.to_string_lossy().to_string(),
            rel_path,
            created_at_ms,
            date_iso,
            title: if title.is_empty() { id } else { title },
            kind: MemoryKind::default(),
            review_state: MemoryReviewState::Stale,
            tags: Vec::new(),
            source_refs: Vec::new(),
            supersedes: None,
            goal: String::new(),
            plan: Vec::new(),
            decisions: Vec::new(),
            files_touched: Vec::new(),
            next_steps: Vec::new(),
            notes: format!(
                "Unreadable: written with Project Memory schema v{schema_version}, newer than \
this Klide (v{MEMORY_SCHEMA_VERSION}). The Markdown file is intact — open it directly."
            ),
            run_id: None,
            provider: None,
            model: None,
            mode: None,
            status: None,
        });
    }
    if unknown_enum_value {
        review_state = MemoryReviewState::Stale;
    }

    // Body → sections. Section lines start with `# `; we keep what we need
    // for the list view and the body. The full body goes into `notes` so
    // the front-end can show it without re-reading the file.
    let body_start = content.find("\n---\n").map(|i| i + 5).unwrap_or(0);
    let body = content[body_start..].trim_start_matches('\n').to_string();
    let (goal, plan, decisions, files, next_steps, notes) = split_sections(&body);
    if title.is_empty() {
        title = id.clone();
    }

    Some(MemoryEntry {
        schema_version,
        id,
        path: path.to_string_lossy().to_string(),
        rel_path,
        created_at_ms,
        date_iso,
        title,
        kind,
        review_state,
        tags,
        source_refs,
        supersedes,
        goal,
        plan,
        decisions,
        files_touched: files,
        next_steps,
        notes,
        run_id,
        provider,
        model,
        mode,
        status,
    })
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    // YYYY-MM-DDTHH:MM:SSZ
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;
    // Days from y/m/d to 1970-01-01 (Howard Hinnant inverse).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let doy = ((153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1) as u64;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe as i64 - 719_468;
    Some((days * 86_400 + hour * 3600 + min * 60 + sec) * 1000)
}

fn split_sections(
    body: &str,
) -> (
    String,
    Vec<String>,
    Vec<String>,
    Vec<String>,
    Vec<String>,
    String,
) {
    let mut goal = String::new();
    let mut plan = Vec::new();
    let mut decisions = Vec::new();
    let mut files = Vec::new();
    let mut next_steps = Vec::new();
    let mut notes_buf: Vec<String> = Vec::new();

    enum Section {
        None,
        Goal,
        Plan,
        Decisions,
        Files,
        Next,
        Notes,
    }
    let mut section = Section::None;
    for raw in body.lines() {
        let line = raw.trim_end();
        if let Some(name) = line.strip_prefix("# ") {
            section = match name.trim() {
                "Goal" => Section::Goal,
                "Plan" => Section::Plan,
                "Decisions" => Section::Decisions,
                "Files touched" | "Files" => Section::Files,
                "Next steps" => Section::Next,
                "Notes" => Section::Notes,
                _ => Section::None,
            };
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        match section {
            Section::Goal => {
                if goal.is_empty() {
                    goal = line.to_string();
                } else {
                    goal.push(' ');
                    goal.push_str(line);
                }
            }
            Section::Plan => plan.push(line.trim_start_matches("- ").to_string()),
            Section::Decisions => decisions.push(line.trim_start_matches("- ").to_string()),
            Section::Files => files.push(
                line.trim_start_matches("- `")
                    .trim_end_matches('`')
                    .to_string(),
            ),
            Section::Next => next_steps.push(line.trim_start_matches("- ").to_string()),
            Section::Notes => notes_buf.push(line.to_string()),
            Section::None => {}
        }
    }
    (
        goal,
        plan,
        decisions,
        files,
        next_steps,
        notes_buf.join("\n"),
    )
}

/// Flip the `reviewState:` line inside an existing entry's frontmatter to
/// `superseded`, leaving every other byte alone. A surgical edit (not a
/// parse → re-render round trip) so hand-authored sections the parser doesn't
/// model are never dropped from someone's durable note.
fn demote_to_superseded(path: &Path) -> Result<(), String> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("Unable to read memory file: {e}"))?;
    let mut lines: Vec<&str> = raw.split_inclusive('\n').collect();
    let stamped = format!("reviewState: {}\n", MemoryReviewState::Superseded.as_str());
    let mut replaced = false;
    if lines.first().map(|line| line.trim_end()) == Some("---") {
        for line in lines.iter_mut().skip(1) {
            if line.trim_end() == "---" {
                break;
            }
            if line.trim_start().starts_with("reviewState:") {
                *line = &stamped;
                replaced = true;
                break;
            }
        }
    }
    let updated = if replaced {
        lines.concat()
    } else {
        // No frontmatter, or no reviewState line — prepend a minimal block so
        // the demotion is durable even for a bare hand-written note.
        format!("---\n{stamped}---\n\n{raw}")
    };
    crate::durable::write_atomic(path, updated.as_bytes())
        .map_err(|e| format!("Unable to demote superseded memory entry: {e}"))
}

#[tauri::command]
pub async fn memory_write(workspace_root: String, input: MemoryInput) -> Result<MemoryEntry, String> {
    crate::blocking::run(move || write_memory(workspace_root, input)).await
}

/// Synchronous body of `memory_write` — the interface the tests use.
pub fn write_memory(workspace_root: String, input: MemoryInput) -> Result<MemoryEntry, String> {
    let base = Workspace::new(&workspace_root)?;
    let hop = resolve_memory_workspace(&base);
    let workspace = hop.as_ref().unwrap_or(&base);
    let dir = ensure_memory_dir(workspace)?;
    // `supersedes` is renderer/model input that becomes both a frontmatter
    // line and a file lookup — hold it to the id charset before either.
    let supersedes = opt_str(&input.supersedes);
    if let Some(target_id) = &supersedes {
        if !valid_memory_id(target_id) {
            return Err(
                "supersedes must be a Project Memory id (letters, numbers, '-' or '_')."
                    .to_string(),
            );
        }
        // Enforce the supersession at the write boundary: demote the target so
        // normal recall stops returning it. A missing target is fine — the
        // pointer still records the intent.
        if let Ok(target_path) = workspace.resolve_existing(&format!(".klide/memory/{target_id}.md"))
        {
            demote_to_superseded(&target_path)?;
        }
    }
    let created = now_ms();
    let date_iso = iso_date(created);
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| format!("Unable to generate memory id: {e}"))?;
    let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let stem = format!("{}-{}-{suffix}", date_stamp(created), slugify(&input.title));
    let path = dir.join(format!("{stem}.md"));

    let entry = MemoryEntry {
        schema_version: MEMORY_SCHEMA_VERSION,
        id: stem,
        path: path.to_string_lossy().to_string(),
        rel_path: format!(
            ".klide/memory/{}.md",
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("")
        ),
        created_at_ms: created,
        date_iso,
        title: input.title,
        kind: input.kind,
        // Drafts live in the review inbox (legacy frontend drafts and Rust
        // proposals). This command is the acceptance boundary.
        review_state: MemoryReviewState::Reviewed,
        tags: input.tags,
        source_refs: input.source_refs,
        supersedes,
        goal: input.goal,
        plan: input.plan,
        decisions: input.decisions,
        files_touched: input.files_touched,
        next_steps: input.next_steps,
        notes: input.notes,
        run_id: input.run_id,
        provider: input.provider,
        model: input.model,
        mode: input.mode,
        status: input.status,
    };

    let body = render_markdown(&entry);
    crate::durable::write_atomic_new(&path, body.as_bytes())
        .map_err(|e| format!("Unable to write memory entry: {e}"))?;
    Ok(entry)
}

#[tauri::command]
pub async fn memory_list(
    workspace_root: String,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    crate::blocking::run(move || list_memory(workspace_root, limit)).await
}

/// Synchronous body of `memory_list` — the interface the tests use.
pub fn list_memory(workspace_root: String, limit: Option<usize>) -> Result<Vec<MemoryEntry>, String> {
    let workspace = Workspace::new(&workspace_root)?;
    list_workspace_memory(&workspace, limit.unwrap_or(50))
}

pub(crate) fn list_workspace_memory(
    workspace: &Workspace,
    limit: usize,
) -> Result<Vec<MemoryEntry>, String> {
    let hop = resolve_memory_workspace(workspace);
    let workspace = hop.as_ref().unwrap_or(workspace);
    let mut entries = Vec::new();
    // A missing store is simply the first-session state — resolve, never create.
    let Ok(dir) = workspace.resolve_existing(".klide/memory") else {
        return Ok(entries);
    };
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(entries),
    };
    for entry in read.flatten() {
        let entry_path = entry.path();
        let Ok(path) = workspace.resolve_abs_read(&entry_path.to_string_lossy()) else {
            continue;
        };
        if !path.starts_with(&dir) {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Some(parsed) = parse_entry_from_file(&path, workspace.root()) {
            entries.push(parsed);
        }
    }
    entries.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(entries.into_iter().take(limit.min(500)).collect())
}

fn search_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    // Unicode-aware on purpose: an accented letter is part of a term, never a
    // separator, and folding is full to_lowercase — "Décision" must match
    // "décision" for a French workspace, not split into "d" + "cision".
    for term in query
        .split(|ch: char| !(ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/')))
        .map(str::trim)
        .filter(|term| !term.is_empty())
    {
        let term = term.to_lowercase();
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms
}

fn field_matches(
    field: &str,
    value: &str,
    weight: u32,
    terms: &[String],
    covered: &mut [bool],
    score: &mut u32,
    matched_fields: &mut BTreeSet<String>,
) {
    let haystack = value.to_lowercase();
    for (index, term) in terms.iter().enumerate() {
        if haystack.contains(term) {
            covered[index] = true;
            *score += weight;
            matched_fields.insert(field.to_string());
        }
    }
}

fn clip_excerpt(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        return compact;
    }
    let mut out: String = compact.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn search_excerpt(entry: &MemoryEntry, terms: &[String]) -> String {
    let contains_term = |value: &str| {
        let value = value.to_lowercase();
        terms.iter().any(|term| value.contains(term))
    };
    if let Some(decision) = entry.decisions.iter().find(|value| contains_term(value)) {
        return clip_excerpt(decision, 240);
    }
    if contains_term(&entry.goal) && !entry.goal.trim().is_empty() {
        return clip_excerpt(&entry.goal, 240);
    }
    if let Some(line) = entry.notes.lines().find(|value| contains_term(value)) {
        return clip_excerpt(line, 240);
    }
    clip_excerpt(&entry.goal, 240)
}

/// Deterministic local retrieval over reviewed Project Memory. The Markdown
/// files remain authoritative; this ranking is intentionally dependency-free
/// so the first engine slice works offline and can later sit behind an FTS or
/// embedding index without changing the Tool/MCP contract.
pub(crate) fn search_workspace_memory(
    workspace: &Workspace,
    query: &str,
    kinds: &[MemoryKind],
    limit: usize,
    include_inactive: bool,
) -> Result<Vec<MemorySearchHit>, String> {
    let terms = search_terms(query);
    if terms.is_empty() {
        return Err("Memory search query is required.".to_string());
    }

    let entries = list_workspace_memory(workspace, 500)?;
    // Supersession is enforced at write time by demoting the target, but the
    // store is hand-editable — honor the pointers too, so an entry any other
    // entry claims to supersede stays out of normal recall regardless of what
    // its own frontmatter says.
    let superseded_ids: BTreeSet<String> = entries
        .iter()
        .filter_map(|entry| entry.supersedes.clone())
        .collect();
    let mut hits = Vec::new();
    for entry in entries {
        if !include_inactive
            && (entry.review_state != MemoryReviewState::Reviewed
                || superseded_ids.contains(&entry.id))
        {
            continue;
        }
        if !kinds.is_empty() && !kinds.contains(&entry.kind) {
            continue;
        }

        let mut covered = vec![false; terms.len()];
        let mut score = 0;
        let mut matched_fields = BTreeSet::new();
        field_matches(
            "title",
            &entry.title,
            10,
            &terms,
            &mut covered,
            &mut score,
            &mut matched_fields,
        );
        field_matches(
            "goal",
            &entry.goal,
            8,
            &terms,
            &mut covered,
            &mut score,
            &mut matched_fields,
        );
        field_matches(
            "notes",
            &entry.notes,
            3,
            &terms,
            &mut covered,
            &mut score,
            &mut matched_fields,
        );
        field_matches(
            "runId",
            entry.run_id.as_deref().unwrap_or(""),
            6,
            &terms,
            &mut covered,
            &mut score,
            &mut matched_fields,
        );
        for decision in &entry.decisions {
            field_matches(
                "decisions",
                decision,
                7,
                &terms,
                &mut covered,
                &mut score,
                &mut matched_fields,
            );
        }
        for file in &entry.files_touched {
            field_matches(
                "filesTouched",
                file,
                6,
                &terms,
                &mut covered,
                &mut score,
                &mut matched_fields,
            );
        }
        for tag in &entry.tags {
            field_matches(
                "tags",
                tag,
                6,
                &terms,
                &mut covered,
                &mut score,
                &mut matched_fields,
            );
        }
        for source in &entry.source_refs {
            field_matches(
                "sourceRefs",
                &source.id,
                5,
                &terms,
                &mut covered,
                &mut score,
                &mut matched_fields,
            );
            if let Some(label) = &source.label {
                field_matches(
                    "sourceRefs",
                    label,
                    5,
                    &terms,
                    &mut covered,
                    &mut score,
                    &mut matched_fields,
                );
            }
        }

        // Every query term must be grounded somewhere in the same memory. This
        // keeps broad prompts from returning attractive but incomplete notes.
        if covered.iter().all(|matched| *matched) {
            hits.push(MemorySearchHit {
                excerpt: search_excerpt(&entry, &terms),
                entry,
                score,
                matched_fields: matched_fields.into_iter().collect(),
            });
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.entry.created_at_ms.cmp(&a.entry.created_at_ms))
            .then_with(|| a.entry.id.cmp(&b.entry.id))
    });
    hits.truncate(limit.clamp(1, 20));
    Ok(hits)
}

fn valid_memory_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 180
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

pub(crate) fn read_workspace_memory_entry(
    workspace: &Workspace,
    id: &str,
) -> Result<(MemoryEntry, String), String> {
    if !valid_memory_id(id) {
        return Err("Memory id must contain only letters, numbers, '-' or '_'.".to_string());
    }
    let hop = resolve_memory_workspace(workspace);
    let workspace = hop.as_ref().unwrap_or(workspace);
    let dir = workspace
        .resolve_existing(".klide/memory")
        .map_err(|_| "This workspace has no Project Memory store yet.".to_string())?;
    let rel_path = format!(".klide/memory/{id}.md");
    let path = workspace.resolve_existing(&rel_path)?;
    if !path.starts_with(&dir) || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err("Memory file is outside .klide/memory".to_string());
    }
    let entry = parse_entry_from_file(&path, workspace.root())
        .ok_or_else(|| format!("Unable to parse Project Memory `{id}`."))?;
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("Unable to read memory file: {e}"))?;
    Ok((entry, raw))
}

#[tauri::command]
pub async fn memory_read(workspace_root: String, rel_path: String) -> Result<String, String> {
    crate::blocking::run(move || read_memory(workspace_root, rel_path)).await
}

/// Synchronous body of `memory_read` — the interface the tests use.
pub fn read_memory(workspace_root: String, rel_path: String) -> Result<String, String> {
    let base = Workspace::new(&workspace_root)?;
    let hop = resolve_memory_workspace(&base);
    let workspace = hop.as_ref().unwrap_or(&base);
    let dir = workspace
        .resolve_existing(".klide/memory")
        .map_err(|_| "This workspace has no Project Memory store yet.".to_string())?;
    let path = workspace.resolve_existing(&rel_path)?;
    if !path.starts_with(&dir) || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err("Memory file is outside .klide/memory".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Unable to read memory file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        list_memory, read_memory, parse_entry_from_file, render_markdown, search_workspace_memory,
        MemoryEntry, MemoryKind, MemoryReviewState, MemorySourceRef, MemorySourceType,
        MEMORY_SCHEMA_VERSION,
    };
    use crate::workspace::Workspace;

    fn sample_entry(id: &str, title: &str) -> MemoryEntry {
        MemoryEntry {
            schema_version: MEMORY_SCHEMA_VERSION,
            id: id.to_string(),
            path: String::new(),
            rel_path: format!(".klide/memory/{id}.md"),
            created_at_ms: 1_786_000_000_000,
            date_iso: "2026-08-06T00:00:00Z".to_string(),
            title: title.to_string(),
            kind: MemoryKind::Handoff,
            review_state: MemoryReviewState::Reviewed,
            tags: Vec::new(),
            source_refs: Vec::new(),
            supersedes: None,
            goal: String::new(),
            plan: Vec::new(),
            decisions: Vec::new(),
            files_touched: Vec::new(),
            next_steps: Vec::new(),
            notes: String::new(),
            run_id: None,
            provider: None,
            model: None,
            mode: None,
            status: None,
        }
    }

    fn write_entry(root: &std::path::Path, mut entry: MemoryEntry) {
        let path = root.join(".klide/memory").join(format!("{}.md", entry.id));
        entry.path = path.to_string_lossy().to_string();
        std::fs::write(path, render_markdown(&entry)).unwrap();
    }

    #[test]
    fn schema_metadata_and_provenance_round_trip_through_markdown() {
        let base = std::env::temp_dir().join(format!("klide-memory-schema-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(".klide/memory")).unwrap();

        let mut entry = sample_entry("decision-permission", "Keep permission in Rust");
        entry.kind = MemoryKind::Decision;
        entry.tags = vec!["harness".to_string(), "trust".to_string()];
        entry.source_refs = vec![MemorySourceRef {
            source_type: MemorySourceType::Run,
            id: "run-123".to_string(),
            label: Some("Permission refactor".to_string()),
            path: Some("src-tauri/src/agent/permission.rs".to_string()),
            line_start: Some(40),
            line_end: Some(88),
        }];
        entry.supersedes = Some("decision-old-gate".to_string());
        write_entry(&base, entry);

        let path = base.join(".klide/memory/decision-permission.md");
        let parsed = parse_entry_from_file(&path, &base).unwrap();
        assert_eq!(parsed.schema_version, MEMORY_SCHEMA_VERSION);
        assert_eq!(parsed.kind, MemoryKind::Decision);
        assert_eq!(parsed.review_state, MemoryReviewState::Reviewed);
        assert_eq!(parsed.tags, ["harness", "trust"]);
        assert_eq!(parsed.source_refs.len(), 1);
        assert_eq!(parsed.source_refs[0].id, "run-123");
        assert_eq!(parsed.supersedes.as_deref(), Some("decision-old-gate"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_future_schema_is_not_read_as_v1() {
        let base = std::env::temp_dir().join(format!(
            "klide-memory-future-schema-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(".klide/memory")).unwrap();
        let path = base.join(".klide/memory/future.md");
        std::fs::write(
            &path,
            "---\nschemaVersion: 2\ntitle: Future knowledge\n---\n\n# Goal\n\nDo not misread this.\n",
        )
        .unwrap();

        // Future entries surface as inert stubs: visible, stale (never in
        // normal recall), body uninterpreted — not silently skipped.
        let stub = parse_entry_from_file(&path, &base).unwrap();
        assert_eq!(stub.schema_version, 2);
        assert_eq!(stub.review_state, MemoryReviewState::Stale);
        assert!(stub.goal.is_empty(), "future body must not be interpreted");
        assert!(stub.notes.contains("Unreadable"));

        // A version we can't even parse is a shape we don't know — future,
        // never coerced back to v1.
        std::fs::write(&path, "---\nschemaVersion: 2.0\ntitle: Odd\n---\n\n# Goal\n\nNope.\n")
            .unwrap();
        let stub = parse_entry_from_file(&path, &base).unwrap();
        assert!(stub.schema_version > MEMORY_SCHEMA_VERSION);
        assert_eq!(stub.review_state, MemoryReviewState::Stale);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unknown_review_state_or_kind_fails_closed_to_stale() {
        let base = std::env::temp_dir().join(format!(
            "klide-memory-fail-closed-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(".klide/memory")).unwrap();
        let path = base.join(".klide/memory/typo.md");
        std::fs::write(
            &path,
            "---\ntitle: Typo state\nkind: decision\nreviewState: super-seded\n---\n\n# Goal\n\nStill evidence.\n",
        )
        .unwrap();
        let entry = parse_entry_from_file(&path, &base).unwrap();
        assert_eq!(entry.review_state, MemoryReviewState::Stale);

        std::fs::write(
            &path,
            "---\ntitle: Unknown kind\nkind: experimental\nreviewState: reviewed\n---\n\n# Goal\n\nStill evidence.\n",
        )
        .unwrap();
        let entry = parse_entry_from_file(&path, &base).unwrap();
        assert_eq!(entry.review_state, MemoryReviewState::Stale);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn repeated_titles_preserve_both_memory_entries() {
        let base = std::env::temp_dir().join(format!("klide-memory-repeated-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let root = base.to_string_lossy().to_string();
        let input = |notes: &str| serde_json::from_value(serde_json::json!({
            "title": "Same title", "notes": notes
        })).unwrap();
        let first = super::write_memory(root.clone(), input("first note")).unwrap();
        let second = super::write_memory(root, input("second note")).unwrap();
        assert_ne!(first.id, second.id);
        assert!(std::fs::read_to_string(&first.path).unwrap().contains("first note"));
        assert!(std::fs::read_to_string(&second.path).unwrap().contains("second note"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn writing_a_superseding_entry_demotes_the_target_and_hides_it_from_recall() {
        let base = std::env::temp_dir().join(format!(
            "klide-memory-supersede-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(".klide/memory")).unwrap();

        let mut old = sample_entry("decision-old-gate", "Permission gate architecture");
        old.kind = MemoryKind::Decision;
        old.goal = "Gate every command in the frontend".to_string();
        write_entry(&base, old);

        let root = base.to_string_lossy().to_string();
        let written = super::write_memory(
            root.clone(),
            super::MemoryInput {
                title: "Permission gate architecture (revised)".to_string(),
                kind: MemoryKind::Decision,
                tags: Vec::new(),
                source_refs: Vec::new(),
                supersedes: Some("decision-old-gate".to_string()),
                goal: "Gate every command in the Rust permission engine".to_string(),
                plan: Vec::new(),
                decisions: Vec::new(),
                files_touched: Vec::new(),
                next_steps: Vec::new(),
                notes: String::new(),
                run_id: None,
                provider: None,
                model: None,
                mode: None,
                status: None,
            },
        )
        .unwrap();
        assert_eq!(written.supersedes.as_deref(), Some("decision-old-gate"));

        // The target's own frontmatter was demoted in place…
        let old_raw =
            std::fs::read_to_string(base.join(".klide/memory/decision-old-gate.md")).unwrap();
        assert!(old_raw.contains("reviewState: superseded"), "{old_raw}");
        // …and normal recall returns only the correction.
        let workspace = Workspace::new(base.to_str().unwrap()).unwrap();
        let hits =
            search_workspace_memory(&workspace, "permission gate architecture", &[], 5, false)
                .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.id, written.id);
        // The evidence stays inspectable on request.
        let all =
            search_workspace_memory(&workspace, "permission gate architecture", &[], 5, true)
                .unwrap();
        assert_eq!(all.len(), 2);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn memory_write_rejects_or_neutralizes_frontmatter_injection() {
        let base = std::env::temp_dir().join(format!(
            "klide-memory-injection-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let root = base.to_string_lossy().to_string();

        // A supersedes value that isn't an id is refused outright.
        let refused = super::write_memory(
            root.clone(),
            super::MemoryInput {
                title: "Injection".to_string(),
                kind: MemoryKind::Handoff,
                tags: Vec::new(),
                source_refs: Vec::new(),
                supersedes: Some("old-id\nreviewState: stale".to_string()),
                goal: String::new(),
                plan: Vec::new(),
                decisions: Vec::new(),
                files_touched: Vec::new(),
                next_steps: Vec::new(),
                notes: String::new(),
                run_id: None,
                provider: None,
                model: None,
                mode: None,
                status: None,
            },
        );
        assert!(refused.is_err());

        // A newline smuggled into a free string renders as a single sane line.
        let written = super::write_memory(
            root,
            super::MemoryInput {
                title: "Sneaky\nreviewState: stale".to_string(),
                kind: MemoryKind::Handoff,
                tags: Vec::new(),
                source_refs: Vec::new(),
                supersedes: None,
                goal: String::new(),
                plan: Vec::new(),
                decisions: Vec::new(),
                files_touched: Vec::new(),
                next_steps: Vec::new(),
                notes: String::new(),
                run_id: None,
                provider: None,
                model: None,
                mode: None,
                status: None,
            },
        )
        .unwrap();
        let parsed =
            parse_entry_from_file(std::path::Path::new(&written.path), &base).unwrap();
        assert_eq!(parsed.review_state, MemoryReviewState::Reviewed);
        assert!(!parsed.title.contains('\n'));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn search_is_unicode_aware_for_accented_queries_and_content() {
        let base =
            std::env::temp_dir().join(format!("klide-memory-unicode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(".klide/memory")).unwrap();

        let mut entry = sample_entry("decision-memoire", "DÉCISION d'architecture MÉMOIRE");
        entry.kind = MemoryKind::Decision;
        entry.goal = "Garder la mémoire du projet en Markdown".to_string();
        write_entry(&base, entry);

        let workspace = Workspace::new(base.to_str().unwrap()).unwrap();
        let hits =
            search_workspace_memory(&workspace, "décision mémoire", &[], 5, false).unwrap();
        assert_eq!(hits.len(), 1, "accented terms must match case-insensitively");
        assert_eq!(hits[0].entry.id, "decision-memoire");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn listing_never_creates_the_store_and_worktree_runs_hop_to_the_main_checkout() {
        let base =
            std::env::temp_dir().join(format!("klide-memory-worktree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("project");
        let worktree = base.join("project-worktrees/run-1");

        // A read on a fresh workspace stays a read: no .klide/memory appears.
        std::fs::create_dir_all(&main).unwrap();
        assert!(list_memory(main.to_string_lossy().to_string(), None)
            .unwrap()
            .is_empty());
        assert!(
            !main.join(".klide/memory").exists(),
            "listing must not create the store"
        );

        // Shape of a linked git worktree: main has a .git dir, the worktree a
        // .git *file* pointing at <main>/.git/worktrees/<name>.
        std::fs::create_dir_all(main.join(".git/worktrees/run-1")).unwrap();
        std::fs::create_dir_all(main.join(".klide/memory")).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!(
                "gitdir: {}\n",
                main.join(".git/worktrees/run-1").to_string_lossy()
            ),
        )
        .unwrap();

        let mut entry = sample_entry("decision-shared", "Shared recall architecture");
        entry.kind = MemoryKind::Decision;
        entry.goal = "One durable store for every run".to_string();
        write_entry(&main, entry);

        // Recall from inside the worktree sees the main checkout's store…
        let listed = list_memory(worktree.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "decision-shared");
        assert!(
            !worktree.join(".klide").exists(),
            "the worktree must not grow a stray store"
        );
        // …and a write from inside the worktree lands in the main store.
        let written = super::write_memory(
            worktree.to_string_lossy().to_string(),
            super::MemoryInput {
                title: "Worktree handoff".to_string(),
                kind: MemoryKind::Handoff,
                tags: Vec::new(),
                source_refs: Vec::new(),
                supersedes: None,
                goal: String::new(),
                plan: Vec::new(),
                decisions: Vec::new(),
                files_touched: Vec::new(),
                next_steps: Vec::new(),
                notes: String::new(),
                run_id: None,
                provider: None,
                model: None,
                mode: None,
                status: None,
            },
        )
        .unwrap();
        assert!(std::path::Path::new(&written.path).starts_with(
            std::fs::canonicalize(&main).unwrap()
        ));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn local_search_requires_every_term_and_hides_inactive_memory() {
        let base = std::env::temp_dir().join(format!("klide-memory-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join(".klide/memory")).unwrap();

        let mut decision = sample_entry("decision-permission", "Permission architecture");
        decision.kind = MemoryKind::Decision;
        decision.goal = "Keep the permission boundary in the Rust Harness".to_string();
        decision.decisions = vec!["Renderer input never grants command trust".to_string()];
        decision.files_touched = vec!["src-tauri/src/agent/permission.rs".to_string()];
        decision.source_refs = vec![MemorySourceRef {
            source_type: MemorySourceType::Run,
            id: "run-permission".to_string(),
            ..MemorySourceRef::default()
        }];
        write_entry(&base, decision);

        let mut partial = sample_entry("handoff-permission", "Permission cleanup");
        partial.goal = "Polish the settings copy".to_string();
        write_entry(&base, partial);

        let mut stale = sample_entry("failure-permission", "Permission architecture failure");
        stale.kind = MemoryKind::Failure;
        stale.review_state = MemoryReviewState::Stale;
        stale.goal = "An obsolete failure report".to_string();
        write_entry(&base, stale);

        let workspace = Workspace::new(base.to_str().unwrap()).unwrap();
        let hits =
            search_workspace_memory(&workspace, "permission architecture", &[], 5, false).unwrap();
        assert_eq!(hits.len(), 1, "both terms must land in one active memory");
        assert_eq!(hits[0].entry.id, "decision-permission");
        assert!(hits[0].matched_fields.contains(&"title".to_string()));
        assert_eq!(hits[0].entry.source_refs[0].id, "run-permission");

        let inactive = search_workspace_memory(
            &workspace,
            "permission architecture failure",
            &[MemoryKind::Failure],
            5,
            true,
        )
        .unwrap();
        assert_eq!(inactive.len(), 1);
        assert_eq!(inactive[0].entry.review_state, MemoryReviewState::Stale);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn memory_read_stays_beneath_memory_dir() {
        let base =
            std::env::temp_dir().join(format!("klide-memory-security-{}", std::process::id()));
        let workspace = base.join("workspace");
        let memory_dir = workspace.join(".klide").join("memory");
        let outside = base.join("outside.txt");
        let other_workspace_file = workspace.join("notes.txt");
        let memory_file = memory_dir.join("handoff.md");

        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&memory_dir).unwrap();
        std::fs::write(&outside, "outside").unwrap();
        std::fs::write(&other_workspace_file, "workspace").unwrap();
        std::fs::write(&memory_file, "memory").unwrap();

        let root = workspace.to_string_lossy().to_string();
        assert_eq!(
            read_memory(root.clone(), ".klide/memory/handoff.md".to_string()).unwrap(),
            "memory"
        );
        assert!(read_memory(root.clone(), "../outside.txt".to_string()).is_err());
        assert!(read_memory(root.clone(), "notes.txt".to_string()).is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, memory_dir.join("leak.md")).unwrap();
            assert!(
                list_memory(root, None)
                    .unwrap()
                    .iter()
                    .all(|entry| entry.id != "leak"),
                "memory listing must not follow a symlink outside the workspace"
            );
        }

        let _ = std::fs::remove_dir_all(&base);
    }
}
