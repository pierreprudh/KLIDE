//! Find-in-files lives behind the Workspace seam, like every other file
//! access. `search_workspace` takes a constructed `Workspace`, walks from its
//! canonical root, and renders hits as workspace-relative paths through
//! `Workspace::display` — so the paths a search returns match exactly what
//! `list_dir` / `read_text_file` hand back, even when the workspace is opened
//! through a symlink.
//!
//! The directory ignore list is a *search* policy, not a workspace-rooting
//! rule: `read_file` may still open a file inside `node_modules` on demand;
//! we just don't walk those trees during a scan.

use crate::workspace::Workspace;
use std::path::PathBuf;

/// Stop after this many matches across the whole scan.
const MATCH_CAP: usize = 500;
/// Skip files larger than this (bytes) — they're rarely source the user greps.
const MAX_FILE_BYTES: u64 = 500_000;
/// Directory names never descended into during a scan.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".cache",
    ".venv",
    "__pycache__",
];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub content: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub file_count: usize,
    pub capped: bool,
}

/// Scan the workspace for a literal substring. `include` is an optional
/// filename suffix filter ("*.rs", ".rs", "rs" all mean "files ending .rs").
pub fn search_workspace(
    ws: &Workspace,
    pattern: &str,
    include: Option<&str>,
) -> Result<SearchResult, String> {
    if pattern.trim().is_empty() {
        return Err("Pattern cannot be empty".to_string());
    }

    let include_filter = include
        .filter(|s| !s.trim().is_empty() && *s != "*")
        .map(|s| s.trim().trim_start_matches('*').to_lowercase());

    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut file_count = 0usize;
    let mut capped = false;

    let mut pending: Vec<PathBuf> = vec![ws.root().to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if matches.len() >= MATCH_CAP {
                capped = true;
                break;
            }
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_lowercase();

            if ft.is_dir() {
                if !IGNORED_DIRS.contains(&name.as_str()) {
                    pending.push(path);
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            if let Some(ref filter) = include_filter {
                if !name.ends_with(filter) {
                    continue;
                }
            }
            if path
                .metadata()
                .map(|m| m.len() > MAX_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let rel = ws.display(&path);
            let mut found_in_file = false;
            for (idx, line) in content.lines().enumerate() {
                if matches.len() >= MATCH_CAP {
                    capped = true;
                    break;
                }
                if let Some(col) = line.find(pattern) {
                    if !found_in_file {
                        file_count += 1;
                        found_in_file = true;
                    }
                    matches.push(SearchMatch {
                        file: rel.clone(),
                        line: idx + 1,
                        column: col + 1,
                        content: line.chars().take(300).collect(),
                    });
                }
            }
        }
        if capped {
            break;
        }
    }

    Ok(SearchResult {
        matches,
        file_count,
        capped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> (PathBuf, Workspace) {
        let dir = std::env::temp_dir().join(format!("klide-search-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ws = Workspace::new(dir.to_str().unwrap()).unwrap();
        (dir, ws)
    }

    #[test]
    fn empty_pattern_is_rejected() {
        let (_dir, ws) = temp_workspace("empty");
        assert!(search_workspace(&ws, "   ", None).is_err());
    }

    #[test]
    fn finds_matches_with_relative_path_line_and_column() {
        let (dir, ws) = temp_workspace("hits");
        std::fs::write(dir.join("a.txt"), "hello world\nno match here\nhello again").unwrap();
        let res = search_workspace(&ws, "hello", None).unwrap();
        assert_eq!(res.file_count, 1);
        assert_eq!(res.matches.len(), 2);
        let first = &res.matches[0];
        assert_eq!(first.file, "a.txt"); // workspace-relative, via ws.display
        assert_eq!(first.line, 1);
        assert_eq!(first.column, 1);
        assert_eq!(res.matches[1].line, 3);
    }

    #[test]
    fn descends_subdirs_but_skips_ignored_ones() {
        let (dir, ws) = temp_workspace("ignore");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("src/keep.txt"), "needle").unwrap();
        std::fs::write(dir.join("node_modules/pkg/skip.txt"), "needle").unwrap();
        let res = search_workspace(&ws, "needle", None).unwrap();
        assert_eq!(res.file_count, 1);
        assert_eq!(res.matches[0].file, "src/keep.txt");
    }

    #[test]
    fn include_filter_matches_suffix_forms() {
        let (dir, ws) = temp_workspace("include");
        std::fs::write(dir.join("a.rs"), "target").unwrap();
        std::fs::write(dir.join("b.txt"), "target").unwrap();
        for filter in ["*.rs", ".rs", "rs"] {
            let res = search_workspace(&ws, "target", Some(filter)).unwrap();
            assert_eq!(res.matches.len(), 1, "filter {filter}");
            assert_eq!(res.matches[0].file, "a.rs");
        }
    }

    #[test]
    fn skips_oversized_files() {
        let (dir, ws) = temp_workspace("big");
        let big = format!("{}\nneedle\n", "x".repeat(MAX_FILE_BYTES as usize + 1));
        std::fs::write(dir.join("big.txt"), big).unwrap();
        std::fs::write(dir.join("small.txt"), "needle").unwrap();
        let res = search_workspace(&ws, "needle", None).unwrap();
        assert_eq!(res.file_count, 1);
        assert_eq!(res.matches[0].file, "small.txt");
    }

    #[test]
    fn caps_the_match_count() {
        let (dir, ws) = temp_workspace("cap");
        let many = "x\n".repeat(MATCH_CAP + 100);
        std::fs::write(dir.join("many.txt"), many).unwrap();
        let res = search_workspace(&ws, "x", None).unwrap();
        assert!(res.capped);
        assert_eq!(res.matches.len(), MATCH_CAP);
    }
}
