// Subagent registry — the Rust source of truth for delegated roles.
//
// A subagent is a focused *role*: a mode (read-only `Plan` vs editing `Goal`),
// a system-prompt fragment that specialises the base harness prompt, and an
// optional model override. The harness owns this list because the harness now
// owns the nested run: `spawn_subagent` resolves a role here, composes the
// child prompt, and drives the child Run to completion inside Rust.
//
// The frontend keeps `src/agent/subagents.ts` for the `@mention` menu — labels
// and blurbs are presentation. `id`, `label`, and `mode` are mirrored, and
// `subagent_ids_match_the_frontend_registry` in `mod.rs` fails if they drift.

use super::types::AgentMode;

/// One delegated role. Field-for-field the shape `src/agent/subagents.ts`
/// exposes, minus the menu blurb (presentation stays in the frontend).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subagent {
    /// Stable id, also the token the user types after `@`.
    pub id: &'static str,
    /// Read-only (`Plan`) or editing (`Goal`). Drives the tool allowlist.
    pub mode: AgentMode,
    /// Role specialisation appended to the base system prompt.
    pub instructions: &'static str,
    /// Optional model override — e.g. a cheaper model for the explorer.
    pub model: Option<&'static str>,
}

/// Every built-in subagent. Mirrors `BUILTIN_SUBAGENTS` in the frontend.
pub const ALL: &[Subagent] = &[
    Subagent {
        id: "explorer",
        mode: AgentMode::Plan,
        instructions:
            "You are the Explorer subagent. Your job is to LOCATE and REPORT, never to edit. \
             Sweep the workspace with read-only tools, follow naming conventions across files, and \
             return a concise map: the files that matter, with `path:line` references and verbatim \
             signatures where they help. Do not propose a design or make changes — just surface what exists.",
        model: None,
    },
    Subagent {
        id: "reviewer",
        mode: AgentMode::Plan,
        instructions:
            "You are the Reviewer subagent. Inspect the relevant code read-only and critique it: \
             correctness bugs first, then clarity and reuse. Be specific — cite `path:line`, explain why \
             each finding is a real problem, and rank by severity. Do not edit files; return findings only.",
        model: None,
    },
    Subagent {
        id: "implementer",
        mode: AgentMode::Goal,
        instructions:
            "You are the Implementer subagent. Inspect first, then make the smallest useful set of edits \
             to achieve the task. Every edit is diff-reviewed before it is written. After tool work, \
             summarise what changed, what was applied or rejected, and what remains.",
        model: None,
    },
    Subagent {
        id: "tester",
        mode: AgentMode::Goal,
        instructions:
            "You are the Tester subagent. Focus on verification: find the test setup, add focused tests \
             for the task at hand (diff-reviewed), and run them. Report what passed, what failed, and the \
             exact failing output. Do not refactor unrelated code.",
        model: None,
    },
];

/// Resolve a subagent by id. Unknown ids are a model mistake, not a crash —
/// the caller turns `None` into a failed tool result the model can correct.
pub fn resolve(id: &str) -> Option<&'static Subagent> {
    let id = id.trim();
    ALL.iter().find(|s| s.id.eq_ignore_ascii_case(id))
}

/// The roles the *model* may name via `spawn_subagent`.
///
/// A model-spawned subagent is read-only by contract — the tool description
/// promises "the subagent cannot edit; it returns findings only". Editing roles
/// (`implementer`, `tester`) are reachable only when a human names them through
/// an `@mention`. Deriving this from the mode keeps the two facts from drifting:
/// the schema enum and the runtime check both read this list.
pub fn model_selectable_ids() -> Vec<&'static str> {
    ALL.iter()
        .filter(|s| s.mode == AgentMode::Plan)
        .map(|s| s.id)
        .collect()
}

/// Whether the model itself may delegate to this role.
pub fn is_model_selectable(def: &Subagent) -> bool {
    def.mode == AgentMode::Plan
}

/// The CLI agents a subagent may be handed to as a Run of its own. Mirrors
/// `delegate::ALL` — the Harness never lists a brand by hand, so a fifth
/// Delegate becomes a fifth worker with no edit here.
pub fn worker_ids() -> Vec<&'static str> {
    crate::delegate::ALL.iter().map(|d| d.id()).collect()
}

/// Resolve a worker by its Delegate id. `None` is a model mistake the caller
/// answers with the list, not a crash.
pub fn resolve_worker(id: &str) -> Option<&'static dyn crate::delegate::Delegate> {
    crate::delegate::lookup(id.trim())
}

/// Every role, for a call that names a worker. The bare tool promises a
/// read-only child, and only `Plan` roles keep that promise on Kit's own
/// provider. A worker is a foreign CLI with its own tools and its own edit
/// policy, so the promise cannot be kept there — instead the worker is
/// isolated in a worktree and the dispatch is gated. With that in place an
/// editing role is exactly what a worker is for.
pub fn worker_selectable_ids() -> Vec<&'static str> {
    ALL.iter().map(|s| s.id).collect()
}

