mod pty;
use pty::{pty_spawn, pty_write, PtyState};
use std::process::Command;
use std::sync::Mutex;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    is_directory: bool,
}

#[derive(serde::Serialize)]
struct GitFile {
    path: String,
    status: String,
    staged: bool,
}

#[derive(serde::Serialize)]
struct GitStatus {
    branch: String,
    files: Vec<GitFile>,
}

#[derive(serde::Serialize)]
struct GitDiff {
    path: String,
    diff: String,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
struct ProjectGraphGroup {
    name: String,
    file_count: usize,
    changed_count: usize,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
struct ProjectGraphChange {
    path: String,
    status: String,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
struct ProjectGraphFile {
    path: String,
    status: String,
    changed: bool,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
struct ProjectGraph {
    root_name: String,
    branch: String,
    total_files: usize,
    changed_files: usize,
    additions: usize,
    deletions: usize,
    groups: Vec<ProjectGraphGroup>,
    changes: Vec<ProjectGraphChange>,
    files: Vec<ProjectGraphFile>,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let entries = std::fs::read_dir(path)
        .map_err(|e| format!("Unable to read folder: {e}"))?;

    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Unable to read folder entry: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Unable to read folder entry type: {e}"))?;
        out.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_directory: file_type.is_dir(),
        });
    }

    Ok(out)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Unable to read file: {e}"))
}

fn run_git(workspace_root: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn git_output(workspace_root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn count_diff_lines(diff: &str) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;

    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }

    (additions, deletions)
}

#[tauri::command]
fn git_status(workspace_root: String) -> Result<GitStatus, String> {
    let output = Command::new("git")
        .args(["-C", &workspace_root, "status", "--short", "--branch"])
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branch = "unknown".to_string();
    let mut files = Vec::new();

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest
                .split("...")
                .next()
                .unwrap_or(rest)
                .trim()
                .to_string();
            continue;
        }

        if line.len() < 4 {
            continue;
        }

        let staged = &line[0..1] != " " && &line[0..1] != "?";
        let status = line[0..2].trim().to_string();
        let path = line[3..].trim().to_string();
        files.push(GitFile { path, status, staged });
    }

    Ok(GitStatus { branch, files })
}

#[tauri::command]
fn git_stage(workspace_root: String, path: String) -> Result<(), String> {
    run_git(&workspace_root, &["add", "--", &path])
}

#[tauri::command]
fn git_unstage(workspace_root: String, path: String) -> Result<(), String> {
    run_git(&workspace_root, &["restore", "--staged", "--", &path])
}

#[tauri::command]
fn git_diff(workspace_root: String, path: String, staged: bool) -> Result<GitDiff, String> {
    let diff = if staged {
        git_output(&workspace_root, &["diff", "--cached", "--", &path])?
    } else {
        git_output(&workspace_root, &["diff", "--", &path])?
    };

    let diff = if diff.trim().is_empty() && !staged {
        let untracked = git_output(
            &workspace_root,
            &["ls-files", "--others", "--exclude-standard", "--", &path],
        )?;
        if untracked.lines().any(|line| line == path) {
            let full_path = std::path::Path::new(&workspace_root).join(&path);
            let content = std::fs::read_to_string(&full_path)
                .map_err(|e| format!("Unable to read untracked file: {e}"))?;
            let mut out = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n");
            for line in content.lines() {
                out.push('+');
                out.push_str(line);
                out.push('\n');
            }
            if content.ends_with('\n') {
                // content.lines() omits the final empty segment; no extra line is needed.
            }
            out
        } else {
            diff
        }
    } else {
        diff
    };

    let (additions, deletions) = count_diff_lines(&diff);
    Ok(GitDiff {
        path,
        diff,
        additions,
        deletions,
    })
}

fn graph_group_name(path: &str) -> String {
    let first = path.split('/').next().unwrap_or(path);
    match first {
        "src" => "Frontend".to_string(),
        "src-tauri" => "Tauri".to_string(),
        "public" => "Assets".to_string(),
        ".github" => "Automation".to_string(),
        _ if path.contains('/') => first.to_string(),
        _ => "Root".to_string(),
    }
}

