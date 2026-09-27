//! Recover read-only document references from older transcripts. This does
//! not rewrite history or claim the referenced file was created by the run.
use crate::agent::{self, types::AgentEvent};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReference {
    path: String,
    workspace_root: String,
    bytes: u64,
}

fn candidates(text: &str, roots: &[String]) -> BTreeSet<PathBuf> {
    let mut paths = BTreeSet::new();
    for line in text.split(['\n', '\r', '"', '\'', '`']) {
        for root in roots {
            for (start, _) in line.match_indices(root) {
                let tail = &line[start..];
                let lower = tail.to_ascii_lowercase();
                for ext in [".xlsx", ".docx", ".pptx", ".pdf", ".ods", ".odt", ".odp"] {
                    for (end, _) in lower.match_indices(ext) {
                        let end = end + ext.len();
                        if tail[end..].chars().next().is_some_and(|c| {
                            !c.is_whitespace() && !matches!(c, ')' | ']' | ',' | ';')
                        }) {
                            continue;
                        }
                        paths.insert(PathBuf::from(&tail[..end]));
                    }
                }
            }
        }
    }
    paths
}

fn recover(events: &[AgentEvent], home_documents: Option<&Path>) -> Vec<DocumentReference> {
    let mut roots: Vec<PathBuf> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::RunStarted { cwd: Some(cwd), .. } => Some(PathBuf::from(cwd)),
            _ => None,
        })
        .collect();
    if let Some(home) = home_documents {
        roots.push(home.to_path_buf());
    }
    let roots: Vec<_> = roots
        .into_iter()
        .filter_map(|p| p.canonicalize().ok())
        .collect();
    let prefixes: Vec<_> = roots.iter().map(|p| format!("{}/", p.display())).collect();
    let mut paths = BTreeSet::new();
    for event in events {
        if let AgentEvent::ToolCallFinished { result, .. } = event {
            if result.ok {
                paths.extend(candidates(&result.content, &prefixes));
            }
        }
    }
    paths
        .into_iter()
        .take(50)
        .filter_map(|path| {
            let full = path.canonicalize().ok()?;
            // Guarded against the root it was found under, not its own
            // folder: `<root>/.aws/keys.xlsx` is only credential-shaped when
            // `.aws` is part of the relative path the guard reads.
            let root = roots.iter().find(|root| full.starts_with(root))?;
            let ws = crate::workspace::Workspace::new(root.to_str()?).ok()?;
            ws.guard(&full, crate::workspace::Access::Agent).ok()?;
            // Only a document kind that would actually open — a reference is
            // an offer to open, and an executable is never offered.
            if !crate::documents::is_document_kind(&full)
                || crate::documents::classify(&full).ok()? != crate::documents::Disposition::Open
            {
                return None;
            }
            let meta = std::fs::metadata(&full).ok()?;
            if !meta.is_file() || meta.len() > 20_000_000 {
                return None;
            }
            Some(DocumentReference {
                path: full.to_string_lossy().into_owned(),
                workspace_root: root.to_string_lossy().into_owned(),
                bytes: meta.len(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn agent_run_document_references(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<Vec<DocumentReference>, String> {
    agent::transcripts::validate_run_id(&run_id)?;
    let runs_dir = agent::transcripts::app_runs_dir(&app)?;
    crate::blocking::run(move || {
        // A cached chat may predate transcripts. Absence is not a preview
        // failure, whereas a corrupt existing transcript remains an error.
        if !runs_dir
            .join(format!("{run_id}.jsonl"))
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            return Ok(Vec::new());
        }
        let events = agent::transcripts::read_events(&runs_dir, &run_id)?;
        let documents = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Documents"));
        Ok(recover(&events, documents.as_deref()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_existing_run_reference_with_spaces_not_neighbor_paths() {
        let roots = vec!["/Users/test/Documents/".into()];
        assert_eq!(candidates("-rw-r--r-- 5926 /Users/test/Documents/Quarterly budget.xlsx\n/Users/test/Documents/secret.xlsx.sh\n/Users/test/Other/a.xlsx",&roots),BTreeSet::from([PathBuf::from("/Users/test/Documents/Quarterly budget.xlsx")]));
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-run-documents-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn run_that_listed(cwd: &Path, listing: &str) -> Vec<AgentEvent> {
        vec![
            AgentEvent::RunStarted {
                run_id: "r".into(),
                cwd: Some(cwd.to_string_lossy().into_owned()),
                mode: agent::types::AgentMode::Goal,
                provider: "ollama".into(),
                model: "m".into(),
                ts: 0,
            },
            AgentEvent::ToolCallFinished {
                run_id: "r".into(),
                tool_call_id: "c".into(),
                result: agent::types::ToolResult {
                    ok: true,
                    content: listing.into(),
                    metadata: None,
                },
                ts: 0,
            },
        ]
    }

    #[test]
    fn a_reference_is_guarded_against_its_root_not_its_parent() {
        let root = temp_root("guard");
        std::fs::create_dir_all(root.join(".aws")).unwrap();
        std::fs::write(root.join(".aws/keys.xlsx"), b"PK\x03\x04").unwrap();
        std::fs::write(root.join("budget.xlsx"), b"PK\x03\x04").unwrap();
        let listing = format!("{0}/.aws/keys.xlsx\n{0}/budget.xlsx\n", root.display());
        let found = recover(&run_that_listed(&root, &listing), None);
        let paths: Vec<_> = found.iter().map(|d| d.path.clone()).collect();
        assert_eq!(paths, vec![root.join("budget.xlsx").to_string_lossy().into_owned()]);
        assert_eq!(found[0].workspace_root, root.to_string_lossy());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_executable_reference_is_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("exec");
        let path = root.join("report.pdf");
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let listing = format!("{}\n", path.display());
        assert!(recover(&run_that_listed(&root, &listing), None).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Manual read-only verification against a local transcript"]
    fn verify_local_transcript_recovery() {
        let path = std::env::var("KLIDE_VERIFY_TRANSCRIPT").expect("transcript path");
        let path = PathBuf::from(path);
        let events = agent::transcripts::read_events(
            path.parent().unwrap(),
            path.file_stem().unwrap().to_str().unwrap(),
        )
        .unwrap();
        let documents = std::env::var("HOME")
            .map(|h| PathBuf::from(h).join("Documents"))
            .unwrap();
        let recovered = recover(&events, Some(&documents));
        println!("{}", serde_json::to_string(&recovered).unwrap());
        assert!(!recovered.is_empty());
    }
}
