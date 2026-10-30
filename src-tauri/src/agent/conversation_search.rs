//! Workspace-scoped search over prior Klide Harness Conversations.
//!
//! The Transcript is the durable source of what a Conversation contained, so
//! search reads JSONL events rather than the browser's bounded localStorage
//! index. Results deliberately include user/assistant prose and compaction
//! summaries only: tool outputs are often huge, noisy, and may contain file
//! contents that the user did not mean by "what did we discuss?".

use super::transcripts::{list_summaries, read_events, read_summary, validate_run_id};
use super::types::{AgentContentBlock, AgentEvent};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Bound one query so an old installation with years of Transcripts cannot
/// turn a model tool call into an unbounded disk scan.
const MAX_SCANNED_CONVERSATIONS: usize = 500;
const MAX_SNIPPET_CHARS: usize = 320;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSearchMatch {
    pub conversation_id: String,
    pub title: String,
    pub role: String,
    pub snippet: String,
    pub match_count: usize,
    pub updated_ms: i64,
    #[serde(skip)]
    score: usize,
}

#[derive(Clone)]
struct SearchSegment {
    role: &'static str,
    text: String,
}

/// Search recent, top-level Klide Conversations from `workspace_root`, newest
/// metadata first and relevance-ranked after their Transcripts are read.
/// `current_run_id` is excluded so the tool does not rediscover the question
/// that invoked it and present that as historical evidence.
pub fn search_conversations(
    runs_dir: &Path,
    workspace_root: &Path,
    current_run_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<ConversationSearchMatch>, String> {
    let phrase = normalize_text(query);
    if phrase.is_empty() {
        return Err("search_conversations requires a non-empty query.".to_string());
    }
    let terms = search_terms(query);
    let summaries = list_summaries(runs_dir, Some(MAX_SCANNED_CONVERSATIONS), None)?;
    let mut matches = Vec::new();

    for summary in summaries {
        if summary.id == current_run_id || summary.parent_id.is_some() {
            continue;
        }
        let Some(cwd) = summary.cwd.as_deref() else {
            continue;
        };
        if !same_workspace(cwd, workspace_root) {
            continue;
        }
        // Search is best-effort across independent records. One corrupt old
        // Transcript must not hide every healthy match from the user.
        let Ok(events) = read_events(runs_dir, &summary.id) else {
            continue;
        };
        let mut segments = searchable_segments(&events);
        if archive_path(runs_dir, &summary.id).is_ok_and(|path| path.exists()) {
            if let Ok(imported) = load_history(runs_dir, workspace_root, &summary.id, false) {
                segments.splice(
                    0..0,
                    imported.into_iter().map(|m| SearchSegment {
                        role: if m.role == "user" {
                            "user"
                        } else {
                            "assistant"
                        },
                        text: m.text,
                    }),
                );
            }
        }
        let title = conversation_title(&segments, &summary.title);
        let title_normalized = normalize_text(&title);
        let title_matches = text_matches(&title_normalized, &phrase, &terms);

        let mut best: Option<(usize, &SearchSegment)> = None;
        let mut match_count = 0;
        for segment in &segments {
            let normalized = normalize_text(&segment.text);
            if !text_matches(&normalized, &phrase, &terms) {
                continue;
            }
            match_count += 1;
            let exact_phrase = normalized.contains(&phrase);
            let role_score = match segment.role {
                "user" => 30,
                "assistant" => 15,
                _ => 5,
            };
            let score =
                usize::from(exact_phrase) * 100 + usize::from(title_matches) * 40 + role_score;
            if best
                .as_ref()
                .is_none_or(|(best_score, _)| score > *best_score)
            {
                best = Some((score, segment));
            }
        }
        let Some((score, segment)) = best else {
            continue;
        };
        let updated_ms = events
            .last()
            .map(AgentEvent::ts)
            .unwrap_or(summary.updated_ms);
        matches.push(ConversationSearchMatch {
            conversation_id: summary.id,
            title,
            role: segment.role.to_string(),
            snippet: snippet_around_terms(&segment.text, &terms),
            match_count,
            updated_ms,
            score,
        });
    }

    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.updated_ms.cmp(&a.updated_ms))
            .then_with(|| a.conversation_id.cmp(&b.conversation_id))
    });
    matches.truncate(limit);
    Ok(matches)
}

// Imported conversations are not provider context. Keep their exact prose in
// a private, durable sidecar and expose bounded search/read through both doors.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Archive {
    schema_version: u8,
    workspace: String,
    history: super::types::ConversationHistory,
}

