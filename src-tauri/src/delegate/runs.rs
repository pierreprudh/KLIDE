// Run records and shared parsing helpers for the Delegate seam.
//
// Mission Control reads the local session logs that delegate CLIs leave on
// disk, so Klide can show your real recent runs across tools in one board:
//   • Claude Code → ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
//   • Codex       → ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//                   (+ ~/.codex/session_index.jsonl for human thread names)
//   • OpenCode    → SQLite at ~/.local/share/opencode/opencode.db
// Read-only: we never write to those files. Each adapter owns its own
// format; what's shared lives here.

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub path: String, // absolute path to the session log, for reading its transcript
    pub source: String, // "claude-code" | "codex" | "opencode"
    pub title: String,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub project: Option<String>, // last path segment of cwd
    pub git_branch: Option<String>,
    pub created_ms: i64, // 0 if unknown (external tools may not store creation time)
    pub updated_ms: i64,
    pub message_count: u32,
    // Real token usage summed from the session log (0 when the source doesn't
    // record usage). Input excludes cache reads — they'd dwarf everything else.
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub status: String, // "running" | "waiting" (blocked on user) | "done"
    /// Count of unique file paths the agent touched in tool calls (Read,
    /// Edit, Write, apply_patch, etc.). 0 when the source doesn't record
    /// tool calls or the session had no file-touching tools.
    pub files_touched: u32,
    /// Estimated run cost in USD, computed from input/output tokens and the
    /// per-model price table in `crate::pricing`. `None` for local,
    /// subscription, passthrough, or unknown models.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// Number of sub-agents this run spawned, counted from the transcript's
    /// own tool calls (Claude's `Agent` / `Task` tool). 0 when the source
    /// doesn't expose sub-agent calls or none ran. Distinct from `parent_id`,
    /// which links a run row to a separate parent session when that child log
    /// is discoverable (for example Claude's `subagents/*.jsonl` files).
    pub subagent_count: u32,
    /// One-line summary of the run's most recent assistant turn — "what it
    /// last did" — for the board's evidence line. The session title is the
    /// *first* user message, which goes stale on a long run; this answers
    /// "what changed?" at a glance. `None` when the source has no assistant
    /// turn yet or doesn't expose one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event: Option<String>,
    /// Name of the linked git worktree the run executed in, when `cwd` is a
    /// linked worktree rather than the repo's main checkout. `None` for runs in
    /// a main working copy (the common case) or outside a git repo. Derived from
    /// `cwd` in `list_agent_runs`; adapters leave it `None`. See [`worktree_label`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>, // set when we can infer parent from spawn mapping
    /// The CLI saved this session because Klide drove it headless for a
    /// conversation of its own (`delegate::chat`). That conversation is
    /// already a row, so the board leaves this copy out; following or
    /// resuming the session by id still finds it.
    #[serde(skip)]
    pub klide_hosted: bool,
}

/// Name of the linked git worktree at `cwd`, or `None` if `cwd` is a main
/// working copy / not a repo. Cheap by design — no `git` subprocess: a linked
/// worktree's `.git` is a *file* (a `gitdir: …/worktrees/<name>` pointer),
/// whereas a main checkout's `.git` is a directory. We stat `.git`, and only
/// when it's a file read it to recover the worktree name (falling back to the
/// `cwd` basename if the pointer is unparseable). One `stat` + at most one tiny
/// read per run — negligible against the session-log reads already happening.
/// Fill in a row's worktree evidence when it doesn't already carry one.
///
/// Both boards need this and both had their own copy — `list_agent_runs` for
/// Delegate rows and `agent_list_runs` for Harness rows — with a comment on the
/// second reading "evidence parity with the delegate board", i.e. keep these two
/// in step by hand. Derived rather than persisted, so historical runs pick it up
/// too.
pub(crate) fn fill_worktree_evidence(worktree: &mut Option<String>, cwd: Option<&str>) {
    if worktree.is_some() {
        return;
    }
    if let Some(cwd) = cwd {
        *worktree = worktree_label(cwd);
    }
}

pub(crate) fn worktree_label(cwd: &str) -> Option<String> {
    let dot_git = std::path::Path::new(cwd).join(".git");
    let meta = std::fs::metadata(&dot_git).ok()?;
    if !meta.is_file() {
        // A directory (main checkout) or absent → not a linked worktree.
        return None;
    }
    let pointer = std::fs::read_to_string(&dot_git).ok()?;
    // A linked worktree points at "…/.git/worktrees/<name>". Require that
    // marker so a submodule pointer ("…/.git/modules/<name>") doesn't match.
    pointer
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))
        .and_then(|p| p.trim().split("/worktrees/").nth(1))
        .and_then(|rest| rest.split('/').next())
        .map(str::to_string)
        .filter(|n| !n.is_empty())
}

