//! Agent-authored lessons are pending review, never recallable knowledge.
//! Both native Tools and authenticated Delegate MCP use this single store.
use super::{MemoryEntry, MemoryInput, MemoryKind, MemorySourceRef, MemorySourceType};
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

const TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING: usize = 10;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    title: String,
    kind: MemoryKind,
    notes: String,
    why: String,
    evidence: Evidence,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    path: String,
    quote: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    #[serde(flatten)]
    pub input: MemoryInput,
    pub draft_id: String,
    pub created_at_ms: i64,
    pub workspace_root: String,
    pub why: String,
    pub evidence: String,
    pub evidence_hash: String,
    fingerprint: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store {
    pending: Vec<Proposal>,
    dismissed: Vec<String>,
    #[serde(default)]
    published: Vec<String>,
}

/// Lengths in characters, the unit the Tool's `maxLength` advertises — a
/// byte cap refused accented text the schema allowed.
fn bounded(value: &str, name: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(format!("{name} must contain 1–{max} characters."));
    }
    Ok(())
}

/// The entry an interrupted Keep already wrote: it carries the proposal id
/// as a source label. Found before either review path acts, so neither a
/// retry nor a Dismiss leaves a published lesson behind a cleared inbox.
fn prior_publication(ws: &Workspace, id: &str) -> Result<Option<MemoryEntry>, String> {
    Ok(super::list_memory(ws.root().to_string_lossy().into(), Some(500))?
        .into_iter()
        .find(|entry| entry.source_refs.iter().any(|r| r.label.as_deref() == Some(id))))
}

fn owner(root: &str) -> Result<Workspace, String> {
    let workspace = Workspace::new(root)?;
    Ok(super::resolve_memory_workspace(&workspace).unwrap_or(workspace))
}

fn state_path(ws: &Workspace) -> Result<PathBuf, String> {
    ws.resolve_new(".klide/memory-proposals/state.json")
}

fn read(ws: &Workspace) -> Result<Store, String> {
    let path = state_path(ws)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid memory proposal store: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(format!("Cannot read memory proposals: {e}")),
    }
}

fn update<T>(
    ws: &Workspace,
    action: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let dir = ws.resolve_new(".klide/memory-proposals")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let lock_path = ws.resolve_new(".klide/memory-proposals/state.lock")?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    let mut store = read(ws)?;
    store
        .pending
        .retain(|p| super::now_ms() - p.created_at_ms < TTL_MS);
    let result = action(&mut store)?;
    crate::durable::write_atomic_private(
        &state_path(ws)?,
        &serde_json::to_vec(&store).map_err(|e| e.to_string())?,
    )?;
    Ok(result)
}