fn archive_path(runs: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    validate_run_id(id)?;
    Ok(runs.join(format!("{id}.history.json")))
}

pub(super) fn store_history(
    runs: &Path,
    workspace: &Path,
    id: &str,
    history: super::types::ConversationHistory,
) -> Result<(), String> {
    let path = archive_path(runs, id)?;
    // A renderer-selected id must not attach a new workspace to another
    // workspace's existing Run, including one without an archive yet.
    if super::transcripts::transcript_path(runs, id).exists() {
        require_workspace(runs, workspace, id)?;
    }
    if history
        .messages
        .iter()
        .any(|m| !matches!(m.role.as_str(), "user" | "assistant"))
    {
        return Err("Imported history may contain user and assistant prose only.".into());
    }
    let archive = Archive {
        schema_version: 1,
        workspace: workspace.to_string_lossy().into(),
        history,
    };
    let bytes = serde_json::to_vec(&archive).map_err(|e| e.to_string())?;
    if bytes.len() > 8_000_000 {
        return Err("Imported conversation exceeds the 8 MB retrieval limit.".into());
    }
    std::fs::create_dir_all(runs).map_err(|e| e.to_string())?;
    if path.exists() {
        // A retry never replaces the original snapshot with a shorter one.
        load_history(runs, workspace, id, false)?;
        return Ok(());
    }
    crate::durable::write_atomic_private(&path, &bytes)
}

fn require_workspace(runs: &Path, workspace: &Path, id: &str) -> Result<(), String> {
    let summary = read_summary(runs, id)?;
    if !summary
        .cwd
        .as_deref()
        .is_some_and(|root| same_workspace(root, workspace))
    {
        return Err("Conversation belongs to another workspace.".into());
    }
    Ok(())
}

fn load_history(
    runs: &Path,
    workspace: &Path,
    id: &str,
    include_continuation: bool,
) -> Result<Vec<super::types::HistoryMessage>, String> {
    let path = archive_path(runs, id)?;
    match std::fs::read(path) {
        Ok(bytes) => {
            let archive: Archive = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Unreadable imported history: {e}"))?;
            if archive.schema_version != 1 {
                return Err("Unsupported imported history version.".into());
            }
            if !same_workspace(&archive.workspace, workspace) {
                return Err("Conversation belongs to another workspace.".into());
            }
            let mut messages = archive.history.messages;
            if include_continuation && super::transcripts::transcript_path(runs, id).exists() {
                require_workspace(runs, workspace, id)?;
                messages.extend(
                    searchable_segments(&read_events(runs, id)?)
                        .into_iter()
                        .map(|s| super::types::HistoryMessage {
                            role: s.role.into(),
                            text: s.text,
                        }),
                );
            }
            Ok(messages)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            require_workspace(runs, workspace, id)?;
            Ok(searchable_segments(&read_events(runs, id)?)
                .into_iter()
                .map(|s| super::types::HistoryMessage {
                    role: s.role.into(),
                    text: s.text,
                })
                .collect())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Search a specific conversation at message granularity, including the full
/// imported snapshot of the current conversation. General search remains
/// workspace-wide and excludes the current Run.
pub(super) fn search_history(
    runs: &Path,
    workspace: &Path,
    id: &str,
    query: &str,
    limit: usize,
    include_continuation: bool,
) -> Result<serde_json::Value, String> {
    let phrase = normalize_text(query);
    if phrase.is_empty() {
        return Err("Search query is required.".into());
    }
    let terms = search_terms(query);
    let messages = load_history(runs, workspace, id, include_continuation)?;
    let mut hits: Vec<_> = messages
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let normalized = normalize_text(&m.text);
            text_matches(&normalized, &phrase, &terms).then_some((
                i,
                m,
                normalized.contains(&phrase),
            ))
        })
        .collect();
    // Prefer exact phrases, then the most recent matching exchange.
    hits.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.0.cmp(&a.0)));
    let matches: Vec<_> = hits.into_iter().take(limit.clamp(1, 20))
        .map(|(i, m, _)| serde_json::json!({"message": i + 1, "role": m.role, "snippet": snippet_around_terms(&m.text, &terms)})).collect();
    Ok(
        serde_json::json!({"conversationId": id, "totalMessages": messages.len(), "matches": matches}),
    )
}

