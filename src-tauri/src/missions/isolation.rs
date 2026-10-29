//! Mission attempts in worktrees of their own.
//!
//! An attempt used to run in the Mission's checkout, so a rejected attempt
//! left its edits there and the next one started on top of them. Now each
//! attempt gets a worktree on its own branch, forked from the Mission branch
//! `klide/mission-<id>`, which starts at the checkout's HEAD when the first
//! attempt is dispatched. An accepted attempt's commit fast-forwards the
//! Mission branch, so a dependent task starts from the commit its
//! dependencies were accepted at. The checkout itself is never written to:
//! the operator merges the Mission branch when the work is wanted.
//!
//! Fast-forward is always possible in the normal case, because the supervisor
//! runs one attempt at a time and only acceptance moves the Mission branch. If
//! the branch moved anyway (someone committed to it), integration refuses and
//! says so; the attempt's branch is kept to merge by hand.
//!
//! Older Missions that already ran an attempt in the checkout keep doing so:
//! their accepted work may be uncommitted there, and a worktree from HEAD would
//! not see it. A folder that is not a Git repository has nothing to isolate.
//!
//! Not yet: the recipe's setup script. The copy and link steps run (they only
//! place files), but the script would execute code nobody approved for this
//! Mission, so it is skipped until plan approval shows it.

use super::{MissionEvent, MissionEventLine};

/// A prepared attempt checkout, as recorded on the journal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AttemptCheckout {
    pub path: String,
    pub branch: String,
    pub mission_branch: String,
    pub base_commit: String,
}

/// The Mission branch for `mission_id`. A sibling name, not a parent
/// directory of the attempt branches: git cannot hold both `a` and `a/b`.
pub(crate) fn mission_branch(mission_id: &str) -> String {
    format!("klide/mission-{}", ref_safe(mission_id))
}

fn attempt_branch(mission_id: &str, task_id: &str, run_id: &str) -> String {
    let short: String = run_id.chars().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
    format!("klide/mission-{}-{}-{}", ref_safe(mission_id), ref_safe(task_id), ref_safe(&short))
}

/// Keep what a ref name accepts everywhere; anything else becomes `-`.
fn ref_safe(part: &str) -> String {
    let cleaned: String = part
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() { "x".into() } else { trimmed.to_string() }
}

/// Whether the next attempt of this Mission gets its own worktree: in a Git
/// repository, unless an earlier attempt already ran in the shared checkout —
/// attached, never given a worktree, and not a dispatch that failed before
/// anything ran.
pub(crate) fn isolates(events: &[MissionEventLine], is_repo: bool) -> bool {
    if !is_repo {
        return false;
    }
    let ran_in_checkout = events.iter().any(|line| match &line.event {
        MissionEvent::AttemptAttached { run_id, .. } => !events.iter().any(|other| match &other.event {
            MissionEvent::AttemptCheckoutPrepared { run_id: id, .. }
            | MissionEvent::AttemptDispatchFailed { run_id: id, .. } => id == run_id,
            _ => false,
        }),
        _ => false,
    });
    !ran_in_checkout
}

/// The checkout recorded for `run_id`, if it had one.
pub(crate) fn checkout_for(events: &[MissionEventLine], run_id: &str) -> Option<AttemptCheckout> {
    events.iter().rev().find_map(|line| match &line.event {
        MissionEvent::AttemptCheckoutPrepared { run_id: id, path, branch, mission_branch, base_commit, .. } if id == run_id => {
            Some(AttemptCheckout {
                path: path.clone(),
                branch: branch.clone(),
                mission_branch: mission_branch.clone(),
                base_commit: base_commit.clone(),
            })
        }
        _ => None,
    })
}

/// The Mission branch, once any attempt was isolated.
pub(crate) fn recorded_mission_branch(events: &[MissionEventLine]) -> Option<String> {
    events.iter().find_map(|line| match &line.event {
        MissionEvent::AttemptCheckoutPrepared { mission_branch, .. } => Some(mission_branch.clone()),
        _ => None,
    })
}

pub(crate) fn is_repository(root: &str) -> bool {
    crate::git::git_output(root, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|out| out.trim() == "true")
}