// One readable line of a run's conversation, for the Mission Control detail
// pane. We strip system/context wrappers and tool plumbing so what shows is the
// actual back-and-forth (a "résumé" of the session).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMessage {
    pub role: String, // "user" | "assistant"
    pub text: String,
    /// Tool calls made during this turn, structured. Emitted directly by the
    /// adapters so the reader-facing Conversation no longer has to recover them
    /// from `[tool: <name>]` text markers. Omitted from the wire when empty
    /// (matches the frontend's optional `tools?` on RunMessage).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<RunToolCall>,
    /// Images sent in this turn, as self-contained `data:<mime>;base64,…` URIs
    /// recovered from the raw transcript (e.g. pasted screenshots). Kept so the
    /// conversation view can show the picture instead of a `[Image #N]` marker.
    /// Omitted from the wire when empty (matches the frontend's optional
    /// `images?`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

/// One tool call in a delegate run's conversation, with as much of the call as
/// a résumé view can honestly carry: what it was asked to do, and what came
/// back. A name on its own reads as eight identical "Bash" rows — true, and
/// useless.
///
/// `input` and `result` are *bounded* on the way in (`bounded_tool_input`,
/// `bounded_tool_result`). A Claude transcript inlines whole files and whole
/// command outputs; a reader needs the first line and the shape, and paying
/// tens of megabytes to show them would repeat the mistake `parse_run`'s
/// oversized-line guard exists to prevent.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunToolCall {
    pub name: String,
    /// The CLI's own id for the call (`tool_use_id`), used to match a result
    /// that arrives in a later message — and to key the rendered row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The call's arguments, as the CLI recorded them. The reader derives the
    /// row's one-line summary from this (`command`, `file_path`, `pattern`, …),
    /// so it is the raw object rather than a pre-rendered string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The head of what the tool returned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// False when the CLI marked the result an error (`is_error`). Absent when
    /// no result was found — unknown is not success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
}

/// How much of one tool's arguments to carry. Long string values are cut with
/// an ellipsis rather than dropped: the reader's summary comes from the *head*
/// of `command` or `file_path`, and a truncated path still identifies the file.
const MAX_TOOL_INPUT_VALUE: usize = 400;

/// How much of one tool's output to carry — enough for the collapsed first
/// line and a short expansion, not the whole file a `Read` returned.
const MAX_TOOL_RESULT: usize = 2000;

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

