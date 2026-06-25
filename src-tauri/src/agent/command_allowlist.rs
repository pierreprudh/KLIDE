//! Project-persistent approvals for `run_command`.
//!
//! The run loop still asks before a new command executes. When the user chooses
//! "Approve for this project", the exact command is stored in the workspace so
//! future Klide runs can skip that prompt. The file also accepts wildcard rules
//! (`rules[].pattern`) so a project can intentionally allow command families
//! such as `cargo test *` without teaching the run loop about JSON shape.

use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};

const ALLOWLIST_PATH: &str = ".klide/command-allowlist.json";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandAllowlist {
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    rules: Vec<CommandRule>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandRule {
    pattern: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchedCommandRule {
    pub pattern: String,
    pub exact: bool,
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
    Ok(normalize(
        parsed
            .commands
            .into_iter()
            .chain(parsed.rules.into_iter().map(|r| r.pattern))
            .collect(),
    ))
}

pub fn add(workspace_root: &str, command: &str) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Ok(());
    }
    let ws = Workspace::new(workspace_root)?;
    let mut parsed = read_allowlist(&ws)?;
    if !parsed.commands.iter().any(|c| c == command) {
        parsed.commands.push(command.to_string());
    }
    write_allowlist(&ws, parsed)
}

pub fn add_rule(workspace_root: &str, pattern: &str) -> Result<(), String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Ok(());
    }
    if !has_wildcard(pattern) {
        return add(workspace_root, pattern);
    }
    let ws = Workspace::new(workspace_root)?;
    let mut parsed = read_allowlist(&ws)?;
    if !parsed.rules.iter().any(|r| r.pattern == pattern) {
        parsed.rules.push(CommandRule {
            pattern: pattern.to_string(),
        });
    }
    write_allowlist(&ws, parsed)
}

pub fn match_rule(
    rules: &[String],
    command: &str,
    approval_key: &str,
) -> Option<MatchedCommandRule> {
    rules.iter().find_map(|rule| {
        let pattern = rule.trim();
        if pattern.is_empty() {
            return None;
        }
        let exact = !has_wildcard(pattern);
        let matched = if exact {
            pattern == command || pattern == approval_key
        } else {
            wildcard_match(pattern, command) || wildcard_match(pattern, approval_key)
        };
        matched.then(|| MatchedCommandRule {
            pattern: pattern.to_string(),
            exact,
        })
    })
}

fn read_allowlist(ws: &Workspace) -> Result<CommandAllowlist, String> {
    let path = ws.resolve_new(ALLOWLIST_PATH)?;
    if !path.exists() {
        return Ok(CommandAllowlist::default());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Unable to read command allowlist: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Invalid command allowlist JSON: {e}"))
}

fn write_allowlist(ws: &Workspace, mut allowlist: CommandAllowlist) -> Result<(), String> {
    let path = ws.resolve_new(ALLOWLIST_PATH)?;
    allowlist.commands = normalize(allowlist.commands);
    allowlist.rules = normalize_rules(allowlist.rules);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Unable to create .klide folder: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&allowlist)
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

fn normalize_rules(rules: Vec<CommandRule>) -> Vec<CommandRule> {
    let mut out = Vec::new();
    for rule in rules {
        let pattern = rule.pattern.trim();
        if !pattern.is_empty() && !out.iter().any(|r: &CommandRule| r.pattern == pattern) {
            out.push(CommandRule {
                pattern: pattern.to_string(),
            });
        }
    }
    out.sort_by(|a, b| a.pattern.cmp(&b.pattern));
    out
}

fn has_wildcard(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?')
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<usize> = None;
    let mut star_text = 0;

    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            star_text = ti;
        } else if let Some(star_i) = star {
            pi = star_i + 1;
            star_text += 1;
            ti = star_text;
        } else {
            return false;
        }
    }

    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
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

    #[test]
    fn wildcard_rules_are_loaded_and_matched() {
        let root = temp_workspace("rules");
        add(&root, "cargo check").unwrap();
        add_rule(&root, "cargo test *").unwrap();

        assert_eq!(
            list(&root).unwrap(),
            vec!["cargo check".to_string(), "cargo test *".to_string()]
        );
        assert_eq!(
            match_rule(&list(&root).unwrap(), "cargo check", "cargo check")
                .expect("exact")
                .exact,
            true
        );
        let wildcard = match_rule(
            &list(&root).unwrap(),
            "cargo test --all",
            "cargo test --all",
        )
        .expect("wildcard");
        assert_eq!(wildcard.pattern, "cargo test *");
        assert!(!wildcard.exact);
        assert!(match_rule(&list(&root).unwrap(), "npm test", "npm test").is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
