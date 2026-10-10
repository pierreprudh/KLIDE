//! The `/klide` skill for Claude Code — "open this conversation in Klide",
//! said in a terminal, becomes `open "klide://resume?…&session=$CLAUDE_CODE_SESSION_ID"`
//! (deep_link.rs). It is one `SKILL.md` in Claude Code's user skills folder,
//! written only when asked (Settings › From other apps) and removed only when
//! it is still the file Klide wrote. Same shape as the Ask Kit Quick Action
//! (services_menu.rs): a tiny file that opens a link; Klide owns the rules.
//!
//! Why a skill and not an MCP server: a server would be a child of the CLI
//! and would not know the parent's session id either — the id reaches a
//! shell as `CLAUDE_CODE_SESSION_ID`, so a skill that runs `open` is the whole
//! bridge. Claude Code only, for now: no other Delegate exports its id.

use std::path::PathBuf;

const SKILL: &str = include_str!("../resources/klide-skill/SKILL.md");
/// The line that makes a file ours to remove.
const MARKER: &str = "Installed by Klide";

/// `<Claude Code skills dir>/klide/SKILL.md` — the adapter owns where that
/// is (`CLAUDE_CONFIG_DIR` honoured), the same folder the Skills loader reads.
fn skill_file() -> Result<PathBuf, String> {
    let dir = crate::delegate::ClaudeCode
        .skills_dir(&crate::delegate::ProcessEnv)
        .ok_or("No home directory")?;
    Ok(dir.join("klide").join("SKILL.md"))
}

pub fn installed() -> bool {
    skill_file().is_ok_and(|f| std::fs::read_to_string(f).is_ok_and(|s| s.contains(MARKER)))
}

pub fn install() -> Result<(), String> {
    let file = skill_file()?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    std::fs::write(&file, SKILL).map_err(|e| format!("Could not write {}: {e}", file.display()))
}

/// Remove the skill — only when the file is the one Klide wrote, so a user
/// who replaced it with their own `klide` skill keeps theirs.
pub fn uninstall() -> Result<(), String> {
    let file = skill_file()?;
    let ours = std::fs::read_to_string(&file).is_ok_and(|s| s.contains(MARKER));
    if !ours {
        return Ok(());
    }
    std::fs::remove_file(&file).map_err(|e| format!("Could not remove {}: {e}", file.display()))?;
    if let Some(dir) = file.parent() {
        let _ = std::fs::remove_dir(dir); // only when empty
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn klide_skill_status() -> Result<bool, String> {
    crate::blocking::run(|| Ok(installed())).await
}

#[tauri::command]
pub(crate) async fn klide_skill_set(enabled: bool) -> Result<bool, String> {
    crate::blocking::run(move || {
        if enabled { install()? } else { uninstall()? }
        Ok(installed())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_skill_opens_a_resume_link_with_the_shell_session_id() {
        assert!(SKILL.starts_with("---\nname: klide\n"));
        assert!(SKILL.contains(r#"open "klide://resume?provider=claude-code&session=$CLAUDE_CODE_SESSION_ID""#));
        assert!(SKILL.contains(MARKER), "the uninstall marker must be in the file");
        // The link's provider must be a Delegate Klide can resume.
        assert!(crate::delegate::lookup("claude-code").is_some());
    }
}
