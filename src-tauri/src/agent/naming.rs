//! A name for a conversation nobody has named.
//!
//! OpenCode names its sessions with a small model beside the first turn and
//! Klide adopts the name (`delegate::opencode_v2`, `session.renamed`). Every
//! other Provider — Kit on an API or a local server, a Delegate that does not
//! name its sessions — gets the same thing from here: one tool-less call on a
//! light model, started beside the first turn so it costs the answer no time,
//! delivered as the same `ConversationTitled` event the rail already
//! rewrites on. The panel decides whether to ask (the thread's first turn,
//! nobody has named it, the setting is on); this module decides *who* names
//! it and *what* a name is.
//!
//! Who: never a bigger model than the conversation's own. A hosted thread
//! names through its Provider's light rung (`AutoLadder`), a local thread
//! through its own model — a thread on a local model never names through a
//! hosted one, pin or no pin, so nothing leaves the machine that was not
//! already leaving it. A Delegate names through its routed source when it
//! has one, else through the local default, since the CLI's own turn would
//! be slow and spend the subscription on six words.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::types::PreferredModel;
use crate::providers::{self, ProviderGroup};

/// What a run request carries when the panel wants the conversation named:
/// the pair Settings pins, if any (absent = automatic, the rules above).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NamingRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<PreferredModel>,
}

/// How long a name may take. A light hosted model answers in a second; a
/// local one already loaded for the turn in a few.
pub const NAME_TIMEOUT: Duration = Duration::from_secs(25);
/// Enough for six words and a stray preamble, not for an essay.
const NAME_TOKENS: usize = 32;
/// How much of the first message the namer reads.
const MESSAGE_CHARS: usize = 1_500;
/// Longer than this is a sentence, not a name.
const MAX_CHARS: usize = 60;

pub const SYSTEM_PROMPT: &str = "You name conversations between a software engineer and an AI coding assistant. \
Given the person's first message, reply with a name for the conversation and nothing else: \
three to six words, sentence case, specific to what they asked, no quotes, no trailing period, no preamble.";

/// The user turn the namer receives.
pub fn prompt(first_message: &str) -> String {
    let message = first_message.trim();
    let mut cut: String = message.chars().take(MESSAGE_CHARS).collect();
    if cut.len() < message.len() {
        cut.push('…');
    }
    format!("Name this conversation. The person's first message:\n\n{cut}")
}

/// What a model said, as a name: the first line that is not a thinking
/// block, unquoted, without a trailing period, whitespace collapsed — or
/// nothing, when it is empty or too long to be a name.
pub fn clean(raw: &str) -> Option<String> {
    let mut text = raw.to_string();
    while let (Some(start), Some(end)) = (text.find("<think>"), text.find("</think>")) {
        if end < start { break; }
        text.replace_range(start..end + "</think>".len(), "");
    }
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let dressing = |c: char| matches!(c, '"' | '“' | '”' | '\'' | '`' | '*' | '_' | '#' | '-' | ' ');
    let line = line.trim_matches(dressing).trim_end_matches('.').trim_matches(dressing);
    let name = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = name.strip_prefix("Name:").or_else(|| name.strip_prefix("Title:")).map(str::trim).unwrap_or(&name).to_string();
    (!name.is_empty() && name.chars().count() <= MAX_CHARS).then_some(name)
}

/// The intelligence the conversation actually runs on: a Delegate's routed
/// source, or the pair itself. `None` for a Delegate on its own
/// subscription, which has no source Klide can call directly.
fn source(provider: &str, model: &str) -> Option<PreferredModel> {
    if crate::delegate::lookup(provider).is_some() {
        return crate::harness_source::selection(model)
            .ok()
            .flatten()
            .map(|s| PreferredModel { provider: s.provider, model: s.model });
    }
    let own = crate::harness_source::selection(model).ok().flatten();
    Some(match own {
        Some(s) => PreferredModel { provider: s.provider, model: s.model },
        None => PreferredModel { provider: provider.to_string(), model: model.to_string() },
    })
}

fn group(provider: &str) -> Option<ProviderGroup> {
    providers::lookup(provider).map(|entry| entry.group.clone())
}

fn is_local(provider: &str) -> bool {
    matches!(group(provider), Some(ProviderGroup::Local))
}

/// Who names a conversation running on `provider` / `model`, with `pinned`
/// from Settings when there is one.
pub fn pick(pinned: Option<&PreferredModel>, provider: &str, model: &str) -> Option<PreferredModel> {
    let source = source(provider, model);
    let local = source.as_ref().is_some_and(|s| is_local(&s.provider));
    if let Some(pinned) = pinned {
        // A local thread's words stay local; otherwise the pin is the answer.
        if !(local && !is_local(&pinned.provider)) {
            return Some(pinned.clone());
        }
    }
    let Some(source) = source else {
        // A Delegate on its subscription alone: the local default, if any.
        let entry = providers::lookup("ollama")?;
        return entry.default_model.map(|model| PreferredModel { provider: "ollama".into(), model: model.into() });
    };
    if local {
        return Some(source);
    }
    match providers::lookup(&source.provider) {
        Some(entry) if entry.group == ProviderGroup::Hosted => Some(PreferredModel {
            provider: source.provider.clone(),
            model: entry.auto.light.map(str::to_string).unwrap_or(source.model),
        }),
        // A self-hosted endpoint or anything the registry does not know:
        // the model the thread already trusts.
        _ => Some(source),
    }
}

