//! klide-bot's settings, read and written from Mission Control › Scheduled.
//!
//! The bots run in GitHub Actions (`.github/workflows/klide-bot.yml`,
//! `review.yml`) on `klide run`; what they run on is two repository
//! variables. This module reads and sets those through the pinned `gh`
//! account (`git::github::gh_output`) — values only, never a secret: for
//! keys it reports which secrets *exist*, by name.

use serde::Serialize;

/// Which bot a model belongs to, and the repository variable that holds it.
fn variable(bot: &str) -> Result<&'static str, String> {
    match bot {
        "answer" => Ok("KLIDE_BOT_MODEL"),
        "review" => Ok("REVIEW_MODEL"),
        other => Err(format!("Unknown bot \"{other}\"")),
    }
}

/// The key secrets the workflows pass to `klide run`, by the Provider they
/// serve. A model on any other Provider would find no key on the runner.
pub(crate) const KEYS: [(&str, &str); 2] = [("openrouter", "OPENROUTER_API_KEY"), ("deepseek", "DEEPSEEK_API_KEY")];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotSettings {
    /// `owner/name`, from the Workspace's GitHub remote.
    repo: String,
    /// The workflows are in this checkout (`klide-bot.yml`, `review.yml`).
    answer_installed: bool,
    review_installed: bool,
    /// `provider/model`, or `None` when unset (the bot is inert).
    answer_model: Option<String>,
    review_model: Option<String>,
    /// Providers whose key secret exists on the repository.
    keyed_providers: Vec<String>,
    /// The bot posts as `klide-bot[bot]` rather than as Actions.
    app_identity: bool,
}

fn parse(repo: String, root: &std::path::Path, variables: &str, secrets: &str) -> Result<BotSettings, String> {
    let vars: Vec<serde_json::Value> = serde_json::from_str(variables).map_err(|e| e.to_string())?;
    let secret_names: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(secrets)
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|s| s["name"].as_str().map(str::to_string))
        .collect();
    let var = |name: &str| {
        vars.iter()
            .find(|v| v["name"] == name)
            .and_then(|v| v["value"].as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let workflow = |file: &str| root.join(".github/workflows").join(file).is_file();
    Ok(BotSettings {
        repo,
        answer_installed: workflow("klide-bot.yml"),
        review_installed: workflow("review.yml"),
        // klide-bot.yml falls back to REVIEW_MODEL, so show what it will use.
        answer_model: var("KLIDE_BOT_MODEL").or_else(|| var("REVIEW_MODEL")),
        review_model: var("REVIEW_MODEL"),
        keyed_providers: KEYS
            .iter()
            .filter(|(_, secret)| secret_names.iter().any(|n| n == secret))
            .map(|(provider, _)| provider.to_string())
            .collect(),
        app_identity: var("KLIDE_BOT_APP_ID").is_some(),
    })
}

#[tauri::command]
pub async fn klide_bot_settings(workspace_root: String) -> Result<BotSettings, String> {
    crate::blocking::run(move || {
        let root = std::path::PathBuf::from(&workspace_root);
        let repo = crate::git::github::gh_output(&workspace_root, &["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])?
            .trim()
            .to_string();
        let variables = crate::git::github::gh_output(&workspace_root, &["variable", "list", "--json", "name,value"])?;
        // Names only: `gh` never returns a secret's value.
        let secrets = crate::git::github::gh_output(&workspace_root, &["secret", "list", "--json", "name"])?;
        parse(repo, &root, &variables, &secrets)
    })
    .await
}

/// A model string the workflows can run: `provider/model` on a Provider
/// whose key the repository holds.
fn checked(model: &str) -> Result<(), String> {
    let (provider, rest) = model.split_once('/').ok_or("A bot model is provider/model")?;
    if rest.is_empty() || model.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("A bot model is provider/model".into());
    }
    if !KEYS.iter().any(|(p, _)| *p == provider) {
        return Err(format!("The bots can only use {} — the keys their workflows pass", KEYS.map(|(p, _)| p).join(" or ")));
    }
    Ok(())
}

/// `model: None` turns that bot off (deletes the variable).
#[tauri::command]
pub async fn klide_bot_set_model(workspace_root: String, bot: String, model: Option<String>) -> Result<BotSettings, String> {
    let name = variable(&bot)?;
    if let Some(m) = &model {
        checked(m)?;
    }
    let root = workspace_root.clone();
    crate::blocking::run(move || {
        match &model {
            Some(m) => crate::git::github::gh_output(&root, &["variable", "set", name, "--body", m]),
            None => crate::git::github::gh_output(&root, &["variable", "delete", name]).or_else(|e| {
                // Already unset is what was asked for.
                if e.contains("404") || e.to_lowercase().contains("not found") { Ok(String::new()) } else { Err(e) }
            }),
        }
        .map(|_| ())
    })
    .await?;
    klide_bot_settings(workspace_root).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_read_models_keys_and_the_fallback() {
        let dir = std::env::temp_dir().join(format!("klide-bot-settings-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".github/workflows")).unwrap();
        std::fs::write(dir.join(".github/workflows/klide-bot.yml"), "").unwrap();
        let vars = r#"[{"name":"REVIEW_MODEL","value":"openrouter/a/b"},{"name":"KLIDE_BOT_APP_ID","value":"1"}]"#;
        let secrets = r#"[{"name":"OPENROUTER_API_KEY"},{"name":"KLIDE_BOT_PRIVATE_KEY"}]"#;
        let s = parse("o/r".into(), &dir, vars, secrets).unwrap();
        assert_eq!(s.answer_model.as_deref(), Some("openrouter/a/b"), "klide-bot falls back to REVIEW_MODEL");
        assert_eq!(s.keyed_providers, vec!["openrouter"]);
        assert!(s.answer_installed && !s.review_installed && s.app_identity);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_a_keyed_provider_model_is_accepted() {
        assert!(checked("openrouter/deepseek/deepseek-v4.1-flash").is_ok());
        assert!(checked("deepseek/deepseek-chat").is_ok());
        assert!(checked("anthropic/claude").unwrap_err().contains("openrouter or deepseek"));
        assert!(checked("openrouter/").is_err());
        assert!(checked("openrouter/a b").is_err());
        assert!(variable("nope").is_err());
    }
}
