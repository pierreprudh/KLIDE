use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A single memory entry — one per handoff / summary. Stored as a markdown
/// file with a YAML-ish frontmatter block at the top so the file is
/// self-describing and grep-friendly.
///
/// Layout (single line per frontmatter key, blank line, then markdown body):
/// ```text
/// ---
/// date: 2026-06-07T19:30:00Z
/// runId: ses_abc123
/// provider: klide
/// model: llama3.1:8b
/// mode: plan
/// status: done
/// title: Add Mission Control v2
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

/// Input shape for `memory_write`. Same fields as `MemoryEntry` minus the
/// derived ones (`id`, `path`, `relPath`, `createdAtMs`, `dateIso`) — the
/// Rust side fills those in from the workspace + clock.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    pub title: String,
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

fn memory_dir(workspace_root: &str) -> Result<PathBuf, String> {
    let dir = Path::new(workspace_root).join(".klide").join("memory");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Unable to create .klide/memory directory: {e}"))?;
    Ok(dir)
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

fn render_markdown(entry: &MemoryEntry) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("date: {}\n", entry.date_iso));
    if let Some(v) = opt_str(&entry.run_id) {
        out.push_str(&format!("runId: {v}\n"));
    }
    if let Some(v) = opt_str(&entry.provider) {
        out.push_str(&format!("provider: {v}\n"));
    }
    if let Some(v) = opt_str(&entry.model) {
        out.push_str(&format!("model: {v}\n"));
    }
    if let Some(v) = opt_str(&entry.mode) {
        out.push_str(&format!("mode: {v}\n"));
    }
    if let Some(v) = opt_str(&entry.status) {
        out.push_str(&format!("status: {v}\n"));
    }
    out.push_str(&format!("title: {}\n", entry.title));
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

fn parse_entry_from_file(path: &Path, workspace_root: &str) -> Option<MemoryEntry> {
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
    let mut date_iso = String::new();
    let mut run_id = None;
    let mut provider = None;
    let mut model = None;
    let mut mode = None;
    let mut status = None;
    let mut title = String::new();

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
                    "date" => date_iso = value,
                    "runId" => run_id = Some(value),
                    "provider" => provider = Some(value),
                    "model" => model = Some(value),
                    "mode" => mode = Some(value),
                    "status" => status = Some(value),
                    "title" => title = value,
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
        id,
        path: path.to_string_lossy().to_string(),
        rel_path,
        created_at_ms,
        date_iso,
        title,
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
    let doy =
        ((153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1) as u64;
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

#[tauri::command]
pub fn memory_write(workspace_root: String, input: MemoryInput) -> Result<MemoryEntry, String> {
    let dir = memory_dir(&workspace_root)?;
    let created = now_ms();
    let date_iso = iso_date(created);
    let stem = format!("{}-{}", date_stamp(created), slugify(&input.title));
    let path = dir.join(format!("{stem}.md"));

    let entry = MemoryEntry {
        id: stem,
        path: path.to_string_lossy().to_string(),
        rel_path: format!(
            ".klide/memory/{}.md",
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("")
        ),
        created_at_ms: created,
        date_iso,
        title: input.title,
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
    std::fs::write(&path, body).map_err(|e| format!("Unable to write memory entry: {e}"))?;
    Ok(entry)
}

#[tauri::command]
pub fn memory_list(
    workspace_root: String,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    let dir = memory_dir(&workspace_root)?;
    let mut entries = Vec::new();
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(entries),
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Some(parsed) = parse_entry_from_file(&path, &workspace_root) {
            entries.push(parsed);
        }
    }
    entries.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(entries.into_iter().take(limit.unwrap_or(50)).collect())
}

#[tauri::command]
pub fn memory_read(workspace_root: String, rel_path: String) -> Result<String, String> {
    let path = Path::new(&workspace_root).join(&rel_path);
    std::fs::read_to_string(&path).map_err(|e| format!("Unable to read memory file: {e}"))
}