/// One tool-less turn on the namer, the stream discarded; only a name comes
/// back. Any failure is no name, never an error the turn sees.
pub async fn name(namer: &PreferredModel, first_message: &str, workspace_root: Option<String>) -> Option<String> {
    let messages = vec![
        serde_json::json!({ "role": "system", "content": SYSTEM_PROMPT }),
        serde_json::json!({ "role": "user", "content": prompt(first_message) }),
    ];
    let sink = tauri::ipc::Channel::new(|_| Ok(()));
    let turn = providers::ProviderTurn {
        provider: namer.provider.clone(),
        model: namer.model.clone(),
        messages,
        tools: None,
        workspace_root,
        run_id: None,
        delegate_session: None,
        allowed_commands: Vec::new(),
        mcp: None,
        num_ctx: None,
        num_predict: Some(NAME_TOKENS),
        reflection_level: None,
    };
    let response = match tokio::time::timeout(NAME_TIMEOUT, providers::dispatch(turn, &sink)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            eprintln!("klide: naming on {}/{} failed: {error}", namer.provider, namer.model);
            return None;
        }
        Err(_) => {
            eprintln!("klide: naming on {}/{} timed out", namer.provider, namer.model);
            return None;
        }
    };
    clean(&response.content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(provider: &str, model: &str) -> PreferredModel {
        PreferredModel { provider: provider.into(), model: model.into() }
    }

    #[test]
    fn a_name_is_one_clean_line() {
        assert_eq!(clean("Fix the flaky login test"), Some("Fix the flaky login test".into()));
        assert_eq!(clean("\"Understanding the project stack.\"\n"), Some("Understanding the project stack".into()));
        assert_eq!(clean("<think>they want a name</think>\n\nName: Picker row order"), Some("Picker row order".into()));
        assert_eq!(clean("  **Rail  title   rewrite**  "), Some("Rail title rewrite".into()));
        assert_eq!(clean(""), None);
        assert_eq!(clean("   \n  "), None);
        assert!(clean(&"word ".repeat(30)).is_none());
    }

    #[test]
    fn the_prompt_carries_the_first_message_cut_to_size() {
        assert!(prompt("  Hello who are you ").ends_with("Hello who are you"));
        let long = "x".repeat(5_000);
        let p = prompt(&long);
        assert!(p.ends_with('…'));
        assert!(p.chars().count() < 1_700);
    }

    #[test]
    fn a_hosted_thread_names_on_its_providers_light_rung() {
        let light = providers::lookup("anthropic").unwrap().auto.light.unwrap();
        assert_eq!(pick(None, "anthropic", "claude-fable-5-1"), Some(pair("anthropic", light)));
    }

    #[test]
    fn a_local_thread_names_on_its_own_model_and_never_through_a_hosted_pin() {
        assert_eq!(pick(None, "ollama", "llama3.1:8b"), Some(pair("ollama", "llama3.1:8b")));
        assert_eq!(pick(Some(&pair("anthropic", "claude-haiku-5-5")), "ollama", "llama3.1:8b"), Some(pair("ollama", "llama3.1:8b")));
        assert_eq!(pick(Some(&pair("ollama", "qwen3:4b")), "ollama", "llama3.1:8b"), Some(pair("ollama", "qwen3:4b")));
    }

    #[test]
    fn a_pin_names_a_hosted_thread() {
        assert_eq!(pick(Some(&pair("ollama", "qwen3:4b")), "anthropic", "claude-fable-5-1"), Some(pair("ollama", "qwen3:4b")));
        assert_eq!(pick(Some(&pair("openai", "gpt-5.6-mini")), "anthropic", "claude-fable-5-1"), Some(pair("openai", "gpt-5.6-mini")));
    }

    #[test]
    fn a_delegate_names_through_its_routed_source_else_the_local_default() {
        let routed = r#"harness-source:{"provider":"openrouter","model":"deepseek/deepseek-v4.1-flash"}"#;
        let light = providers::lookup("openrouter").unwrap().auto.light.unwrap();
        assert_eq!(pick(None, "opencode", routed), Some(pair("openrouter", light)));
        let local_default = providers::lookup("ollama").unwrap().default_model.unwrap();
        assert_eq!(pick(None, "claude-code", "claude-fable-5-1"), Some(pair("ollama", local_default)));
    }

    #[test]
    fn a_self_hosted_thread_keeps_its_own_model() {
        assert_eq!(pick(None, "custom:opencodex", "ollama/qwen3.5:9b"), Some(pair("custom:opencodex", "ollama/qwen3.5:9b")));
    }
}
