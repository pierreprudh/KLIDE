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
            if !roots.iter().any(|root| full.starts_with(root)) {
                return None;
            }
            let parent = full.parent()?;
            let ws = crate::workspace::Workspace::new(parent.to_str()?).ok()?;
            ws.guard(&full, crate::workspace::Access::Agent).ok()?;
            let meta = std::fs::metadata(&full).ok()?;
            if !meta.is_file() || meta.len() > 20_000_000 {
                return None;
            }
            Some(DocumentReference {
                path: full.to_string_lossy().into_owned(),
                workspace_root: parent.to_string_lossy().into_owned(),
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