/// The branch a worker's worktree is created on. Mirrors `isolatedRunBranch`
/// in `src/runIsolation.ts` — `klide/<kind>-<slug>-<suffix>` — so a worker's
/// branch reads like every other Klide-made branch in the Worktrees modal.
pub fn worker_branch(task: &str, request_id: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = true;
    for ch in task.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
        if slug.len() >= 36 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "task" } else { slug };
    let suffix: String = request_id
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let suffix = &suffix[suffix.len().saturating_sub(8)..];
    let suffix = if suffix.is_empty() { "run" } else { suffix };
    format!("klide/worker-{slug}-{suffix}")
}

/// The prompt a worker starts from. Not Kit's — a worker is Claude Code or
/// Codex running as itself, and handing it Kit's persona and identity guard
/// would only confuse it. What it needs is the role, the fact that another
/// agent is waiting on a report, and where its edits land.
pub fn build_worker_prompt(def: &Subagent, worker_label: &str, branch: Option<&str>) -> String {
    let landing = match branch {
        Some(branch) => format!(
            "You are working in an isolated Git worktree on branch `{branch}`. Edit freely there: \
             your changes are committed to that branch when you finish and the operator reviews \
             and merges them afterwards. Do not switch branches, and do not push."
        ),
        None => "You are working directly in the project folder (it is not a Git repository, so \
                 there is no worktree to isolate you). Keep every change reversible and minimal."
            .to_string(),
    };
    format!(
        "You are {worker_label}, running as the \"{id}\" worker for another agent inside Klide. \
That agent delegated one focused task to you and is waiting on your report; it cannot see \
your tool calls, only your final message.\n\n{landing}\n\n{instructions}\n\n\
When you are done, end with a short report: what changed (file paths), what you ran and \
what it showed, and anything left undone.",
        id = def.id,
        instructions = def.instructions,
    )
}

/// Compose a subagent's system prompt by appending its role specialisation to
/// the base harness prompt. Keeping the base intact preserves the identity
/// guard, workspace root, tool conventions, skills, and project rules — the
/// child inherits the parent's prompt rather than a thinner second one.
pub fn build_system_prompt(def: &Subagent, base: &str) -> String {
    format!(
        "{base}\n\n--- SUBAGENT ROLE ---\nYou are running as a delegated subagent (\"{id}\"), \
spawned to handle one focused task. Stay strictly within this role and return a tight, \
self-contained result the parent agent can act on.\n\n{instructions}",
        base = base,
        id = def.id,
        instructions = def.instructions,
    )
}

/// Everything the supervisor seam needs to start one nested subagent Run.
/// Built inside the loop (which holds the parent's request) and handed to
/// `RunSupervisor::spawn_subagent`, so the loop itself never touches an
/// `AppHandle`.
#[derive(Debug, Clone)]
pub struct SubagentRunSpec {
    /// The child's Run id. The tool's `request_id`, so the transcript pair
    /// (`SubagentRequested` / `SubagentResolved`) and the child Run share one id.
    pub run_id: String,
    /// The parent Run id — Mission Control nests children by this.
    pub parent_id: String,
    pub workspace_root: Option<String>,
    pub mode: AgentMode,
    pub provider: String,
    pub model: String,
    /// The focused task text the parent asked for.
    pub task: String,
    /// Parent's system prompt with the role block appended.
    pub system_prompt: String,
    /// Inherited from the parent so a child cannot outlive the parent's budget.
    pub max_turns: Option<usize>,
    pub require_diff_review: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_every_builtin_by_id_case_insensitively() {
        for def in ALL {
            assert_eq!(resolve(def.id).map(|d| d.id), Some(def.id));
            assert_eq!(resolve(&def.id.to_uppercase()).map(|d| d.id), Some(def.id));
            assert_eq!(resolve(&format!("  {}  ", def.id)).map(|d| d.id), Some(def.id));
        }
    }

    #[test]
    fn unknown_id_resolves_to_none() {
        assert!(resolve("architect").is_none());
        assert!(resolve("").is_none());
    }

    #[test]
    fn ids_are_unique() {
        let mut seen: Vec<&str> = ALL.iter().map(|s| s.id).collect();
        let before = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(before, seen.len(), "duplicate subagent id in ALL");
    }

    #[test]
    fn only_read_only_roles_are_model_selectable() {
        // The tool description promises a delegate that cannot edit. Editing
        // roles must stay off the model's menu even as roles are added.
        let selectable = model_selectable_ids();
        assert!(selectable.contains(&"explorer"));
        assert!(selectable.contains(&"reviewer"));
        assert!(!selectable.contains(&"implementer"));
        assert!(!selectable.contains(&"tester"));
        for id in &selectable {
            assert_eq!(resolve(id).unwrap().mode, AgentMode::Plan);
        }
    }