/// Bound a tool input for the wire: every string value is truncated, nested
/// objects and arrays are walked, everything else passes through. The shape is
/// preserved so the reader can still find `command` / `file_path` / `pattern`.
pub fn bounded_tool_input(input: &serde_json::Value) -> serde_json::Value {
    match input {
        serde_json::Value::String(s) => {
            serde_json::Value::String(truncate_chars(s, MAX_TOOL_INPUT_VALUE))
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(bounded_tool_input).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), bounded_tool_input(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Bound a tool result for the wire.
pub fn bounded_tool_result(result: &str) -> String {
    truncate_chars(result.trim(), MAX_TOOL_RESULT)
}

/// A run a delegate left on disk, before parsing: just enough to sort and
/// page. `key` is whatever the adapter's parser needs to find the run again —
/// a file path for the JSONL CLIs, a session id for OpenCode.
pub struct RunCandidate {
    pub key: String,
    pub mtime_ms: i64,
}

/// How much of a transcript's head to scan for session metadata. Every JSONL
/// delegate writes its `cwd` in the opening records, so this is enough to answer
/// "which project is this run?" — and small enough that asking it of every
/// candidate on disk stays cheap.
const HEAD_PROBE_BYTES: usize = 64 * 1024;

/// Pull a JSON string field out of a transcript's opening bytes without parsing
/// the file — or even a whole line. Codex's `session_meta` line embeds the full
/// base instructions, so it can run to tens of kilobytes; a needle search over a
/// bounded head read sidesteps that instead of deserializing it.
///
/// Returns `None` whenever the answer isn't cheaply available (unreadable file,
/// field absent from the head, or an escaped value we won't decode by hand).
/// Callers must treat `None` as "don't know", never as "doesn't match".
pub(crate) fn head_json_string(path: &std::path::Path, field: &str) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    // `take` + `read_to_end` rather than one `read`: a single read may come back
    // short, which would hide a `cwd` that is present and quietly cost us a parse.
    let mut buf = Vec::with_capacity(HEAD_PROBE_BYTES);
    file.take(HEAD_PROBE_BYTES as u64)
        .read_to_end(&mut buf)
        .ok()?;
    // A multi-byte character straddling the cut would fail a strict decode, so
    // decode lossily — the needle and the path around it are ASCII.
    let head = String::from_utf8_lossy(&buf);
    let needle = format!("\"{field}\":\"");
    let start = head.find(&needle)? + needle.len();
    let value = &head[start..];
    let end = value.find('"')?;
    let value = &value[..end];
    // A backslash means the value is escaped; decoding JSON escapes by hand is
    // how subtle bugs get in. Fall back to "don't know" and let the caller pay
    // for a real parse.
    (!value.contains('\\')).then(|| value.to_string())
}

/// Keep only the candidates whose transcript names `workspace_root` as its cwd.
///
/// This is the pre-filter that makes a workspace-scoped page affordable: without
/// it, matching a workspace requires fully parsing every run on disk, because
/// `cwd` only surfaces after the parse. A candidate whose cwd can't be read
/// cheaply is **kept** — over-including costs one wasted parse, while
/// under-including would silently drop a run off the board.
pub(crate) fn retain_candidates_in_workspace(
    candidates: Vec<RunCandidate>,
    workspace_root: &str,
) -> Vec<RunCandidate> {
    // A transcript's head is written once; remembering the probe per file
    // turns the board's 7.5 s tick from "open every candidate for 64 KB" into
    // a stat per candidate (file_memo.rs). A live session's file keeps moving
    // and keeps being re-probed, which is the right cost in the right place.
    static HEAD_CWD: crate::file_memo::FileMemo<Option<String>> = crate::file_memo::FileMemo::new();
    let want = super::normalize_path(workspace_root);
    candidates
        .into_iter()
        .filter(|c| {
            let path = std::path::Path::new(&c.key);
            match HEAD_CWD.get_or_compute(path, 0, |p| head_json_string(p, "cwd")) {
                Some(cwd) => super::normalize_path(&cwd) == want,
                None => true,
            }
        })
        .collect()
}

pub(crate) fn mtime_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn project_name(cwd: &str) -> Option<String> {
    std::path::Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
}

pub(crate) fn clean_title(s: &str) -> String {
    let one = s.split('\n').next().unwrap_or(s).trim();
    one.chars().take(120).collect()
}

/// How long a Delegate transcript may go without a write before the board reads
/// an otherwise-active run as finished.
///
/// Provider-specific transcript markers settle a completed turn immediately,
/// and Klide-hosted PTYs contribute hook/exit state at the aggregation seam.
/// Runs launched outside Klide still need a conservative fallback, so an active
/// transcript marker expires here. This window silently bounds the frontend's:
/// `STALE_RUNNING_MS` in `src/runs.ts` flags a *running* run as idle after five
/// minutes, which a Delegate can never reach — it has been relabelled `done`
/// here after two. `delegate_recency_window_bounds_the_frontend_idle_signal`
/// pins that relationship so the next person to change either number sees the
/// other one.
pub(crate) const DELEGATE_RECENCY_MS: i64 = 120_000;

/// The last provider-specific lifecycle fact found while reducing a transcript.
/// `Unknown` preserves the mtime fallback for formats/records we do not know;
/// `Working` is still bounded by recency so an interrupted external CLI cannot
/// remain active forever; `TurnComplete` settles immediately.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TranscriptState {
    Unknown,
    Working,
    TurnComplete,
}

fn transcript_status_at(now_ms: i64, updated_ms: i64, state: TranscriptState) -> String {
    if state == TranscriptState::TurnComplete {
        return "done".to_string();
    }
    if now_ms - updated_ms < DELEGATE_RECENCY_MS {
        "running".to_string()
    } else {
        "done".to_string()
    }
}

pub(crate) fn transcript_status(updated_ms: i64, state: TranscriptState) -> String {
    transcript_status_at(now_ms(), updated_ms, state)
}

// The first genuine user prompt becomes the run's title. Skips system/tool
// wrappers (content that begins with "<", e.g. "<command-name>…").
pub(crate) fn extract_user_text(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if !t.is_empty() && !t.starts_with('<') {
            Some(t.to_string())
        } else {
            None
        };
    }
    if let Some(arr) = content.as_array() {
        for part in arr {
            if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() && !t.starts_with('<') {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Heuristic: does this tool name + argument blob look like a file path the
/// agent touched? Returns the path if so, `None` otherwise. Conservative —
/// we only flag tools whose argument shape is unambiguous across the
/// providers we read from (Claude Code, Codex, OpenCode). Tools with fuzzy
/// argument shapes (Bash, shell_command, grep_files, apply_patch) are
/// intentionally skipped: matching them would either over-count or require
/// a per-tool parser we don't want to maintain here.
pub(crate) fn tool_file_path(name: &str, args: &serde_json::Value) -> Option<String> {
    // Recognise the canonical file-touching tool names. Case-insensitive to
    // survive provider / wire-format variations ("Read" vs "read" vs
    // "read_file"). Anything else returns None — we don't try to second-guess
    // tools we don't know.
    let n = name.to_ascii_lowercase();
    let is_file_tool = matches!(
        n.as_str(),
        "read"
            | "read_file"
            | "write"
            | "write_file"
            | "create_file"
            | "edit"
            | "edit_file"
            | "str_replace"
            | "str_replace_based_edit_tool"
            | "multi_edit"
            | "multiedit"
            | "notebookedit"
            | "notebook_edit"
    );
    if !is_file_tool {
        return None;
    }
    // The path key varies by tool: Read/Write/Edit use `file_path`, OpenCode
    // tools use `filePath`, some pass `path`. Try them in order.
    let raw = args
        .get("file_path")
        .or_else(|| args.get("filePath"))
        .or_else(|| args.get("filepath"))
        .or_else(|| args.get("path"))?;
    let trimmed = raw.as_str()?.trim();
    if trimmed.is_empty() {
        return None;
    }
    // A real file path has a separator. Reject bare words like "foo" or
    // glob patterns like "**/*.ts" that some grep tools use — those aren't
    // a single file the agent read.
    if !(trimmed.contains('/') || trimmed.contains('\\')) {
        return None;
    }
    Some(trimmed.to_string())
}

/// Bound a detail-pane payload: trim long messages, keep the most recent ~80.
pub(crate) fn cap_messages(msgs: &mut Vec<RunMessage>) {
    for m in msgs.iter_mut() {
        if m.text.chars().count() > 4000 {
            m.text = m.text.chars().take(4000).collect::<String>() + "…";
        }
    }
    let len = msgs.len();
    if len > 80 {
        msgs.drain(0..len - 80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_title_takes_first_line_capped() {
        let long = format!("{}\nsecond line", "x".repeat(200));
        let t = clean_title(&long);
        assert_eq!(t.chars().count(), 120);
        assert!(!t.contains('\n'));
    }

    #[test]
    fn user_text_skips_command_wrappers() {
        let wrapped = serde_json::json!({ "content": "<command-name>/clear</command-name>" });
        assert_eq!(extract_user_text(&wrapped), None);
        let plain = serde_json::json!({ "content": [{ "type": "text", "text": " fix it " }] });
        assert_eq!(extract_user_text(&plain).as_deref(), Some("fix it"));
    }

    #[test]
    fn tool_file_path_recognises_known_file_tools() {
        // Canonical snake_case keys.
        assert_eq!(
            tool_file_path("read", &serde_json::json!({ "file_path": "/src/a.rs" })),
            Some("/src/a.rs".to_string())
        );
        assert_eq!(
            tool_file_path("edit", &serde_json::json!({ "file_path": "src/b.ts" })),
            Some("src/b.ts".to_string())
        );
        // camelCase (OpenCode).
        assert_eq!(
            tool_file_path("read", &serde_json::json!({ "filePath": "x/y.md" })),
            Some("x/y.md".to_string())
        );
        // Bare `path` key (some Codex tools).
        assert_eq!(
            tool_file_path("write", &serde_json::json!({ "path": "./out.txt" })),
            Some("./out.txt".to_string())
        );
    }

    #[test]
    fn tool_file_path_rejects_unknown_tools_and_bad_values() {
        // Bash, shell_command, apply_patch — too ambiguous to count.
        assert_eq!(
            tool_file_path("bash", &serde_json::json!({ "file_path": "/a" })),
            None
        );
        assert_eq!(
            tool_file_path("shell_command", &serde_json::json!({ "file_path": "/a" })),
            None
        );
        assert_eq!(
            tool_file_path("apply_patch", &serde_json::json!({ "file_path": "/a" })),
            None
        );
        // No path key.
        assert_eq!(
            tool_file_path("read", &serde_json::json!({ "limit": 10 })),
            None
        );
        // Empty / whitespace path.
        assert_eq!(
            tool_file_path("read", &serde_json::json!({ "file_path": "" })),
            None
        );
        assert_eq!(
            tool_file_path("read", &serde_json::json!({ "file_path": "   " })),
            None
        );
        // Bare word without a separator (looks like a glob, not a file).
        assert_eq!(
            tool_file_path("read", &serde_json::json!({ "file_path": "foo" })),
            None
        );
    }

    #[test]
    fn worktree_label_reads_linked_worktree_pointer() {
        let dir = std::env::temp_dir().join("klide_wt_test_linked");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".git"),
            "gitdir: /Users/x/proj/.git/worktrees/feature-login\n",
        )
        .unwrap();
        assert_eq!(
            worktree_label(dir.to_str().unwrap()).as_deref(),
            Some("feature-login")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn worktree_label_none_for_main_checkout_and_submodule() {
        // Main checkout: .git is a directory.
        let main = std::env::temp_dir().join("klide_wt_test_main");
        let _ = std::fs::remove_dir_all(&main);
        std::fs::create_dir_all(main.join(".git")).unwrap();
        assert_eq!(worktree_label(main.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(&main);

        // Submodule: .git is a file, but points at modules/, not worktrees/.
        let sub = std::env::temp_dir().join("klide_wt_test_sub");
        let _ = std::fs::remove_dir_all(&sub);
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(".git"), "gitdir: ../.git/modules/vendor\n").unwrap();
        assert_eq!(worktree_label(sub.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(&sub);

        // No git at all.
        assert_eq!(worktree_label("/nonexistent/klide/path"), None);
    }

    #[test]
    fn cap_messages_trims_and_keeps_recent_80() {
        let mut msgs: Vec<RunMessage> = (0..100)
            .map(|i| RunMessage {
                role: "user".into(),
                text: format!("m{i}"),
                tools: vec![],
                images: vec![],
            })
            .collect();
        msgs[99].text = "y".repeat(5000);
        cap_messages(&mut msgs);
        assert_eq!(msgs.len(), 80);
        assert_eq!(msgs[0].text, "m20");
        assert_eq!(msgs[79].text.chars().count(), 4001); // 4000 + ellipsis
    }

    /// Read a numeric constant out of the frontend mirror.
    fn frontend_const(name: &str) -> i64 {
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/runs.ts"),
        )
        .expect("read src/runs.ts");
        let marker = format!("{name} = ");
        let start = ts
            .find(&marker)
            .unwrap_or_else(|| panic!("{name} in src/runs.ts"))
            + marker.len();
        let expr = &ts[start..start + ts[start..].find(';').expect("terminating ;")];
        // Values are written either plain (`120_000`) or as a product
        // (`5 * 60_000`); both spellings are legible, so accept both.
        expr.split('*')
            .map(|part| {
                part.trim()
                    .replace('_', "")
                    .parse::<i64>()
                    .unwrap_or_else(|_| panic!("{name} is not a numeric literal: {expr}"))
            })
            .product()
    }

    #[test]
    fn delegate_recency_window_bounds_the_frontend_idle_signal() {
        // Provider markers and hosted-PTY signals now settle known states, but
        // an otherwise-active Delegate transcript still expires here. The
        // frontend has a second authority: STALE_RUNNING_MS flags a *running*
        // run as idle. Because the fallback is relabelled `done` here first,
        // that signal remains unreachable for such a Delegate row.
        //
        // This test does not pretend that is fixed. It pins both numbers and the
        // relationship between them, so changing either one surfaces the other:
        // the idle signal reaches Delegates only once this window is the larger.
        assert_eq!(DELEGATE_RECENCY_MS, frontend_const("DELEGATE_RECENCY_MS"));

        let stale_running = frontend_const("STALE_RUNNING_MS");
        assert_eq!(stale_running, 300_000, "src/runs.ts STALE_RUNNING_MS moved");
        assert!(
            DELEGATE_RECENCY_MS < stale_running,
            "a Delegate is relabelled done after {DELEGATE_RECENCY_MS}ms, so the \
frontend's {stale_running}ms idle signal is unreachable for one. If this \
assertion now fails, the idle signal has become reachable for Delegates — \
which is the fix, not a regression: update this test and the comments on both \
constants."
        );
    }

    #[test]
    fn transcript_markers_settle_turns_but_bound_abandoned_work() {
        let now = 1_000_000;
        let fresh = now - 1_000;
        let stale = now - DELEGATE_RECENCY_MS;

        assert_eq!(
            transcript_status_at(now, fresh, TranscriptState::Working),
            "running"
        );
        assert_eq!(
            transcript_status_at(now, fresh, TranscriptState::TurnComplete),
            "done"
        );
        assert_eq!(
            transcript_status_at(now, stale, TranscriptState::Working),
            "done",
            "an external CLI interrupted mid-turn must not stay active forever"
        );
        assert_eq!(
            transcript_status_at(now, fresh, TranscriptState::Unknown),
            "running",
            "unknown formats preserve the prior recency fallback"
        );
    }
}