/// Evidence must be an exact quote from a bounded, non-secret Workspace file.
/// The host stamps Run identity; the model cannot supply its own provenance.
pub fn propose(ws: &Workspace, run_id: &str, request: Request) -> Result<Proposal, String> {
    bounded(run_id, "Run identity", 512)?;
    bounded(&request.title, "title", 160)?;
    bounded(&request.notes, "notes", 4000)?;
    bounded(&request.why, "why", 1000)?;
    bounded(&request.evidence.quote, "evidence.quote", 2000)?;
    bounded(&request.evidence.path, "evidence.path", 1000)?;
    if matches!(request.kind, MemoryKind::Run | MemoryKind::Handoff) {
        return Err("Propose a reusable decision, convention, fact, failure, or pattern, not a run handoff.".into());
    }
    let path = ws.resolve_existing(&request.evidence.path)?;
    if crate::workspace::is_sensitive_path(ws.root(), &path) {
        return Err("Secret files cannot be memory proposal evidence.".into());
    }
    // Klide's own state (memory notes, the proposal inbox, missions, the
    // coordination journal) is what a lesson would be judged against, never
    // evidence for one: a quote from another pending lesson proves nothing.
    if path
        .strip_prefix(ws.root())
        .is_ok_and(|rel| rel.components().next().is_some_and(|c| c.as_os_str() == ".klide"))
    {
        return Err("Evidence must come from the project's own files, not Klide's state under .klide/.".into());
    }
    let text = ws.read_text(&path, crate::workspace::Access::Agent)?;
    if !text.contains(&request.evidence.quote) {
        return Err("The evidence quote does not occur in the cited Workspace file.".into());
    }
    let rel = path
        .strip_prefix(ws.root())
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(format!(
            "{}:{}",
            request.kind.as_str(),
            request
                .notes
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        ))
    );
    let owner = owner(ws.root().to_str().ok_or("Invalid Workspace path")?)?;
    update(&owner, |store| {
        if store.published.contains(&fingerprint) {
            return Err("This lesson was already accepted into Project Memory.".into());
        }
        if store.dismissed.contains(&fingerprint) {
            return Err("This lesson was dismissed; do not propose it again.".into());
        }
        if let Some(existing) = store.pending.iter().find(|p| p.fingerprint == fingerprint) {
            return Ok(existing.clone());
        }
        let reviewed = super::list_memory(owner.root().to_string_lossy().into(), Some(500))?;
        if reviewed.iter().any(|entry| {
            entry.kind == request.kind
                && entry
                    .notes
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase()
                    == request
                        .notes
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .to_lowercase()
        }) {
            return Err("This lesson is already in Project Memory.".into());
        }
        if store.pending.len() >= MAX_PENDING {
            return Err("The Memory inbox is full (10 pending proposals). Wait for review.".into());
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        let id = format!(
            "proposal-{}",
            nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let line = text[..text.find(&request.evidence.quote).unwrap()]
            .bytes()
            .filter(|b| *b == b'\n')
            .count() as u32
            + 1;
        let proposal = Proposal {
            input: MemoryInput {
                title: request.title.trim().into(),
                kind: request.kind,
                notes: request.notes.trim().into(),
                tags: vec![],
                supersedes: None,
                goal: String::new(),
                plan: vec![],
                decisions: vec![],
                files_touched: vec![],
                next_steps: vec![],
                run_id: Some(run_id.into()),
                provider: None,
                model: None,
                mode: None,
                status: None,
                source_refs: vec![
                    MemorySourceRef {
                        source_type: MemorySourceType::Run,
                        id: run_id.into(),
                        ..Default::default()
                    },
                    MemorySourceRef {
                        source_type: MemorySourceType::File,
                        id: rel.clone(),
                        path: Some(rel.clone()),
                        line_start: Some(line),
                        label: Some(format!("Evidence snapshot sha256:{hash}")),
                        ..Default::default()
                    },
                ],
            },
            draft_id: id,
            created_at_ms: super::now_ms(),
            workspace_root: owner.root().to_string_lossy().into(),
            why: request.why.trim().into(),
            evidence: format!("{rel}:\n{}", request.evidence.quote),
            evidence_hash: hash,
            fingerprint,
        };
        store.pending.insert(0, proposal.clone());
        Ok(proposal)
    })
}

pub fn list(root: &str) -> Result<Vec<Proposal>, String> {
    let store = read(&owner(root)?)?;
    Ok(store
        .pending
        .into_iter()
        .filter(|p| super::now_ms() - p.created_at_ms < TTL_MS)
        .collect())
}

#[tauri::command]
pub async fn memory_proposals_list(workspace_root: String) -> Result<Vec<Proposal>, String> {
    crate::blocking::run(move || list(&workspace_root)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edits {
    title: String,
    notes: String,
    goal: String,
    decisions: Vec<String>,
}

/// Human-only IPC acceptance: no publication operation is exported as a Tool.
pub fn review(root: &str, id: &str, edits: Option<Edits>) -> Result<Option<MemoryEntry>, String> {
    let ws = owner(root)?;
    update(&ws, |store| {
        let index = store
            .pending
            .iter()
            .position(|p| p.draft_id == id)
            .ok_or("Memory proposal no longer pending.")?;
        let proposal = &store.pending[index];
        // A Keep whose store update was interrupted already published: finish
        // it whichever button comes next — no duplicate on a retried Keep, and
        // a Dismiss reports the saved entry instead of hiding it.
        let prior = prior_publication(&ws, id)?;
        let result = if prior.is_some() {
            prior
        } else if let Some(edits) = edits {
            bounded(&edits.title, "title", 160)?;
            bounded(&edits.notes, "notes", 4000)?;
            let mut input = proposal.input.clone();
            input.title = edits.title;
            input.notes = edits.notes;
            input.goal = edits.goal;
            input.decisions = edits.decisions;
            input.source_refs.push(MemorySourceRef {
                source_type: MemorySourceType::Run,
                id: input.run_id.clone().unwrap_or_default(),
                label: Some(id.into()),
                ..Default::default()
            });
            input.notes = format!(
                "{}\n\nEvidence captured at proposal time:\n{}\n\nWhy retain: {}",
                input.notes, proposal.evidence, proposal.why
            );
            Some(super::write_memory(ws.root().to_string_lossy().into(), input)?)
        } else {
            store.dismissed.insert(0, proposal.fingerprint.clone());
            store.dismissed.truncate(100);
            None
        };
        if result.is_some() {
            store.published.insert(0, proposal.fingerprint.clone());
            store.published.truncate(100);
        }
        store.pending.remove(index);
        Ok(result)
    })
}

#[tauri::command]
pub async fn memory_proposal_review(
    workspace_root: String,
    draft_id: String,
    edits: Option<Edits>,
) -> Result<Option<MemoryEntry>, String> {
    crate::blocking::run(move || review(&workspace_root, &draft_id, edits)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TestDir(PathBuf);
    impl TestDir {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (TestDir, Workspace) {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let dir = TestDir(
            std::env::temp_dir().join(format!("klide-proposal-{:x}", u64::from_ne_bytes(nonce))),
        );
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(
            dir.path().join("CONVENTIONS.md"),
            "Release artifacts use violet-otter-7319.\n",
        )
        .unwrap();
        let ws = Workspace::new(dir.path().to_str().unwrap()).unwrap();
        (dir, ws)
    }
    fn request() -> Request {
        serde_json::from_value(json!({"title":"Release verification", "kind":"convention", "notes":"Release artifacts use violet-otter-7319.", "why":"Keep release verification consistent.", "evidence":{"path":"CONVENTIONS.md","quote":"Release artifacts use violet-otter-7319."}})).unwrap()
    }
    fn edits() -> Edits {
        Edits {
            title: "Reviewed release rule".into(),
            notes: "Use the release verification label.".into(),
            goal: String::new(),
            decisions: vec![],
        }
    }

    #[test]
    fn proposals_survive_restart_but_are_not_recalled_until_reviewed() {
        let (_dir, ws) = fixture();
        let root = ws.root().to_str().unwrap();
        let p = propose(&ws, "native-run", request()).unwrap();
        assert_eq!(p.input.source_refs[0].id, "native-run");
        assert!(super::super::list_memory(root.into(), None)
            .unwrap()
            .is_empty());
        assert_eq!(list(root).unwrap()[0].draft_id, p.draft_id);
        assert_eq!(
            propose(&ws, "other-run", request()).unwrap().draft_id,
            p.draft_id
        );
        let entry = review(root, &p.draft_id, Some(edits())).unwrap().unwrap();
        assert_eq!(
            entry.review_state,
            super::super::MemoryReviewState::Reviewed
        );
        assert_eq!(entry.title, "Reviewed release rule");
        assert!(entry.notes.contains("CONVENTIONS.md:"));
        assert!(list(root).unwrap().is_empty());
        assert_eq!(
            super::super::list_memory(root.into(), None).unwrap().len(),
            1
        );
        assert!(propose(&ws, "later-run", request())
            .unwrap_err()
            .contains("accepted"));
    }

    #[test]
    fn dismissals_persist_and_workspace_identity_is_host_bound() {
        let (_dir, ws) = fixture();
        let root = ws.root().to_str().unwrap();
        let p = propose(&ws, "hermes-run", request()).unwrap();
        assert!(review(root, &p.draft_id, None).unwrap().is_none());
        assert!(propose(&ws, "hermes-run", request())
            .unwrap_err()
            .contains("dismissed"));
        let (_other, other) = fixture();
        assert!(propose(&other, "second-run", request()).is_ok());
        let mut value = serde_json::to_value(request()).unwrap();
        value["runId"] = json!("forged");
        assert!(serde_json::from_value::<Request>(value).is_err());
    }

    #[test]
    fn fabricated_secret_and_outside_evidence_are_rejected() {
        let (_dir, ws) = fixture();
        let mut r = request();
        r.evidence.quote = "fabricated quote".into();
        assert!(propose(&ws, "run", r)
            .unwrap_err()
            .contains("does not occur"));
        fs::write(
            ws.root().join(".env"),
            "Release artifacts use violet-otter-7319.",
        )
        .unwrap();
        let mut r = request();
        r.evidence.path = ".env".into();
        assert!(propose(&ws, "run", r).unwrap_err().contains("Secret"));
        let mut r = request();
        r.evidence.path = "../elsewhere".into();
        assert!(propose(&ws, "run", r).is_err());
        assert!(propose(&ws, "", request()).is_err());
        assert!(list(ws.root().to_str().unwrap()).unwrap().is_empty());
    }

    #[test]
    fn klide_state_is_neither_evidence_nor_readable_by_a_run() {
        let (_dir, ws) = fixture();
        fs::create_dir_all(ws.root().join(".klide/memory")).unwrap();
        fs::write(
            ws.root().join(".klide/memory/note.md"),
            "Release artifacts use violet-otter-7319.",
        )
        .unwrap();
        let mut r = request();
        r.evidence.path = ".klide/memory/note.md".into();
        assert!(propose(&ws, "run", r).unwrap_err().contains(".klide/"));
        // The inbox itself, once it exists, is closed to a run.
        propose(&ws, "run", request()).unwrap();
        let store = state_path(&ws).unwrap();
        assert!(ws.read_text(&store, crate::workspace::Access::Agent).is_err());
        assert!(ws.read_text(&store, crate::workspace::Access::User).is_ok());
    }

    #[test]
    fn limits_count_characters_not_bytes() {
        let (_dir, ws) = fixture();
        let mut r = request();
        r.title = "é".repeat(150);
        assert!(r.title.len() > 160);
        assert!(propose(&ws, "run", r).is_ok());
        let mut r = request();
        r.notes = "Other lesson".into();
        r.title = "é".repeat(161);
        assert!(propose(&ws, "run", r).unwrap_err().contains("characters"));
    }

    #[test]
    fn a_dismiss_after_an_interrupted_keep_reports_the_saved_entry() {
        let (_dir, ws) = fixture();
        let root = ws.root().to_str().unwrap();
        let p = propose(&ws, "run", request()).unwrap();
        // Keep wrote the entry, then the store update failed: still pending.
        let mut input = p.input.clone();
        input.source_refs.push(MemorySourceRef {
            source_type: MemorySourceType::Run,
            id: "run".into(),
            label: Some(p.draft_id.clone()),
            ..Default::default()
        });
        let saved = super::super::write_memory(root.into(), input).unwrap();
        let reported = review(root, &p.draft_id, None).unwrap().expect("the saved entry");
        assert_eq!(reported.id, saved.id);
        assert!(list(root).unwrap().is_empty());
        assert_eq!(super::super::list_memory(root.into(), None).unwrap().len(), 1);
        assert!(propose(&ws, "later", request()).unwrap_err().contains("accepted"));
    }

    #[test]
    fn inbox_is_bounded_and_corruption_is_an_error() {
        let (_dir, ws) = fixture();
        let root = ws.root().to_str().unwrap();
        for i in 0..10 {
            let mut r = request();
            r.notes = format!("Lesson {i}");
            propose(&ws, "run", r).unwrap();
        }
        let mut r = request();
        r.notes = "overflow".into();
        assert!(propose(&ws, "run", r).unwrap_err().contains("full"));
        fs::write(state_path(&ws).unwrap(), "broken").unwrap();
        assert!(list(root).is_err());
        assert!(propose(&ws, "run", request()).is_err());
    }

    #[test]
    fn native_and_delegate_tools_share_the_same_proposal_boundary() {
        use crate::{
            agent::tools,
            coordination_bridge::{self, BridgeHooks, BridgeRequest, BridgeSession},
        };
        let (_dir, ws) = fixture();
        let root = ws.root().to_str().unwrap();
        let call = tools::NormalizedToolCall {
            id: "native-call".into(),
            name: "memory_propose".into(),
            input: serde_json::to_value(request()).unwrap(),
        };
        assert!(tools::tool_allowed_in_mode(
            &crate::agent::types::AgentMode::Plan,
            tools::ToolKind::MemoryProposal
        ));
        assert!(!tools::tool_allowed_in_mode(
            &crate::agent::types::AgentMode::Chat,
            tools::ToolKind::MemoryProposal
        ));
        let result = tools::execute_read_only_tool(root, &call, "native-run");
        assert!(result.ok, "{}", result.content);
        let session = BridgeSession {
            run_id: "hermes-run".into(),
            workspace_root: root.into(),
            terminal: false,
            secret_sha256: String::new(),
        };
        let store = crate::coordination::CoordinationStoreState::default();
        let result = coordination_bridge::execute(
            &store,
            &BridgeHooks::silent(),
            &session,
            BridgeRequest::MemoryPropose { input: call.input },
        );
        assert!(result.ok, "{result:?}");
        assert_eq!(list(root).unwrap().len(), 1);
        assert!(super::super::list_memory(root.into(), None)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn concurrent_proposals_keep_one_shared_inbox_and_enforce_capacity() {
        let (_dir, ws) = fixture();
        let root = ws.root().to_string_lossy().to_string();
        let threads: Vec<_> = (0..16)
            .map(|i| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let ws = Workspace::new(&root).unwrap();
                    let mut r = request();
                    r.notes = format!("Concurrent lesson {i}");
                    propose(&ws, "parallel-run", r).is_ok()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|ok| *ok)
                .count(),
            10
        );
        assert_eq!(list(&root).unwrap().len(), 10);
    }

    #[test]
    fn linked_worktree_proposals_use_shared_inbox_but_own_evidence() {
        let (_dir, main) = fixture();
        let branch = main.root().join("branch");
        fs::create_dir_all(&branch).unwrap();
        let gitdir = main.root().join(".git/worktrees/branch");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(branch.join(".git"), format!("gitdir: {}", gitdir.display())).unwrap();
        fs::write(
            branch.join("CONVENTIONS.md"),
            "Branch-specific release evidence.",
        )
        .unwrap();
        let ws = Workspace::new(branch.to_str().unwrap()).unwrap();
        let mut r = request();
        r.evidence.quote = "Branch-specific release evidence.".into();
        let p = propose(&ws, "worker-run", r).unwrap();
        assert_eq!(p.workspace_root, main.root().to_string_lossy());
        assert_eq!(list(main.root().to_str().unwrap()).unwrap().len(), 1);
        assert_eq!(
            list(branch.to_str().unwrap()).unwrap()[0].draft_id,
            p.draft_id
        );
        assert!(!branch.join(".klide/memory-proposals").exists());
    }

    #[cfg(unix)]
    #[test]
    fn evidence_and_store_symlinks_cannot_escape_workspace() {
        let (_dir, ws) = fixture();
        let (_outside, other) = fixture();
        std::os::unix::fs::symlink(
            other.root().join("CONVENTIONS.md"),
            ws.root().join("external.md"),
        )
        .unwrap();
        let mut r = request();
        r.evidence.path = "external.md".into();
        assert!(propose(&ws, "run", r).is_err());
        fs::create_dir_all(ws.root().join(".klide")).unwrap();
        std::os::unix::fs::symlink(other.root(), ws.root().join(".klide/memory-proposals"))
            .unwrap();
        assert!(propose(&ws, "run", request()).is_err());
        assert!(!other.root().join("state.json").exists());
    }
    #[test]
    fn expired_proposals_leave_recall_untouched_and_do_not_consume_capacity() {
        let (_dir, ws) = fixture();
        let root = ws.root().to_str().unwrap();
        propose(&ws, "run", request()).unwrap();
        let mut state = read(&ws).unwrap();
        state.pending[0].created_at_ms = super::super::now_ms() - TTL_MS - 1;
        crate::durable::write_atomic_private(
            &state_path(&ws).unwrap(),
            &serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        assert!(list(root).unwrap().is_empty());
        assert!(super::super::list_memory(root.into(), None)
            .unwrap()
            .is_empty());
        assert!(propose(&ws, "fresh-run", request()).is_ok());
        assert_eq!(
            list(root).unwrap()[0].input.run_id.as_deref(),
            Some("fresh-run")
        );
    }
}