    #[test]
    fn workers_are_exactly_the_delegates() {
        // No brand is listed by hand: a fifth Delegate is a fifth worker.
        let delegates: Vec<&str> = crate::delegate::ALL.iter().map(|d| d.id()).collect();
        assert_eq!(worker_ids(), delegates);
        for id in worker_ids() {
            assert_eq!(resolve_worker(id).map(|w| w.id()), Some(id));
            assert_eq!(resolve_worker(&format!("  {id} ")).map(|w| w.id()), Some(id), "trimmed");
        }
        assert!(resolve_worker("gemini-cli").is_none());
    }

    #[test]
    fn with_a_worker_every_role_is_selectable() {
        let all: Vec<&str> = ALL.iter().map(|s| s.id).collect();
        assert_eq!(worker_selectable_ids(), all);
        assert!(worker_selectable_ids().contains(&"implementer"));
        assert!(worker_selectable_ids().contains(&"tester"));
    }

    #[test]
    fn worker_branch_follows_the_frontend_rule() {
        // klide/<kind>-<slug>-<suffix>: lowercase slug capped at 36, the last 8
        // alphanumerics of the request id as the suffix.
        let branch = worker_branch("Implement slugify in src/", "sub_mu2tz_call_ABC12345");
        assert_eq!(branch, "klide/worker-implement-slugify-in-src-abc12345");
        let long = worker_branch(&"x".repeat(80), "id");
        assert!(long.starts_with("klide/worker-"));
        assert!(long.len() <= "klide/worker-".len() + 36 + 1 + 8);
        assert_eq!(worker_branch("!!!", ""), "klide/worker-task-run");
    }

    #[test]
    fn a_worker_prompt_is_about_the_role_and_the_report_not_kit() {
        let def = resolve("implementer").unwrap();
        let prompt = build_worker_prompt(def, "Claude Code", Some("klide/worker-x-1"));
        assert!(prompt.starts_with("You are Claude Code"));
        assert!(prompt.contains("klide/worker-x-1"));
        assert!(prompt.contains(def.instructions));
        assert!(prompt.contains("report"));
        assert!(!prompt.contains("Kit"));
        let plain = build_worker_prompt(def, "Codex", None);
        assert!(plain.contains("not a Git repository"));
    }

    #[test]
    fn read_only_roles_stay_in_plan_mode() {
        // The explorer and reviewer are advertised as read-only; Plan mode is
        // what actually enforces it via schemas_for_mode.
        assert_eq!(resolve("explorer").unwrap().mode, AgentMode::Plan);
        assert_eq!(resolve("reviewer").unwrap().mode, AgentMode::Plan);
    }

    /// `src/agent/subagents.ts` still owns the `@mention` menu, so the same four
    /// roles are declared twice. The harness half is authoritative — it resolves
    /// the role and runs the child — but a role that exists on only one side is a
    /// silent bug: added in Rust, it never appears in the menu; added in
    /// TypeScript, `@`-mentioning it produces "Unknown subagent". Ids and modes
    /// must match, in order. Blurbs and labels are presentation and are not
    /// compared.
    #[test]
    fn subagent_ids_match_the_frontend_registry() {
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/agent/subagents.ts"),
        )
        .expect("read src/agent/subagents.ts");

        // Only the literal entries carry `id: "…"` / `mode: "…"`; the type
        // declarations above them are `id: SubagentId;` and `mode: AgentMode;`.
        fn literals<'a>(source: &'a str, key: &str) -> Vec<&'a str> {
            let needle = format!("{key}: \"");
            let mut found = Vec::new();
            let mut rest = source;
            while let Some(at) = rest.find(&needle) {
                let after = &rest[at + needle.len()..];
                let end = after.find('"').expect("unterminated string literal");
                found.push(&after[..end]);
                rest = &after[end..];
            }
            found
        }

        let ts_ids = literals(&ts, "id");
        let ts_modes = literals(&ts, "mode");
        let rust_ids: Vec<&str> = ALL.iter().map(|s| s.id).collect();
        let rust_modes: Vec<&str> = ALL
            .iter()
            .map(|s| match s.mode {
                AgentMode::Plan => "plan",
                AgentMode::Goal => "goal",
                AgentMode::Chat => "chat",
            })
            .collect();

        assert_eq!(
            ts_ids, rust_ids,
            "subagent ids drifted between src/agent/subagents.ts and agent::subagents::ALL"
        );
        assert_eq!(
            ts_modes, rust_modes,
            "subagent modes drifted between src/agent/subagents.ts and agent::subagents::ALL"
        );
    }

    #[test]
    fn build_system_prompt_keeps_the_base_and_appends_the_role() {
        let def = resolve("explorer").unwrap();
        let prompt = build_system_prompt(def, "BASE PROMPT");
        assert!(prompt.starts_with("BASE PROMPT"), "base must survive intact");
        assert!(prompt.contains("--- SUBAGENT ROLE ---"));
        assert!(prompt.contains("explorer"));
        assert!(prompt.contains("LOCATE and REPORT"));
    }
}
