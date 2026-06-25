//! Project-persistent approvals for network tools.
//!
//! Network tools are Goal-only and pause before first use. A project approval
//! stores a small target string such as `web_search` or `host:docs.rs` so future
//! runs can skip the prompt for that network profile without weakening command
//! or workspace permissions.

use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};

const ALLOWLIST_PATH: &str = ".klide/network-allowlist.json";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkAllowlist {
    #[serde(default)]
    targets: Vec<String>,
}

pub fn list(workspace_root: &str) -> Result<Vec<String>, String> {
    let ws = Workspace::new(workspace_root)?;
    let path = ws.resolve_new(ALLOWLIST_PATH)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Unable to read network allowlist: {e}"))?;
    let parsed: NetworkAllowlist =
        serde_json::from_str(&text).map_err(|e| format!("Invalid network allowlist JSON: {e}"))?;
    Ok(normalize(parsed.targets))
}

pub fn add(workspace_root: &str, target: &str) -> Result<(), String> {
    let target = normalize_target(target);
    if target.is_empty() {
        return Ok(());
    }
    let ws = Workspace::new(workspace_root)?;
    let path = ws.resolve_new(ALLOWLIST_PATH)?;
    let mut targets = if path.exists() {
        list(workspace_root)?
    } else {
        Vec::new()
    };
    if !targets.iter().any(|t| t == &target) {
        targets.push(target);
        targets.sort();
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create .klide folder: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&NetworkAllowlist { targets })
        .map_err(|e| format!("Unable to serialize network allowlist: {e}"))?;
    std::fs::write(&path, format!("{text}\n"))
        .map_err(|e| format!("Unable to write network allowlist: {e}"))
}

pub fn is_allowed(workspace_root: &str, target: &str) -> Result<bool, String> {
    let target = normalize_target(target);
    Ok(list(workspace_root)?.iter().any(|t| t == &target))
}

fn normalize(targets: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for target in targets {
        let target = normalize_target(&target);
        if !target.is_empty() && !out.iter().any(|t| t == &target) {
            out.push(target);
        }
    }
    out.sort();
    out
}

fn normalize_target(target: &str) -> String {
    target.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "klide-network-allowlist-{name}-{}",
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
    fn add_persists_unique_sorted_targets() {
        let root = temp_workspace("add");
        add(&root, "host:Docs.RS").unwrap();
        add(&root, " web_search ").unwrap();
        add(&root, "host:docs.rs").unwrap();
        assert_eq!(
            list(&root).unwrap(),
            vec!["host:docs.rs".to_string(), "web_search".to_string()]
        );
        assert!(is_allowed(&root, "HOST:DOCS.RS").unwrap());
        assert!(!is_allowed(&root, "host:example.com").unwrap());
        let _ = std::fs::remove_dir_all(root);
    }
}
