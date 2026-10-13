//! Enabled skill bodies stay outside model context until requested.
use super::types::RunSkill;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

static SKILLS: LazyLock<Mutex<HashMap<String, Vec<RunSkill>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn register(run: &str, skills: &[RunSkill], parent: Option<&str>) {
    let mut store = SKILLS.lock().unwrap();
    let skills = if skills.is_empty() {
        parent.and_then(|id| store.get(id)).cloned().unwrap_or_default()
    } else {
        skills.to_vec()
    };
    store.insert(run.into(), skills);
}

pub(super) fn clear(run: &str) {
    SKILLS.lock().unwrap().remove(run);
}

pub(crate) fn read(run: &str, command: &str) -> Result<String, String> {
    let store = SKILLS.lock().unwrap();
    let command = command.trim().trim_start_matches('/');
    let skill = store.get(run).and_then(|skills| skills.iter().find(|s| s.command == command))
        .ok_or_else(|| format!("No enabled skill '/{command}' in this run."))?;
    Ok(format!("Skill: {}\n{}\n\n{}", skill.name, skill.description, skill.instructions))
}

pub(super) fn explicit_instructions(run: &str, text: &str) -> Option<String> {
    let command = text.trim_start().split_whitespace().next()?.strip_prefix('/')?;
    read(run, command).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delegate_mcp_loads_the_bound_runs_skill() {
        use crate::coordination_bridge::{BridgeHooks, BridgeSession};
        let id = "skill-mcp-run";
        register(id, &[RunSkill { command: "draw".into(), name: "Draw".into(), description: "Pictures".into(), instructions: "MCP_SKILL_BODY".into() }], None);
        let session = BridgeSession {
            run_id: id.into(), workspace_root: "/tmp".into(), terminal: false, secret_sha256: String::new(),
        };
        let request = crate::mcp_server::bridge_request_for("read_skill", &serde_json::json!({"command":"draw"})).unwrap();
        let store = crate::coordination::CoordinationStoreState::default();
        let response = crate::coordination_bridge::execute(&store, &BridgeHooks::silent(), &session, request);
        assert!(response.ok);
        assert!(response.value.unwrap()["text"].as_str().unwrap().contains("MCP_SKILL_BODY"));
        clear(id);
    }

    #[test]
    fn bodies_are_loaded_only_from_the_current_runs_catalog() {
        let skill = RunSkill { command: "draw".into(), name: "Draw".into(), description: "Draw pictures".into(), instructions: "Use SVG".into() };
        register("skill-parent", &[skill], None);
        register("skill-child", &[], Some("skill-parent"));
        assert!(read("skill-parent", "/draw").unwrap().contains("Use SVG"));
        assert!(read("unrelated", "draw").is_err());
        assert!(explicit_instructions("skill-parent", "Draw something").is_none());
        assert!(explicit_instructions("skill-child", " /draw hello").unwrap().contains("Use SVG"));
        assert!(explicit_instructions("skill-parent", "/missing hello").is_none());
        clear("skill-parent");
        assert!(read("skill-parent", "draw").is_err());
        assert!(read("skill-child", "draw").is_ok());
        clear("skill-child");
    }
}