/// Page exact message text by character offset. Even a huge single-line
/// message remains fully retrievable, without ever flooding model context.
pub(super) fn read_history(
    runs: &Path,
    workspace: &Path,
    id: &str,
    message: usize,
    offset: usize,
    max_chars: usize,
    include_continuation: bool,
) -> Result<serde_json::Value, String> {
    let messages = load_history(runs, workspace, id, include_continuation)?;
    let item = message
        .checked_sub(1)
        .and_then(|i| messages.get(i))
        .ok_or("Message number is out of range (starts at 1).")?;
    let total = item.text.chars().count();
    if offset > total {
        return Err("Character offset is out of range.".into());
    }
    let text: String = item
        .text
        .chars()
        .skip(offset)
        .take(max_chars.clamp(1, 16_000))
        .collect();
    let end = offset + text.chars().count();
    Ok(
        serde_json::json!({"conversationId": id, "message": message, "role": item.role, "text": text,
        "offset": offset, "nextOffset": if end < total { Some(end) } else { None },
        "nextMessage": if message < messages.len() { Some(message + 1) } else { None }, "totalMessages": messages.len()}),
    )
}

fn same_workspace(recorded: &str, workspace_root: &Path) -> bool {
    std::fs::canonicalize(recorded)
        .map(|path| path == workspace_root)
        .unwrap_or_else(|_| {
            recorded.trim().trim_end_matches('/')
                == workspace_root.to_string_lossy().trim_end_matches('/')
        })
}

fn searchable_segments(events: &[AgentEvent]) -> Vec<SearchSegment> {
    let mut segments = Vec::new();
    for event in events {
        match event {
            AgentEvent::UserMessage { text, .. } if !text.trim().is_empty() => {
                segments.push(SearchSegment {
                    role: "user",
                    text: text.clone(),
                });
            }
            AgentEvent::AssistantMessage { content, .. } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        AgentContentBlock::Text { text } => Some(text.trim()),
                        _ => None,
                    })
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    segments.push(SearchSegment {
                        role: "assistant",
                        text,
                    });
                }
            }
            AgentEvent::ContextCompacted { summary, .. } if !summary.trim().is_empty() => {
                segments.push(SearchSegment {
                    role: "summary",
                    text: summary.clone(),
                });
            }
            _ => {}
        }
    }
    segments
}

fn conversation_title(segments: &[SearchSegment], fallback: &str) -> String {
    let candidate = segments
        .iter()
        .find(|segment| segment.role == "user")
        .map(|segment| segment.text.as_str())
        .unwrap_or(fallback);
    truncate_chars(&collapse_whitespace(candidate), 80)
}

