//! Project-persistent approvals for `run_command`.
//!
//! The run loop still asks before a new command executes. When the user chooses
//! "Approve for this project", the exact command is stored in the workspace so
//! future Klide runs can skip that prompt.

use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};

const ALLOWLIST_PATH: &str = ".klide/command-allowlist.json";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandAllowlist {
    #[serde(default)]
    commands: Vec<String>,
}

pub fn list(workspace_root: &str) -> Result<Vec<String>, String> {
    let ws = Workspace::new(workspace_root)?;
    let path = ws.resolve_new(ALLOWLIST_PATH)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Unable to read command allowlist: {e}"))?;
    let parsed: CommandAllowlist =
        serde_json::from_str(&text).map_err(|e| format!("Invalid command allowlist JSON: {e}"))?;
    Ok(normalize(parsed.commands))
}

pub fn add(workspace_root: &str, command: &str) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Ok(());
    }
    let ws = Workspace::new(workspace_root)?;
    let path = ws.resolve_new(ALLOWLIST_PATH)?;
    let mut commands = if path.exists() {
        list(workspace_root)?
    } else {
        Vec::new()
    };
    if !commands.iter().any(|c| c == command) {
        commands.push(command.to_string());
        commands.sort();
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create .klide folder: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&CommandAllowlist { commands })
        .map_err(|e| format!("Unable to serialize command allowlist: {e}"))?;
    std::fs::write(&path, format!("{text}\n"))
        .map_err(|e| format!("Unable to write command allowlist: {e}"))
}

fn normalize(commands: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for command in commands {
        let command = command.trim();
        if !command.is_empty() && !out.iter().any(|c| c == command) {
            out.push(command.to_string());
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "klide-command-allowlist-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn missing_allowlist_is_empty() {
        let root = temp_workspace("missing");
        assert_eq!(list(&root).unwrap(), Vec::<String>::new());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn add_persists_unique_sorted_commands() {
        let root = temp_workspace("add");
        add(&root, "cargo test").unwrap();
        add(&root, " npm run build ").unwrap();
        add(&root, "cargo test").unwrap();
        assert_eq!(
            list(&root).unwrap(),
            vec!["cargo test".to_string(), "npm run build".to_string()]
        );
        let text =
            std::fs::read_to_string(format!("{root}/{ALLOWLIST_PATH}")).expect("allowlist file");
        assert!(text.contains("\"commands\""));
        let _ = std::fs::remove_dir_all(root);
    }
}
