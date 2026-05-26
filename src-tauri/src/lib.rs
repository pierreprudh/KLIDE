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
            git_status,
            git_stage,
            git_unstage
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
