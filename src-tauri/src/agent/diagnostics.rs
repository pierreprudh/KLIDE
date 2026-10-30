//! Opt-in, local diagnostics of logical Harness inputs, before Provider wire
//! translation. Never change the request or persist prompt content/digests.
use super::types::{AgentPromptChange, AgentPromptComparison};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Instant;

pub(super) fn enabled(provider: &str) -> bool {
    std::env::var("KLIDE_HARNESS_DIAGNOSTICS").as_deref() == Ok("1")
        && crate::delegate::lookup(provider).is_none()
        && !crate::providers::is_subscription_provider(provider)
}

pub(super) fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u64::MAX as u128) as u64
}

// Streaming into the hasher avoids a second serialized copy of large inputs.
struct HashWriter(Sha256);
impl std::io::Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn fingerprint(value: &impl Serialize) -> [u8; 32] {
    let mut writer = HashWriter(Sha256::new());
    // Callers supply JSON Values / Options thereof, which always serialize.
    serde_json::to_writer(&mut writer, value).expect("JSON input fingerprint");
    writer.0.finalize().into()
}

#[derive(Default)]
pub(super) struct PromptMonitor(Option<Snapshot>);
struct Snapshot {
    configuration: [u8; 32],
    tools: [u8; 32],
    messages: Vec<[u8; 32]>,
}

impl PromptMonitor {
    pub(super) fn observe(
        &mut self,
        configuration: &Value,
        tools: &Option<Vec<Value>>,
        messages: &[Value],
    ) -> AgentPromptComparison {
        let next = Snapshot {
            configuration: fingerprint(configuration),
            tools: fingerprint(tools),
            messages: messages.iter().map(fingerprint).collect(),
        };
        let mut result = AgentPromptComparison {
            change: AgentPromptChange::NoBaseline,
            unchanged_messages: 0,
            first_changed_message: None,
        };
        if let Some(previous) = &self.0 {
            result.unchanged_messages = previous
                .messages
                .iter()
                .zip(&next.messages)
                .take_while(|(a, b)| a == b)
                .count();
            result.change = if previous.configuration != next.configuration {
                AgentPromptChange::Configuration
            } else if previous.tools != next.tools {
                AgentPromptChange::Tools
            } else if result.unchanged_messages < previous.messages.len().min(next.messages.len()) {
                result.first_changed_message = Some(result.unchanged_messages);
                AgentPromptChange::Message
            } else if next.messages.len() < previous.messages.len() {
                result.first_changed_message = Some(next.messages.len());
                AgentPromptChange::MessagesRemoved
            } else if next.messages.len() > previous.messages.len() {
                AgentPromptChange::Appended
            } else {
                AgentPromptChange::Unchanged
            };
        }
        self.0 = Some(next);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_appends_rewrites_and_compaction_without_mutation() {
        let mut monitor = PromptMonitor::default();
        let config = json!({"model": "fixture"});
        let tools = Some(vec![json!({"name": "read"})]);
        let mut messages = vec![json!({"role": "system", "content": "private instructions"})];
        assert_eq!(
            monitor.observe(&config, &tools, &messages).change,
            AgentPromptChange::NoBaseline
        );
        assert_eq!(
            monitor.observe(&config, &tools, &messages).change,
            AgentPromptChange::Unchanged
        );
        messages.push(json!({"role": "user", "content": "private message"}));
        let before = messages.clone();
        let appended = monitor.observe(&config, &tools, &messages);
        assert_eq!(appended.change, AgentPromptChange::Appended);
        assert_eq!(appended.unchanged_messages, 1);
        assert_eq!(messages, before);
        messages[0]["content"] = json!("changed system");
        let changed = monitor.observe(&config, &tools, &messages);
        assert_eq!(changed.change, AgentPromptChange::Message);
        assert_eq!(changed.first_changed_message, Some(0));
        messages.pop();
        assert_eq!(
            monitor.observe(&config, &tools, &messages).change,
            AgentPromptChange::MessagesRemoved
        );
        let wire = serde_json::to_string(&changed).unwrap();
        assert!(!wire.contains("private"));
        assert!(!wire.contains("changed system"));
        assert!(!wire.contains("hash"));
    }

    #[test]
    fn tools_and_configuration_changes_take_precedence() {
        let mut monitor = PromptMonitor::default();
        monitor.observe(&json!({"model": "a"}), &None, &[]);
        let tools = Some(vec![json!({"name": "read"})]);
        assert_eq!(
            monitor.observe(&json!({"model": "a"}), &tools, &[]).change,
            AgentPromptChange::Tools
        );
        assert_eq!(
            monitor.observe(&json!({"model": "b"}), &None, &[]).change,
            AgentPromptChange::Configuration
        );
    }
}