fn toplevel(root: &str) -> Result<String, String> {
    Ok(crate::git::git_output(root, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

fn rev(root: &str, name: &str) -> Result<String, String> {
    Ok(crate::git::git_output(root, &["rev-parse", "--verify", "--quiet", &format!("{name}^{{commit}}")])?
        .trim()
        .to_string())
}

/// Make the Mission branch on its first attempt, then a worktree for the
/// attempt from its tip. `first`: no attempt of this Mission was isolated
/// yet, so a branch already carrying the name belongs to something else (a
/// deleted Mission with the same id) and is never adopted.
pub(crate) async fn prepare(checkout: &str, mission_id: &str, task_id: &str, run_id: &str, first: bool) -> Result<AttemptCheckout, String> {
    let (root, mission) = (checkout.to_string(), mission_branch(mission_id));
    let (toplevel, base, created) = crate::blocking::run(move || {
        let toplevel = toplevel(&root)?;
        let base = match rev(&toplevel, &format!("refs/heads/{mission}")) {
            Ok(_) if first => {
                return Err(format!(
                    "A branch `{mission}` already exists from something else; rename or delete it, then run the task again."
                ))
            }
            Ok(tip) => (tip, false),
            Err(_) if !first => {
                return Err(format!("The Mission branch `{mission}` is gone; this Mission cannot continue isolated."))
            }
            Err(_) => {
                let head = rev(&toplevel, "HEAD")
                    .map_err(|_| "The project has no commit yet; commit once so the Mission has a branch to start from.".to_string())?;
                crate::git::git_output(&toplevel, &["branch", &mission, &head])
                    .map_err(|e| format!("Could not create the Mission branch `{mission}`: {e}"))?;
                (head, true)
            }
        };
        Ok((toplevel, base.0, base.1))
    })
    .await?;
    let branch = attempt_branch(mission_id, task_id, run_id);
    let quiet: crate::git::SetupNotify = std::sync::Arc::new(|_| {});
    let made = crate::git::worktree_add_from_commit_core(toplevel.clone(), branch, None, None, quiet, Some(base.clone())).await;
    let info = match made {
        Ok(info) => info,
        Err(error) => {
            // A branch this call made for an attempt that never got a
            // worktree is no Mission's yet; leaving it would block the retry.
            if created {
                let mission = mission_branch(mission_id);
                let _ = crate::blocking::run(move || crate::git::git_output(&toplevel, &["branch", "-D", &mission])).await;
            }
            return Err(error);
        }
    };
    Ok(AttemptCheckout { path: info.path, branch: info.branch, mission_branch: mission_branch(mission_id), base_commit: base })
}

/// Bring an accepted attempt into the Mission branch: commit what it left
/// uncommitted, fast-forward the branch to it, then drop the attempt's
/// worktree and branch (the commit now lives on the Mission branch). Returns
/// the commit the Mission branch points at.
pub(crate) fn integrate(checkout: &str, attempt: &AttemptCheckout, run_id: &str) -> Result<String, String> {
    let toplevel = toplevel(checkout)?;
    let dirty = crate::git::git_output(&attempt.path, &["status", "--porcelain"])
        .map_err(|e| format!("Could not read the attempt's worktree: {e}"))?;
    if !dirty.trim().is_empty() {
        crate::git::git_output(&attempt.path, &["add", "-A"])?;
        let message = format!("klide: Mission attempt {run_id}\n\nKlide agent run {run_id}");
        crate::git::git_output(&attempt.path, &["commit", "-q", "-m", &message])
            .map_err(|e| format!("Could not commit the attempt's work: {e}"))?;
    }
    let tip = rev(&attempt.path, "HEAD")?;
    let branch_ref = format!("refs/heads/{}", attempt.mission_branch);
    let mission_tip = rev(&toplevel, &branch_ref)
        .map_err(|_| format!("The Mission branch `{}` is gone; merge `{}` by hand.", attempt.mission_branch, attempt.branch))?;
    if crate::git::git_output(&toplevel, &["merge-base", "--is-ancestor", &mission_tip, &tip]).is_err() {
        return Err(format!(
            "The Mission branch `{}` moved since this attempt started; `{}` was kept to merge by hand.",
            attempt.mission_branch, attempt.branch
        ));
    }
    match checked_out_at(&toplevel, &branch_ref)? {
        // Moving a branch under a working tree would leave that tree stale.
        Some(worktree) => crate::git::git_output(&worktree, &["merge", "--ff-only", "-q", &tip])
            .map(|_| ())
            .map_err(|e| format!("`{}` is checked out at {worktree} and could not fast-forward: {e}", attempt.mission_branch))?,
        None => crate::git::git_output(&toplevel, &["update-ref", &branch_ref, &tip, &mission_tip])
            .map(|_| ())
            .map_err(|e| format!("Could not move `{}`: {e}", attempt.mission_branch))?,
    }
    // Cleanup is best-effort: the work is on the Mission branch already.
    if crate::git::git_output(&toplevel, &["worktree", "remove", &attempt.path]).is_ok() {
        let _ = crate::git::git_output(&toplevel, &["branch", "-D", &attempt.branch]);
    }
    Ok(tip)
}

/// The working tree that has `branch_ref` checked out, if any.
fn checked_out_at(toplevel: &str, branch_ref: &str) -> Result<Option<String>, String> {
    let list = crate::git::git_output(toplevel, &["worktree", "list", "--porcelain"])?;
    let mut path: Option<&str> = None;
    for line in list.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p);
        } else if line.strip_prefix("branch ") == Some(branch_ref) {
            return Ok(path.map(str::to_string));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-mission-iso-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(format!("{}-worktrees", dir.display()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "t"]);
        git(&dir, &["config", "user.email", "t@t"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        dir
    }

    fn line(event: MissionEvent) -> MissionEventLine {
        MissionEventLine { schema_version: 1, mission_id: "m".into(), seq: 0, ts: 0, event }
    }

    #[test]
    fn branch_names_are_ref_safe_siblings() {
        assert_eq!(mission_branch("fix login"), "klide/mission-fix-login");
        let attempt = attempt_branch("fix login", "task:1", "run_abcdef123456");
        assert_eq!(attempt, "klide/mission-fix-login-task-1-ef123456");
        assert!(!attempt.starts_with(&format!("{}/", mission_branch("fix login"))));
    }

    #[test]
    fn a_mission_that_already_ran_in_the_checkout_stays_there() {
        let attached = line(MissionEvent::AttemptAttached { task_id: "t".into(), run_id: "r".into() });
        let prepared = line(MissionEvent::AttemptCheckoutPrepared {
            task_id: "t".into(), run_id: "r".into(), path: "/w".into(), branch: "b".into(),
            mission_branch: "m".into(), base_commit: "c".into(),
        });
        let failed = line(MissionEvent::AttemptDispatchFailed { task_id: "t".into(), run_id: "r".into(), message: "no worktree".into() });
        assert!(isolates(&[], true));
        assert!(!isolates(&[], false));
        assert!(!isolates(&[attached.clone()], true), "legacy: an attempt ran in the checkout");
        assert!(isolates(&[attached.clone(), prepared], true));
        assert!(isolates(&[attached, failed], true), "a dispatch that never ran does not downgrade the Mission");
    }

    #[tokio::test]
    async fn attempts_chain_on_the_mission_branch_and_never_touch_the_checkout() {
        let dir = repo("chain");
        let root = dir.to_str().unwrap();

        let first = prepare(root, "m1", "t1", "run_first", true).await.unwrap();
        assert_eq!(first.mission_branch, "klide/mission-m1");
        std::fs::write(Path::new(&first.path).join("b.txt"), "b\n").unwrap();
        let commit = integrate(root, &first, "run_first").unwrap();
        assert_eq!(git(&dir, &["rev-parse", "klide/mission-m1"]), commit);
        assert!(!Path::new(&first.path).exists(), "an integrated attempt's worktree is removed");
        assert!(!dir.join("b.txt").exists(), "the checkout is not written to");

        // The dependent attempt starts where the first was accepted.
        let second = prepare(root, "m1", "t2", "run_second", false).await.unwrap();
        assert_eq!(second.base_commit, commit);
        assert!(Path::new(&second.path).join("b.txt").exists());
        std::fs::write(Path::new(&second.path).join("c.txt"), "c\n").unwrap();
        integrate(root, &second, "run_second").unwrap();
        assert_eq!(git(&dir, &["show", "klide/mission-m1:c.txt"]), "c");
    }

    #[tokio::test]
    async fn a_first_attempt_never_adopts_a_branch_it_did_not_make() {
        let dir = repo("stale");
        let root = dir.to_str().unwrap();
        git(&dir, &["branch", "klide/mission-m4"]);
        let error = prepare(root, "m4", "t1", "run_one", true).await.unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        let gone = prepare(root, "m5", "t1", "run_one", false).await.unwrap_err();
        assert!(gone.contains("is gone"), "{gone}");
    }

    #[tokio::test]
    async fn a_mission_branch_that_moved_refuses_and_keeps_the_attempt() {
        let dir = repo("moved");
        let root = dir.to_str().unwrap();
        let attempt = prepare(root, "m2", "t1", "run_one", true).await.unwrap();
        std::fs::write(Path::new(&attempt.path).join("x.txt"), "x\n").unwrap();

        // Someone commits to the Mission branch meanwhile.
        git(&dir, &["switch", "-q", "klide/mission-m2"]);
        std::fs::write(dir.join("y.txt"), "y\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "by hand"]);
        git(&dir, &["switch", "-q", "main"]);

        let error = integrate(root, &attempt, "run_one").unwrap_err();
        assert!(error.contains("moved"), "{error}");
        assert!(Path::new(&attempt.path).exists(), "kept to merge by hand");
    }

    #[tokio::test]
    async fn a_checked_out_mission_branch_fast_forwards_its_working_tree() {
        let dir = repo("checked-out");
        let root = dir.to_str().unwrap();
        let attempt = prepare(root, "m3", "t1", "run_one", true).await.unwrap();
        std::fs::write(Path::new(&attempt.path).join("z.txt"), "z\n").unwrap();
        git(&dir, &["switch", "-q", "klide/mission-m3"]);
        integrate(root, &attempt, "run_one").unwrap();
        assert!(dir.join("z.txt").exists(), "the tree that has the branch moved with it");
    }
}
