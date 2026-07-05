//! Custom CLI agent store.
//!
//! Built-in delegates (Claude Code, Codex, OpenCode, Omp) have rich adapters
//! because Klide knows their flags and transcript locations. Custom CLI
//! agents are lighter: a user supplies a shell command template and Klide runs
//! it inside the same PTY delegate surface.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const CUSTOM_CLI_ID_PREFIX: &str = "cli:";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomCli {
    pub id: String,
    pub label: String,
    /// Shell command template. Supports `{task}`, `{model}`, and `{resume}`.
    pub command_template: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_command: Option<String>,
}

impl CustomCli {
    pub fn binary(&self) -> String {
        first_shell_word(&self.command_template).unwrap_or_else(|| self.command_template.clone())
    }

    pub fn spawn_command(
        &self,
        task: Option<&str>,
        model: Option<&str>,
        resume_session_id: Option<&str>,
    ) -> String {
        let task = task.map(str::trim).filter(|v| !v.is_empty());
        let model = model.map(str::trim).filter(|v| !v.is_empty());
        let resume = resume_session_id.map(str::trim).filter(|v| !v.is_empty());
        let mut command = self.command_template.trim().to_string();

        command = replace_placeholder(&command, "task", task);
        command = replace_placeholder(&command, "model", model);
        command = replace_placeholder(&command, "resume", resume);

        if !self.command_template.contains("{task}") {
            if let Some(task) = task {
                command.push(' ');
                command.push_str(&crate::delegate::shell_quote(task));
            }
        }

        command
    }

    pub fn model_list(&self) -> Vec<String> {
        if self.models.is_empty() {
            if self.default_model.trim().is_empty() {
                Vec::new()
            } else {
                vec![self.default_model.clone()]
            }
        } else {
            self.models.clone()
        }
    }
}

fn replace_placeholder(command: &str, name: &str, value: Option<&str>) -> String {
    let placeholder = format!("{{{name}}}");
    if command.contains(&placeholder) {
        command.replace(
            &placeholder,
            value
                .map(crate::delegate::shell_quote)
                .unwrap_or_else(|| "''".to_string())
                .as_str(),
        )
    } else {
        command.to_string()
    }
}

fn first_shell_word(input: &str) -> Option<String> {
    let mut chars = input.trim_start().chars().peekable();
    let mut out = String::new();
    let mut quote: Option<char> = None;
    while let Some(ch) = chars.next() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => out.push(ch),
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch.is_whitespace() => break,
            None if ch == '\\' => {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            None => out.push(ch),
        }
    }
    let out = out.trim();
    if out.is_empty() {
        None
    } else {
        Some(out.to_string())
    }
}

fn store_path() -> Option<PathBuf> {
    crate::home_dir_path().map(|home| home.join(".klide").join("custom_cli_agents.json"))
}

pub fn list() -> Vec<CustomCli> {
    let Some(path) = store_path() else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn get(id: &str) -> Option<CustomCli> {
    list().into_iter().find(|p| p.id == id)
}

fn write_all(providers: &[CustomCli]) -> Result<(), String> {
    let path = store_path().ok_or_else(|| "Could not resolve home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {parent:?}: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(providers).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write {path:?}: {e}"))
}

pub fn upsert(mut provider: CustomCli) -> Result<(), String> {
    provider.id = provider.id.trim().to_string();
    provider.label = provider.label.trim().to_string();
    provider.command_template = provider.command_template.trim().to_string();
    provider.default_model = provider.default_model.trim().to_string();
    provider.models = provider
        .models
        .into_iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect();
    provider.login_command = provider
        .login_command
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());

    if !provider.id.starts_with(CUSTOM_CLI_ID_PREFIX) {
        return Err(format!(
            "Custom CLI id must start with \"{CUSTOM_CLI_ID_PREFIX}\""
        ));
    }
    if provider.label.is_empty() {
        return Err("Label is required".to_string());
    }
    if provider.command_template.is_empty() {
        return Err("Command template is required".to_string());
    }

    let mut all = list();
    match all.iter_mut().find(|p| p.id == provider.id) {
        Some(existing) => *existing = provider,
        None => all.push(provider),
    }
    write_all(&all)
}

pub fn remove(id: &str) -> Result<(), String> {
    let mut all = list();
    let before = all.len();
    all.retain(|p| p.id != id);
    if all.len() == before {
        return Ok(());
    }
    write_all(&all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_template_quotes_task_and_model() {
        let cli = CustomCli {
            id: "cli:test".to_string(),
            label: "Test".to_string(),
            command_template: "agent --model {model} run {task}".to_string(),
            default_model: "fast".to_string(),
            models: vec![],
            login_command: None,
        };
        assert_eq!(
            cli.spawn_command(Some("don't break"), Some("gpt x"), None),
            "agent --model 'gpt x' run 'don'\\''t break'"
        );
    }

    #[test]
    fn command_template_appends_task_without_placeholder() {
        let cli = CustomCli {
            id: "cli:test".to_string(),
            label: "Test".to_string(),
            command_template: "agent".to_string(),
            default_model: String::new(),
            models: vec![],
            login_command: None,
        };
        assert_eq!(
            cli.spawn_command(Some("fix it"), None, None),
            "agent 'fix it'"
        );
    }
}