#[tauri::command]
fn project_graph(workspace_root: String) -> Result<ProjectGraph, String> {
    use std::collections::BTreeMap;

    let branch = git_output(&workspace_root, &["branch", "--show-current"])?
        .trim()
        .to_string();
    let files_out = git_output(&workspace_root, &["ls-files"])?;
    let tracked_files: Vec<String> = files_out
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.to_string())
        .collect();

    let status = git_status(workspace_root.clone())?;
    let mut additions_by_path: BTreeMap<String, usize> = BTreeMap::new();
    let mut deletions_by_path: BTreeMap<String, usize> = BTreeMap::new();

    let numstat = git_output(&workspace_root, &["diff", "--numstat"])?;
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let adds = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let dels = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if let Some(path) = parts.next() {
            additions_by_path.insert(path.to_string(), adds);
            deletions_by_path.insert(path.to_string(), dels);
        }
    }

    let staged_numstat = git_output(&workspace_root, &["diff", "--cached", "--numstat"])?;
    for line in staged_numstat.lines() {
        let mut parts = line.split('\t');
        let adds = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let dels = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if let Some(path) = parts.next() {
            *additions_by_path.entry(path.to_string()).or_default() += adds;
            *deletions_by_path.entry(path.to_string()).or_default() += dels;
        }
    }

    for file in &status.files {
        if file.status == "??" {
            let full_path = std::path::Path::new(&workspace_root).join(&file.path);
            let line_count = std::fs::read_to_string(full_path)
                .map(|content| content.lines().count().max(1))
                .unwrap_or(0);
            additions_by_path.insert(file.path.clone(), line_count);
            deletions_by_path.insert(file.path.clone(), 0);
        }
    }

    let mut groups: BTreeMap<String, ProjectGraphGroup> = BTreeMap::new();
    let status_by_path: BTreeMap<String, String> = status
        .files
        .iter()
        .map(|file| (file.path.clone(), file.status.clone()))
        .collect();

    for path in &tracked_files {
        let name = graph_group_name(path);
        let entry = groups.entry(name.clone()).or_insert(ProjectGraphGroup {
            name,
            file_count: 0,
            changed_count: 0,
            additions: 0,
            deletions: 0,
        });
        entry.file_count += 1;
    }

    let mut changes = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;
    for file in &status.files {
        let adds = additions_by_path.get(&file.path).copied().unwrap_or(0);
        let dels = deletions_by_path.get(&file.path).copied().unwrap_or(0);
        additions += adds;
        deletions += dels;

        let name = graph_group_name(&file.path);
        let entry = groups.entry(name.clone()).or_insert(ProjectGraphGroup {
            name,
            file_count: 0,
            changed_count: 0,
            additions: 0,
            deletions: 0,
        });
        entry.changed_count += 1;
        entry.additions += adds;
        entry.deletions += dels;

        changes.push(ProjectGraphChange {
            path: file.path.clone(),
            status: file.status.clone(),
            additions: adds,
            deletions: dels,
        });
    }

    let mut graph_files: Vec<ProjectGraphFile> = tracked_files
        .iter()
        .map(|path| {
            let status = status_by_path.get(path).cloned().unwrap_or_default();
            ProjectGraphFile {
                path: path.clone(),
                changed: !status.is_empty(),
                additions: additions_by_path.get(path).copied().unwrap_or(0),
                deletions: deletions_by_path.get(path).copied().unwrap_or(0),
                status,
            }
        })
        .collect();

    for file in &status.files {
        if file.status == "??" && !graph_files.iter().any(|tracked| tracked.path == file.path) {
            graph_files.push(ProjectGraphFile {
                path: file.path.clone(),
                status: file.status.clone(),
                changed: true,
                additions: additions_by_path.get(&file.path).copied().unwrap_or(0),
                deletions: deletions_by_path.get(&file.path).copied().unwrap_or(0),
            });
        }
    }

    graph_files.sort_by(|a, b| a.path.cmp(&b.path));

    let root_name = std::path::Path::new(&workspace_root)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| workspace_root.clone());

    Ok(ProjectGraph {
        root_name,
        branch: if branch.is_empty() { "unknown".to_string() } else { branch },
        total_files: tracked_files.len(),
        changed_files: status.files.len(),
        additions,
        deletions,
        groups: groups.into_values().collect(),
        changes,
        files: graph_files,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState { writer: Mutex::new(None) })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            list_dir,
            read_text_file,
            git_status,
            git_stage,
            git_unstage,
            git_diff,
            project_graph
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