fn normalize_text(text: &str) -> String {
    collapse_whitespace(text).to_lowercase()
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn search_terms(query: &str) -> Vec<String> {
    query
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn text_matches(text: &str, phrase: &str, terms: &[String]) -> bool {
    text.contains(phrase) || (!terms.is_empty() && terms.iter().all(|term| text.contains(term)))
}

fn snippet_around_terms(text: &str, terms: &[String]) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }
    let first_match = words.iter().position(|word| {
        let normalized = word.to_lowercase();
        terms.iter().any(|term| normalized.contains(term))
    });
    let start = first_match.unwrap_or(0).saturating_sub(12);
    let end = (start + 48).min(words.len());
    let mut snippet = truncate_chars(&words[start..end].join(" "), MAX_SNIPPET_CHARS);
    if start > 0 {
        snippet.insert_str(0, "… ");
    }
    if end < words.len() {
        snippet.push_str(" …");
    }
    snippet
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let prefix: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcripts::{append_event, transcript_path, write_summary};
    use crate::agent::types::{AgentMode, AgentRunSummary};

    fn sandbox(name: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "klide-conversation-search-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let runs = base.join("runs");
        let workspace = base.join("workspace");
        let other = base.join("other");
        std::fs::create_dir_all(&runs).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        (
            base,
            std::fs::canonicalize(workspace).unwrap(),
            std::fs::canonicalize(other).unwrap(),
        )
    }

    fn search_history(
        runs: &Path,
        workspace: &Path,
        id: &str,
        query: &str,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        super::search_history(runs, workspace, id, query, limit, false)
    }
    fn read_history(
        runs: &Path,
        workspace: &Path,
        id: &str,
        message: usize,
        offset: usize,
        max: usize,
    ) -> Result<serde_json::Value, String> {
        super::read_history(runs, workspace, id, message, offset, max, false)
    }

    fn imported() -> super::super::types::ConversationHistory {
        super::super::types::ConversationHistory {
            source: "Claude Code".into(),
            messages: vec![
                super::super::types::HistoryMessage {
                    role: "user".into(),
                    text: "Keep the violet widget constraint".into(),
                },
                super::super::types::HistoryMessage {
                    role: "assistant".into(),
                    text: "é🦀".repeat(12_000),
                },
            ],
        }
    }

    #[test]
    fn imported_history_is_searchable_and_pages_exact_unicode_without_loss() {
        let (base, workspace, other) = sandbox("archive");
        let runs = base.join("runs");
        store_history(&runs, &workspace, "imported", imported()).unwrap();
        let hit = search_history(&runs, &workspace, "imported", "violet widget", 3).unwrap();
        assert_eq!(hit["matches"][0]["message"], 1);
        let mut offset = 0;
        let mut full = String::new();
        loop {
            let page = read_history(&runs, &workspace, "imported", 2, offset, 999_999).unwrap();
            assert!(page["text"].as_str().unwrap().chars().count() <= 16_000);
            full.push_str(page["text"].as_str().unwrap());
            match page["nextOffset"].as_u64() {
                Some(next) => offset = next as usize,
                None => break,
            }
        }
        assert_eq!(full, imported().messages[1].text);
        assert!(search_history(&runs, &other, "imported", "violet", 3).is_err());
        assert!(read_history(&runs, &workspace, "../imported", 1, 0, 100).is_err());
        assert!(read_history(&runs, &workspace, "imported", 0, 0, 100).is_err());
        assert!(read_history(&runs, &workspace, "imported", 1, 9999, 100).is_err());
        // Repeating the initial request cannot replace its original archive.
        store_history(
            &runs,
            &workspace,
            "imported",
            super::super::types::ConversationHistory {
                source: "other".into(),
                messages: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            search_history(&runs, &workspace, "imported", "violet", 1).unwrap()["matches"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(archive_path(&runs, "imported").unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn imported_history_reaches_a_delegate_through_the_native_registry_and_bound_session() {
        use crate::coordination_bridge::{BridgeHooks, BridgeSession};
        let (base, workspace, other) = sandbox("archive-mcp");
        let runs = base.join("runs");
        store_history(&runs, &workspace, "imported", imported()).unwrap();
        let hook_runs = runs.clone();
        let hooks = BridgeHooks {
            history: Some(Box::new(move |session, name, input| {
                crate::coordination_bridge::execute_history(&hook_runs, session, name, input)
            })),
            ..BridgeHooks::silent()
        };
        let session = BridgeSession {
            run_id: "imported".into(),
            workspace_root: workspace.to_string_lossy().into(),
            terminal: false,
            secret_sha256: String::new(),
        };
        let store = crate::coordination::CoordinationStoreState::default();
        for (name, input) in [
            (
                "search_conversations",
                serde_json::json!({"conversationId":"current", "query":"violet"}),
            ),
            (
                "read_conversation",
                serde_json::json!({"conversationId":"current", "message":1}),
            ),
        ] {
            let native = crate::agent::tools::execute_read_only_tool_with_runs_dir(
                &session.workspace_root,
                &crate::agent::tools::NormalizedToolCall {
                    id: "native".into(),
                    name: name.into(),
                    input: input.clone(),
                },
                &session.run_id,
                &runs,
            );
            let request = crate::mcp_server::bridge_request_for(name, &input).unwrap();
            let reply =
                crate::coordination_bridge::execute(&store, &hooks, &session, request.clone());
            assert!(reply.ok, "{reply:?}");
            assert_eq!(reply.value.unwrap()["text"], native.content);
            let wrong_workspace = BridgeSession {
                workspace_root: other.to_string_lossy().into(),
                ..session.clone()
            };
            assert!(
                !crate::coordination_bridge::execute(&store, &hooks, &wrong_workspace, request).ok
            );
        }
        // Unconfigured hosts fail explicitly instead of silently reading elsewhere.
        let request =
            crate::mcp_server::bridge_request_for("read_conversation", &serde_json::json!({}))
                .unwrap();
        assert!(
            !crate::coordination_bridge::execute(&store, &BridgeHooks::silent(), &session, request)
                .ok
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn general_search_finds_imported_prose_and_read_falls_back_to_native_transcripts() {
        let (base, workspace, _) = sandbox("archive-general");
        let runs = base.join("runs");
        write_conversation(
            &runs,
            "old",
            &workspace,
            "new question",
            "new answer",
            10,
            None,
        );
        store_history(&runs, &workspace, "old", imported()).unwrap();
        assert_eq!(
            super::read_history(&runs, &workspace, "old", 3, 0, 100, true).unwrap()["text"],
            "new question"
        );
        assert!(read_history(&runs, &workspace, "old", 3, 0, 100).is_err());
        let matches = search_conversations(&runs, &workspace, "current", "violet", 3).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].conversation_id, "old");
        write_conversation(
            &runs,
            "native",
            &workspace,
            "native question",
            "native answer",
            12,
            None,
        );
        assert_eq!(
            read_history(&runs, &workspace, "native", 1, 0, 100).unwrap()["text"],
            "native question"
        );
        let other = base.join("other");
        write_conversation(
            &runs,
            "elsewhere",
            &other,
            "private question",
            "private answer",
            15,
            None,
        );
        assert!(store_history(&runs, &workspace, "elsewhere", imported()).is_err());
        // Corrupt archives are an explicit error, never an empty history.
        std::fs::write(archive_path(&runs, "old").unwrap(), b"broken").unwrap();
        assert!(search_history(&runs, &workspace, "old", "violet", 3).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    fn write_conversation(
        runs: &Path,
        id: &str,
        workspace: &Path,
        user: &str,
        assistant: &str,
        updated_ms: i64,
        parent_id: Option<&str>,
    ) {
        append_event(
            runs,
            id,
            0,
            &AgentEvent::RunStarted {
                run_id: id.to_string(),
                cwd: Some(workspace.to_string_lossy().to_string()),
                mode: AgentMode::Plan,
                provider: "ollama".to_string(),
                model: "test".to_string(),
                ts: updated_ms - 2,
            },
        )
        .unwrap();
        append_event(
            runs,
            id,
            1,
            &AgentEvent::UserMessage {
                run_id: id.to_string(),
                message_id: format!("{id}-user"),
                text: user.to_string(),
                attachments: Vec::new(),
                ts: updated_ms - 1,
            },
        )
        .unwrap();
        append_event(
            runs,
            id,
            2,
            &AgentEvent::AssistantMessage {
                run_id: id.to_string(),
                message_id: format!("{id}-assistant"),
                content: vec![AgentContentBlock::Text {
                    text: assistant.to_string(),
                }],
                usage: None,
                timing: None,
                ts: updated_ms,
            },
        )
        .unwrap();
        write_summary(
            runs,
            &AgentRunSummary {
                id: id.to_string(),
                path: transcript_path(runs, id).to_string_lossy().to_string(),
                source: "klide".to_string(),
                title: user.to_string(),
                status: "done".to_string(),
                provider: "ollama".to_string(),
                model: "test".to_string(),
                cwd: Some(workspace.to_string_lossy().to_string()),
                project: None,
                git_branch: None,
                created_ms: updated_ms - 2,
                updated_ms,
                message_count: 2,
                input_tokens: 0,
                output_tokens: 0,
                files_touched: 0,
                cost_usd: None,
                last_event: None,
                worktree: None,
                validation: None,
                parent_id: parent_id.map(str::to_string),
            },
        )
        .unwrap();
    }

    #[test]
    fn search_is_workspace_scoped_and_excludes_current_and_child_runs() {
        let (base, workspace, other) = sandbox("scope");
        let runs = base.join("runs");
        write_conversation(
            &runs,
            "old-conversation",
            &workspace,
            "How should refresh tokens work?",
            "Rotate them after every exchange.",
            100,
            None,
        );
        write_conversation(
            &runs,
            "current-conversation",
            &workspace,
            "Search refresh tokens",
            "This is the current run.",
            400,
            None,
        );
        write_conversation(
            &runs,
            "other-workspace",
            &other,
            "Refresh tokens elsewhere",
            "Not part of this project.",
            300,
            None,
        );
        write_conversation(
            &runs,
            "child-run",
            &workspace,
            "Investigate refresh tokens",
            "Child report.",
            200,
            Some("old-conversation"),
        );

        let matches = search_conversations(
            &runs,
            &workspace,
            "current-conversation",
            "refresh tokens",
            10,
        )
        .unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].conversation_id, "old-conversation");
        assert_eq!(matches[0].role, "user");
        assert!(matches[0].snippet.contains("refresh tokens"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn search_ranks_user_matches_and_respects_the_result_limit() {
        let (base, workspace, _) = sandbox("rank");
        let runs = base.join("runs");
        write_conversation(
            &runs,
            "assistant-match",
            &workspace,
            "Discuss session storage",
            "The refresh token belongs in the keychain.",
            300,
            None,
        );
        write_conversation(
            &runs,
            "user-match",
            &workspace,
            "Where should the refresh token live?",
            "Use the keychain.",
            100,
            None,
        );

        let matches =
            search_conversations(&runs, &workspace, "current", "refresh token", 1).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].conversation_id, "user-match");
        assert_eq!(matches[0].match_count, 1);
        let _ = std::fs::remove_dir_all(base);
    }
}
