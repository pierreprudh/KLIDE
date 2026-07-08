// Git — every git/gh interaction Klide makes, all shell-outs with an
// explicit `-C <workspace_root>` (no libgit2). Status/stage/commit for the
// sidebar and Git Review, log/branch/stash for the workbench, and the
// gh-backed PR commands. Read-only data is parsed into the structs below
// and serialized camelCase for the frontend.

use std::process::Command;

#[derive(serde::Serialize)]
pub(crate) struct GitFile {
    path: String,
    status: String,
    staged: bool,
}

#[derive(serde::Serialize)]
pub(crate) struct GitStatus {
    branch: String,
    files: Vec<GitFile>,
}

#[derive(serde::Serialize)]
pub(crate) struct GitDiff {
    path: String,
    diff: String,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchDiffFile {
    path: String,
    status: String,
    additions: usize,
    deletions: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchDiff {
    base_branch: String,
    branch: String,
    merge_base: String,
    diff: String,
    additions: usize,
    deletions: usize,
    files: Vec<GitBranchDiffFile>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommit {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    author_email: String,
    /// Seconds since unix epoch.
    timestamp: i64,
    refs: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranch {
    name: String,
    is_current: bool,
    is_remote: bool,
    /// Commits ahead of the upstream tracking branch (-).
    ahead: i32,
    /// Commits behind the upstream tracking branch (+).
    behind: i32,
    last_subject: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitLog {
    branch: String,
    upstream: Option<String>,
    ahead: i32,
    behind: i32,
    /// ISO-8601 timestamp of the last `git fetch`.
    last_fetch_ms: Option<i64>,
    commits: Vec<GitCommit>,
    branches: Vec<GitBranch>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStash {
    index: u32,
    branch: String,
    message: String,
    /// ISO-8601 timestamp.
    timestamp: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequest {
    number: u32,
    title: String,
    state: String,
    is_draft: bool,
    author: String,
    head_ref: String,
    base_ref: String,
    url: String,
    additions: i64,
    deletions: i64,
    changed_files: i32,
    /// Number of issue comments on the PR (drives the comment glyph).
    comments: i32,
    /// Distinct commenter logins, in first-seen order (drives the avatar stack).
    comment_authors: Vec<String>,
    /// ISO-8601 updated timestamp.
    updated_at_ms: i64,
    /// "open" | "merged" | "closed" | "draft" — derived for the badge.
    badge: String,
    /// True if this PR targets the current branch.
    is_current_branch: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrComment {
    author: String,
    body: String,
    created_at_ms: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrCommit {
    short_hash: String,
    headline: String,
    author: String,
    created_at_ms: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestDetails {
    number: u32,
    title: String,
    body: String,
    state: String,
    is_draft: bool,
    author: String,
    head_ref: String,
    base_ref: String,
    url: String,
    additions: i64,
    deletions: i64,
    changed_files: i32,
    /// Issue-comment count (mirrors PullRequest so the detail glyph matches).
    comments: i32,
    /// The actual comment thread, author + markdown body, oldest first.
    comment_thread: Vec<PrComment>,
    /// Commits on the PR, oldest first — interleaved with comments into a
    /// GitHub-style conversation timeline on the frontend.
    commits: Vec<PrCommit>,
    /// "open" | "merged" | "closed" | "draft" — derived for the badge.
    badge: String,
    mergeable: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

/// Run a blocking git/gh shell-out off the main thread. Synchronous Tauri
/// commands execute ON the main thread — a 2-second `gh pr list` there
/// freezes the whole window (input, rendering, every other invoke). Every
/// command in this module wraps its body in this.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Git task failed: {e}"))?
}

fn run_git(workspace_root: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub(crate) fn git_output(workspace_root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Resolve the `gh` binary once per session. A Finder-launched macOS `.app`
/// inherits only a minimal PATH (no `/opt/homebrew/bin`), so a bare
/// `Command::new("gh")` fails in the production bundle even when `gh` is
/// installed — which is why author avatars fell back to the initial disc and
/// the PR panel went quiet after v0.5 shipped. We resolve through the login
/// shell (the same `resolve_command` helper the delegate + MLX paths use) and
/// cache the result. Falls back to the bare name so dev (full PATH) still works
/// if the shell lookup ever fails.
fn gh_bin() -> String {
    use std::sync::OnceLock;
    static GH: OnceLock<String> = OnceLock::new();
    GH.get_or_init(|| crate::resolve_command("gh").unwrap_or_else(|_| "gh".to_string()))
        .clone()
}

fn gh_output(workspace_root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(gh_bin())
        .args(args)
        .current_dir(workspace_root)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "GitHub CLI (gh) is not installed. Install it with: brew install gh".to_string()
            } else {
                format!("Failed to run gh: {e}")
            }
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(stderr)
        }
    }
}

fn count_diff_lines(diff: &str) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;

    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }

    (additions, deletions)
}

#[tauri::command]
pub(crate) async fn git_status(workspace_root: String) -> Result<GitStatus, String> {
    blocking(move || {
        let output = Command::new("git")
            .args(["-C", &workspace_root, "status", "--short", "--branch"])
            .output()
            .map_err(|e| format!("Failed to run git: {e}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut branch = "unknown".to_string();
        let mut files = Vec::new();

        for line in stdout.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                branch = rest.split("...").next().unwrap_or(rest).trim().to_string();
                continue;
            }

            if line.len() < 4 {
                continue;
            }

            let staged = &line[0..1] != " " && &line[0..1] != "?";
            let status = line[0..2].trim().to_string();
            let path = line[3..].trim().to_string();
            files.push(GitFile {
                path,
                status,
                staged,
            });
        }

        Ok(GitStatus { branch, files })
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_stage(workspace_root: String, path: String) -> Result<(), String> {
    blocking(move || run_git(&workspace_root, &["add", "--", &path])).await
}

#[tauri::command]
pub(crate) async fn git_unstage(workspace_root: String, path: String) -> Result<(), String> {
    blocking(move || run_git(&workspace_root, &["restore", "--staged", "--", &path])).await
}

#[tauri::command]
pub(crate) async fn git_commit(workspace_root: String, message: String) -> Result<(), String> {
    blocking(move || {
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return Err("Commit message cannot be empty".to_string());
        }
        run_git(&workspace_root, &["commit", "-m", trimmed])
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_pr(
    workspace_root: String,
    title: String,
    body: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        // Create a branch from the current changes. Cap the name at 50 chars —
        // truncate() takes a BYTE index and panics mid-char on non-ASCII titles
        // (is_alphanumeric keeps accented/Unicode letters), so count chars instead.
        let branch: String = format!(
            "klide/{}",
            title
                .to_lowercase()
                .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
                .trim_matches('-')
        )
        .chars()
        .take(50)
        .collect();

        // Check if gh CLI is available
        let gh_check = Command::new(gh_bin()).arg("--version").output();
        if gh_check.is_err() || !gh_check.unwrap().status.success() {
            return Err(
                "GitHub CLI (gh) is not installed. Install it with: brew install gh".to_string(),
            );
        }

        // Commit exactly what the user staged in the Git Review UI — do NOT
        // `git add -A`. A blanket add sweeps every untracked/unstaged file in the
        // tree (scratch files, copied worktree config) into the PR commit, which is
        // the worktree-bootstrap pollution bug. The commit/PR flow is staging-driven
        // everywhere else; keep it that way here.
        let status = Command::new("git")
            .args(["-C", &workspace_root, "diff", "--cached", "--quiet"])
            .status()
            .map_err(|e| format!("Failed to check git status: {e}"))?;
        if status.success() {
            return Err("No staged changes — stage files before opening a PR.".to_string());
        }

        // Create and switch to new branch
        run_git(&workspace_root, &["checkout", "-b", &branch])?;

        // Commit the staged changes before pushing; otherwise the PR branch has no
        // new commits for GitHub to compare against the base branch.
        run_git(&workspace_root, &["commit", "-m", title.trim()])?;

        let push = Command::new("git")
            .args([
                "-C",
                &workspace_root,
                "push",
                "-u",
                "origin",
                branch.as_str(),
            ])
            .output()
            .map_err(|e| format!("Failed to push: {e}"))?;
        if !push.status.success() {
            let err = String::from_utf8_lossy(&push.stderr);
            let _ = Command::new("git")
                .args(["-C", &workspace_root, "checkout", "-"])
                .status();
            let _ = Command::new("git")
                .args(["-C", &workspace_root, "branch", "-D", branch.as_str()])
                .status();
            return Err(format!("Push failed: {}", err.trim()));
        }

        let mut gh_args = vec!["pr", "create", "--title", &title, "--head", branch.as_str()];
        let body_str;
        if let Some(b) = &body {
            body_str = b.clone();
            gh_args.push("--body");
            gh_args.push(&body_str);
        }

        let pr = Command::new(gh_bin())
            .args(gh_args)
            .current_dir(&workspace_root)
            .output()
            .map_err(|e| format!("Failed to create PR: {e}"))?;

        if pr.status.success() {
            let url = String::from_utf8_lossy(&pr.stdout).trim().to_string();
            Ok(if url.is_empty() {
                format!("PR created on branch '{branch}'")
            } else {
                url
            })
        } else {
            let err = String::from_utf8_lossy(&pr.stderr);
            Err(format!("PR creation failed: {}", err.trim()))
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_diff(
    workspace_root: String,
    path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    blocking(move || {
        let diff = if staged {
            git_output(&workspace_root, &["diff", "--cached", "--", &path])?
        } else {
            git_output(&workspace_root, &["diff", "--", &path])?
        };

        let diff = if diff.trim().is_empty() && !staged {
            let untracked = git_output(
                &workspace_root,
                &["ls-files", "--others", "--exclude-standard", "--", &path],
            )?;
            if untracked.lines().any(|line| line == path) {
                let full_path = std::path::Path::new(&workspace_root).join(&path);
                let content = std::fs::read_to_string(&full_path)
                    .map_err(|e| format!("Unable to read untracked file: {e}"))?;
                let mut out = format!(
                "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
            );
                for line in content.lines() {
                    out.push('+');
                    out.push_str(line);
                    out.push('\n');
                }
                if content.ends_with('\n') {
                    // content.lines() omits the final empty segment; no extra line is needed.
                }
                out
            } else {
                diff
            }
        } else {
            diff
        };

        let (additions, deletions) = count_diff_lines(&diff);
        Ok(GitDiff {
            path,
            diff,
            additions,
            deletions,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_branch_diff(
    workspace_root: String,
    branch: String,
    base_branch: Option<String>,
) -> Result<GitBranchDiff, String> {
    blocking(move || {
        let branch = branch.trim();
        if branch.is_empty() {
            return Err("Branch to compare is required".to_string());
        }
        // Base resolution: explicit caller choice → the fork point recorded at
        // branch creation (`branch.<name>.base`, written by git_worktree_add) →
        // the current checkout as a last guess. The recorded base is what makes
        // a worktree run diff against what it actually forked from, not
        // whatever branch the main checkout happens to be on today.
        let base_branch = match base_branch {
            Some(base) if !base.trim().is_empty() => base.trim().to_string(),
            _ => {
                let recorded = git_output(
                    &workspace_root,
                    &["config", "--get", &format!("branch.{branch}.base")],
                )
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
                if !recorded.is_empty() {
                    recorded
                } else {
                    let current = git_output(&workspace_root, &["branch", "--show-current"])?;
                    let current = current.trim();
                    if current.is_empty() {
                        return Err(
                            "Current checkout is detached; choose a base branch first.".to_string()
                        );
                    }
                    current.to_string()
                }
            }
        };

        let merge_base = git_output(&workspace_root, &["merge-base", &base_branch, branch])?;
        let merge_base = merge_base.trim().to_string();
        if merge_base.is_empty() {
            return Err(format!(
                "No merge base found between {base_branch} and {branch}."
            ));
        }

        let range = format!("{merge_base}..{branch}");
        let diff = git_output(&workspace_root, &["diff", "--find-renames", &range])?;
        let (additions, deletions) = count_diff_lines(&diff);

        let numstat = git_output(&workspace_root, &["diff", "--numstat", &range])?;
        let name_status = git_output(&workspace_root, &["diff", "--name-status", &range])?;
        let mut statuses = std::collections::HashMap::<String, String>::new();
        for line in name_status.lines() {
            let mut parts = line.split('\t');
            let Some(status) = parts.next() else { continue };
            let path = if status.starts_with('R') || status.starts_with('C') {
                let _old = parts.next();
                parts.next()
            } else {
                parts.next()
            };
            if let Some(path) = path {
                statuses.insert(path.to_string(), status.to_string());
            }
        }

        let mut files = Vec::new();
        for line in numstat.lines() {
            let mut parts = line.split('\t');
            let Some(adds) = parts.next() else { continue };
            let Some(dels) = parts.next() else { continue };
            let path = parts.collect::<Vec<_>>().join("\t");
            if path.is_empty() {
                continue;
            }
            files.push(GitBranchDiffFile {
                status: statuses
                    .get(&path)
                    .cloned()
                    .unwrap_or_else(|| "M".to_string()),
                additions: adds.parse::<usize>().unwrap_or(0),
                deletions: dels.parse::<usize>().unwrap_or(0),
                path,
            });
        }

        Ok(GitBranchDiff {
            base_branch,
            branch: branch.to_string(),
            merge_base,
            diff,
            additions,
            deletions,
            files,
        })
    })
    .await
}

// -----------------------------------------------------------------------------
// Git Review — full-window view: history, branches, sync, stash, PRs.
// -----------------------------------------------------------------------------

fn parse_porcelain_timestamp(s: &str) -> i64 {
    // `git log --format=%ct` returns a unix timestamp in seconds.
    s.trim().parse::<i64>().unwrap_or(0)
}

fn parse_rev_list_ahead_behind(raw: &str) -> (i32, i32) {
    let mut it = raw.split_whitespace();
    let behind = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let ahead = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn parse_tracking_ahead_behind(raw: &str) -> (i32, i32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in raw.split(',').map(str::trim) {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

fn ahead_behind_for_ref(workspace_root: &str, upstream: &str, reference: &str) -> (i32, i32) {
    if upstream.is_empty() || reference.is_empty() {
        return (0, 0);
    }
    let range = format!("{upstream}...{reference}");
    git_output(
        workspace_root,
        &["rev-list", "--left-right", "--count", &range],
    )
    .map(|raw| parse_rev_list_ahead_behind(&raw))
    .unwrap_or((0, 0))
}

fn resolve_git_log(workspace_root: &str, limit: usize) -> Result<GitLog, String> {
    // Branches — current, local, remote. Keep this format conservative: older
    // Git builds do not support `%(ahead:integer)` / `%(behind:integer)`.
    let branch_out = git_output(
        workspace_root,
        &[
            "for-each-ref",
            "--format=%(HEAD)%00%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut branches: Vec<GitBranch> = Vec::new();
    for line in branch_out.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 6 {
            continue;
        }
        let is_current = parts[0] == "*";
        let refname = parts[1];
        if refname.starts_with("refs/remotes/") && refname.ends_with("/HEAD") {
            continue;
        }
        let name = parts[2].to_string();
        // Skip the HEAD remote pointer (e.g. "origin/main" pointing to where
        // origin/main currently is on the remote); the user wants real refs.
        let is_remote = refname.starts_with("refs/remotes/");
        let tracking = parts[4].trim();
        let (ahead, behind) = if is_remote {
            (0, 0)
        } else {
            parse_tracking_ahead_behind(tracking)
        };
        branches.push(GitBranch {
            name,
            is_current,
            is_remote,
            ahead,
            behind,
            last_subject: parts[5].to_string(),
        });
    }
    // Local branches first, then remotes — but keep the current branch pinned
    // at the very top of the local group.
    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_remote.cmp(&b.is_remote))
            .then(a.name.cmp(&b.name))
    });

    // Commits — use a custom format so we can pull refs (tags, branch tips) in
    // the same pass.
    let log_out = git_output(
        workspace_root,
        &[
            "log",
            &format!("-n{limit}"),
            "--date=unix",
            "--decorate=short",
            "--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%ct%x00%d",
        ],
    )?;
    let mut commits: Vec<GitCommit> = Vec::new();
    for line in log_out.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 7 {
            continue;
        }
        // The decorate field looks like " (HEAD -> main, origin/main, tag: v1)"
        // — strip the parens and the leading "HEAD ->" marker, then split on
        // commas and trim. Filter to refs that are real names.
        let refs: Vec<String> = parts[6]
            .trim()
            .trim_matches('(')
            .trim_matches(')')
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "HEAD")
            .collect();
        commits.push(GitCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            author_email: parts[4].to_string(),
            timestamp: parse_porcelain_timestamp(parts[5]),
            refs,
        });
    }

    // Current branch + upstream.
    let branch = git_output(workspace_root, &["branch", "--show-current"])?;
    let branch = branch.trim().to_string();
    let branch = if branch.is_empty() {
        "HEAD".to_string()
    } else {
        branch
    };
    let upstream = git_output(
        workspace_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok();
    let upstream = upstream
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // ahead/behind relative to upstream.
    let (ahead, behind) = match &upstream {
        Some(up) => ahead_behind_for_ref(workspace_root, up, "HEAD"),
        None => (0, 0),
    };

    // Last fetch — use the mtime of .git/FETCH_HEAD. We never write that
    // ourselves; it only ever gets touched by `git fetch`.
    let last_fetch_ms = std::path::Path::new(workspace_root)
        .join(".git")
        .join("FETCH_HEAD")
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);

    Ok(GitLog {
        branch,
        upstream,
        ahead,
        behind,
        last_fetch_ms,
        commits,
        branches,
    })
}

#[tauri::command]
pub(crate) async fn git_log(
    workspace_root: String,
    limit: Option<usize>,
) -> Result<GitLog, String> {
    blocking(move || {
        let limit = limit.unwrap_or(60).clamp(5, 500);
        resolve_git_log(&workspace_root, limit)
    })
    .await
}

/// One commit in the history graph — like [`GitCommit`] but with parent
/// hashes, which is what lets the frontend lay out branch/merge lanes.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphCommit {
    hash: String,
    short_hash: String,
    parents: Vec<String>,
    subject: String,
    author: String,
    /// Drives the author avatar lookup (GitHub noreply / Gravatar).
    author_email: String,
    timestamp: i64,
    /// Decorations on this commit: "HEAD -> main", "origin/main", "tag: v1".
    refs: Vec<String>,
}

fn parse_graph_log(out: &str) -> Vec<GraphCommit> {
    let mut commits = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 8 {
            continue;
        }
        let refs: Vec<String> = parts[7]
            .trim()
            .trim_matches('(')
            .trim_matches(')')
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "HEAD")
            .collect();
        commits.push(GraphCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            parents: parts[2].split_whitespace().map(str::to_string).collect(),
            subject: parts[3].to_string(),
            author: parts[4].to_string(),
            author_email: parts[5].to_string(),
            timestamp: parse_porcelain_timestamp(parts[6]),
            refs,
        });
    }
    commits
}

/// Commit history across ALL refs in topological order, with parent hashes —
/// the input for the Git Review history graph. `--topo-order` keeps each
/// branch's commits contiguous so the lane layout stays stable.
#[tauri::command]
pub(crate) async fn git_graph(
    workspace_root: String,
    limit: Option<usize>,
) -> Result<Vec<GraphCommit>, String> {
    blocking(move || {
        let limit = limit.unwrap_or(200).clamp(10, 1000);
        let out = git_output(
            &workspace_root,
            &[
                "log",
                "--all",
                "--topo-order",
                &format!("-n{limit}"),
                "--date=unix",
                "--decorate=short",
                "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%ae%x00%ct%x00%d",
            ],
        )?;
        Ok(parse_graph_log(&out))
    })
    .await
}

/// One changed file inside a commit.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitFile {
    path: String,
    /// Single-letter git status: M, A, D, R…
    status: String,
    additions: i64,
    deletions: i64,
}

/// Everything the history graph's detail pane shows for one commit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitDetails {
    hash: String,
    short_hash: String,
    subject: String,
    /// Commit message body after the subject line; may be empty.
    body: String,
    author: String,
    author_email: String,
    /// Seconds since unix epoch.
    timestamp: i64,
    refs: Vec<String>,
    files: Vec<CommitFile>,
    diff: String,
    additions: usize,
    deletions: usize,
}

/// Zip `--name-status` (status letter + path) with `--numstat` (per-file
/// +/- counts). Both list files in the same diff order, so they merge by
/// index; numstat shows "-" for binary files, which becomes 0.
fn merge_commit_files(name_status: &str, numstat: &str) -> Vec<CommitFile> {
    let counts: Vec<(i64, i64)> = numstat
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut cols = l.split('\t');
            let add = cols.next().and_then(|c| c.parse().ok()).unwrap_or(0);
            let del = cols.next().and_then(|c| c.parse().ok()).unwrap_or(0);
            (add, del)
        })
        .collect();
    name_status
        .lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .filter_map(|(i, l)| {
            let mut cols = l.split('\t');
            let status = cols.next()?.trim();
            // Renames carry two paths (old, new) — show the new one.
            let path = cols.last()?.trim();
            let (additions, deletions) = counts.get(i).copied().unwrap_or((0, 0));
            Some(CommitFile {
                path: path.to_string(),
                status: status.chars().next().unwrap_or('M').to_string(),
                additions,
                deletions,
            })
        })
        .collect()
}

/// One (commit, author-email) pair the frontend wants an avatar for.
#[derive(serde::Deserialize)]
pub(crate) struct AvatarQuery {
    hash: String,
    email: String,
}

/// Resolve commit authors to their REAL GitHub account pictures. GitHub is
/// the only party that can map a commit to an account (it works even when
/// the author's email is private), via the commit endpoint's `author` field.
/// Results — including misses — are cached per email for the app's lifetime,
/// so each unique author costs one `gh api` call ever.
#[tauri::command]
pub(crate) async fn github_commit_avatars(
    workspace_root: String,
    queries: Vec<AvatarQuery>,
) -> Result<std::collections::HashMap<String, String>, String> {
    blocking(move || {
        use std::collections::HashMap;
        use std::sync::{Mutex, OnceLock};
        static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

        let mut out = HashMap::new();
        let mut misses: Vec<(String, String)> = Vec::new();
        {
            let cache = cache.lock().map_err(|_| "avatar cache poisoned")?;
            let mut seen = std::collections::HashSet::new();
            for q in &queries {
                let email = q.email.trim().to_lowercase();
                if email.is_empty() || !seen.insert(email.clone()) {
                    continue;
                }
                match cache.get(&email) {
                    Some(Some(url)) => {
                        out.insert(email, url.clone());
                    }
                    Some(None) => {}
                    None => misses.push((email, q.hash.clone())),
                }
            }
        }

        // Each lookup is a network round-trip (~0.5s); cap the batch so one
        // giant repo can't stall this blocking task for a minute. Uncached
        // stragglers resolve on a later call.
        for (email, hash) in misses.into_iter().take(12) {
            let url = gh_output(
                &workspace_root,
                &[
                    "api",
                    &format!("repos/{{owner}}/{{repo}}/commits/{hash}"),
                    "--jq",
                    ".author.avatar_url",
                ],
            )
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "null");
            if let Some(url) = &url {
                out.insert(email.clone(), url.clone());
            }
            if let Ok(mut cache) = cache.lock() {
                cache.insert(email, url);
            }
        }
        Ok(out)
    })
    .await
}

/// Full detail for one commit: metadata, changed files with counts, and the
/// patch. `-m --first-parent` makes merge commits show their diff against
/// the first parent instead of an (empty) combined diff.
#[tauri::command]
pub(crate) async fn git_commit_details(
    workspace_root: String,
    hash: String,
) -> Result<CommitDetails, String> {
    blocking(move || {
        let meta = git_output(
            &workspace_root,
            &[
                "show",
                "-s",
                "--date=unix",
                "--decorate=short",
                "--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%ct%x00%d%x00%b",
                &hash,
            ],
        )?;
        // %b (the body) goes last because it can span lines; splitn keeps it whole.
        let parts: Vec<&str> = meta.splitn(8, '\0').collect();
        if parts.len() < 8 {
            return Err("Unexpected `git show` output".to_string());
        }
        let refs: Vec<String> = parts[6]
            .trim()
            .trim_matches('(')
            .trim_matches(')')
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "HEAD")
            .collect();

        let show = |extra: &str| {
            git_output(
                &workspace_root,
                &["show", extra, "--format=", "-m", "--first-parent", &hash],
            )
        };
        let name_status = show("--name-status")?;
        let numstat = show("--numstat")?;
        let diff = show("--patch")?;
        let (additions, deletions) = count_diff_lines(&diff);

        Ok(CommitDetails {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            subject: parts[2].to_string(),
            body: parts[7].trim().to_string(),
            author: parts[3].to_string(),
            author_email: parts[4].to_string(),
            timestamp: parse_porcelain_timestamp(parts[5]),
            refs,
            files: merge_commit_files(&name_status, &numstat),
            diff,
            additions,
            deletions,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_checkout_branch(
    workspace_root: String,
    branch: String,
) -> Result<(), String> {
    blocking(move || {
        if branch.is_empty() {
            return Err("Branch name is required".to_string());
        }
        run_git(&workspace_root, &["checkout", &branch])
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_fetch(
    workspace_root: String,
    remote: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        let remote = remote.unwrap_or_else(|| "--all".to_string());
        run_git(&workspace_root, &["fetch", &remote])?;
        Ok(format!("Fetched {remote}"))
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pull(workspace_root: String) -> Result<String, String> {
    blocking(move || {
        run_git(&workspace_root, &["pull", "--ff-only"])?;
        Ok("Pulled (fast-forward)".to_string())
    })
    .await
}

/// The folder name git would create when cloning `url`: the last path segment
/// with any trailing `.git` removed.
fn repo_dir_name(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next().unwrap_or(trimmed);
    last.trim_end_matches(".git").to_string()
}

/// Create a new project folder named `name` inside `parent_dir`, initialise a
/// git repo, and return the new folder's absolute path. The name is restricted
/// to a single path segment so we never write outside the chosen location.
#[tauri::command]
pub(crate) async fn project_create(parent_dir: String, name: String) -> Result<String, String> {
    blocking(move || {
        let name = name.trim();
        if name.is_empty() {
            return Err("Project name can't be empty".into());
        }
        if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
            return Err("Project name can't contain slashes".into());
        }
        let parent = std::path::Path::new(&parent_dir);
        if !parent.is_dir() {
            return Err("That location isn't a folder".into());
        }
        let target = parent.join(name);
        if target.exists() {
            return Err(format!("\"{name}\" already exists here"));
        }
        std::fs::create_dir(&target).map_err(|e| format!("Couldn't create the folder: {e}"))?;
        // Best-effort `git init` — a missing git binary shouldn't fail the create.
        let _ = run_git(&target.to_string_lossy(), &["init"]);
        Ok(target.to_string_lossy().to_string())
    })
    .await
}

/// Clone `url` into `parent_dir` and return the path of the created repo.
#[tauri::command]
pub(crate) async fn project_clone(url: String, parent_dir: String) -> Result<String, String> {
    blocking(move || {
        let url = url.trim();
        if url.is_empty() {
            return Err("Repository URL can't be empty".into());
        }
        let parent = std::path::Path::new(&parent_dir);
        if !parent.is_dir() {
            return Err("That location isn't a folder".into());
        }
        let target = parent.join(repo_dir_name(url));
        if target.exists() {
            return Err(format!(
                "\"{}\" already exists here",
                target
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("repo")
            ));
        }
        let output = Command::new("git")
            .arg("-C")
            .arg(parent)
            .args(["clone", url])
            .output()
            .map_err(|e| format!("Failed to run git: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        if target.is_dir() {
            Ok(target.to_string_lossy().to_string())
        } else {
            Err("Clone finished but the new folder couldn't be located".into())
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_push(workspace_root: String) -> Result<String, String> {
    blocking(move || {
        // `git push` follows the upstream if configured; if not, this errors and
        // the UI surfaces a clear message. The user can set upstream via
        // `git push -u origin <branch>` if needed.
        run_git(&workspace_root, &["push"])?;
        Ok("Pushed".to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_discard(workspace_root: String, path: String) -> Result<(), String> {
    blocking(move || {
        if path.is_empty() {
            return Err("Path is required".to_string());
        }
        // `git checkout -- <path>` restores the working tree to the index. For
        // untracked files we just remove them.
        if path == "." {
            run_git(&workspace_root, &["checkout", "--", "."])?;
            run_git(&workspace_root, &["clean", "-fd"])?;
        } else {
            run_git(&workspace_root, &["checkout", "--", &path])?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_stash(
    workspace_root: String,
    action: String,
    message: Option<String>,
) -> Result<String, String> {
    blocking(move || match action.as_str() {
        "push" => {
            let msg = message.unwrap_or_else(|| "WIP".to_string());
            run_git(&workspace_root, &["stash", "push", "-m", &msg])?;
            Ok(format!("Stashed as '{msg}'"))
        }
        "pop" => {
            run_git(&workspace_root, &["stash", "pop"])?;
            Ok("Stash popped".to_string())
        }
        "apply" => {
            run_git(&workspace_root, &["stash", "apply"])?;
            Ok("Stash applied".to_string())
        }
        "drop" => {
            run_git(&workspace_root, &["stash", "drop"])?;
            Ok("Stash dropped".to_string())
        }
        "list" => git_output(&workspace_root, &["stash", "list"]),
        _ => Err(format!("Unknown stash action: {action}")),
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_stash_list(workspace_root: String) -> Result<Vec<GitStash>, String> {
    blocking(move || {
        // Format: "stash@{0}|branch|message" — but messages can contain pipes, so
        // we use a 0x1f separator (unit separator) which is never in a commit
        // subject.
        let out = git_output(&workspace_root, &["stash", "list", "--format=%gd|%s|%ct"])?;
        let mut stashes: Vec<GitStash> = Vec::new();
        for line in out.lines() {
            if line.is_empty() {
                continue;
            }
            let mut parts = line.splitn(3, '|');
            let ref_name = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            let ts = parts.next().unwrap_or("0");
            let index = ref_name
                .trim_start_matches("stash@{")
                .trim_end_matches('}')
                .parse::<u32>()
                .unwrap_or(0);
            // The "branch" half is everything before the first ":" in the
            // default stash subject ("WIP on main: abc1234 subject").
            let branch = subject
                .split(':')
                .next()
                .unwrap_or("")
                .replace("WIP on ", "")
                .replace("On ", "")
                .trim()
                .to_string();
            stashes.push(GitStash {
                index,
                branch,
                message: subject,
                timestamp: ts.parse().unwrap_or(0),
            });
        }
        Ok(stashes)
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_list(workspace_root: String) -> Result<Vec<PullRequest>, String> {
    blocking(move || {
    let json = gh_output(
        &workspace_root,
        &[
            "pr",
            "list",
            // Without `--state` gh only returns OPEN PRs, so merged/closed ones
            // never reached the "Merged"/"All" tabs. Pull every state; cap the
            // batch so a busy repo can't stall this off-thread call.
            "--state",
            "all",
            "--limit",
            "50",
            "--json",
            "number,title,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,comments,updatedAt",
        ],
    )?;
    let raw: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Could not parse `gh pr list` output: {e}"))?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    let current_branch = git_output(&workspace_root, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut prs: Vec<PullRequest> = Vec::with_capacity(arr.len());
    for v in arr {
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let number = obj.get("number").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let title = obj
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let state = obj
            .get("state")
            .and_then(|x| x.as_str())
            .unwrap_or("OPEN")
            .to_string();
        let is_draft = obj
            .get("isDraft")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let author = obj
            .get("author")
            .and_then(|x| x.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();
        let head_ref = obj
            .get("headRefName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let base_ref = obj
            .get("baseRefName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let url = obj
            .get("url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let additions = obj.get("additions").and_then(|x| x.as_i64()).unwrap_or(0);
        let deletions = obj.get("deletions").and_then(|x| x.as_i64()).unwrap_or(0);
        let changed_files = obj
            .get("changedFiles")
            .and_then(|x| x.as_i64())
            .unwrap_or(0) as i32;
        let comment_arr = obj.get("comments").and_then(|x| x.as_array());
        let comments = comment_arr.map(|a| a.len()).unwrap_or(0) as i32;
        // Distinct commenter logins in first-seen order — feeds the avatar stack.
        let mut comment_authors: Vec<String> = Vec::new();
        if let Some(arr) = comment_arr {
            for c in arr {
                if let Some(login) = c.get("author").and_then(|a| a.get("login")).and_then(|a| a.as_str()) {
                    let login = login.to_string();
                    if !login.is_empty() && !comment_authors.contains(&login) {
                        comment_authors.push(login);
                    }
                }
            }
        }
        let updated_at_ms = obj
            .get("updatedAt")
            .and_then(|x| x.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0);
        let badge = if is_draft {
            "draft".to_string()
        } else {
            state.to_lowercase()
        };
        prs.push(PullRequest {
            number,
            title,
            state,
            is_draft,
            author,
            head_ref: head_ref.clone(),
            base_ref,
            url,
            additions,
            deletions,
            changed_files,
            comments,
            comment_authors,
            updated_at_ms,
            badge,
            is_current_branch: !current_branch.is_empty() && head_ref == current_branch,
        });
    }
    // Mixed states come back grouped by state; sort newest-first so the panel
    // reads chronologically regardless of the open/merged/closed mix.
    prs.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(prs)
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_view(
    workspace_root: String,
    number: u32,
) -> Result<PullRequestDetails, String> {
    blocking(move || {
    let json = gh_output(
        &workspace_root,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "number,title,body,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,comments,commits,mergeable,createdAt,updatedAt",
        ],
    )?;
    let obj: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Could not parse `gh pr view` output: {e}"))?;
    let obj = match obj.as_object() {
        Some(o) => o,
        None => return Err(format!("PR #{number} not found")),
    };
    let commits: Vec<PrCommit> = obj
        .get("commits")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|c| {
                    let oid = c.get("oid").and_then(|o| o.as_str()).unwrap_or("");
                    PrCommit {
                        short_hash: oid.chars().take(7).collect(),
                        headline: c
                            .get("messageHeadline")
                            .and_then(|m| m.as_str())
                            .unwrap_or("")
                            .to_string(),
                        // `authors` is the co-author list; take the first login.
                        author: c
                            .get("authors")
                            .and_then(|a| a.as_array())
                            .and_then(|a| a.first())
                            .and_then(|a| a.get("login"))
                            .and_then(|a| a.as_str())
                            .unwrap_or("")
                            .to_string(),
                        created_at_ms: c
                            .get("committedDate")
                            .and_then(|s| s.as_str())
                            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                            .map(|d| d.timestamp_millis())
                            .unwrap_or(0),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let comment_thread: Vec<PrComment> = obj
        .get("comments")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|c| PrComment {
                    author: c
                        .get("author")
                        .and_then(|a| a.get("login"))
                        .and_then(|a| a.as_str())
                        .unwrap_or("unknown")
                        .to_string(),
                    body: c.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string(),
                    created_at_ms: c
                        .get("createdAt")
                        .and_then(|s| s.as_str())
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.timestamp_millis())
                        .unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    let state = obj
        .get("state")
        .and_then(|x| x.as_str())
        .unwrap_or("OPEN")
        .to_string();
    let is_draft = obj
        .get("isDraft")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let badge = if is_draft {
        "draft".to_string()
    } else {
        state.to_lowercase()
    };
    Ok(PullRequestDetails {
        number: obj.get("number").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        title: obj
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        body: obj
            .get("body")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        state,
        is_draft,
        author: obj
            .get("author")
            .and_then(|x| x.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
        head_ref: obj
            .get("headRefName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        base_ref: obj
            .get("baseRefName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        url: obj
            .get("url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        additions: obj.get("additions").and_then(|x| x.as_i64()).unwrap_or(0),
        deletions: obj.get("deletions").and_then(|x| x.as_i64()).unwrap_or(0),
        changed_files: obj
            .get("changedFiles")
            .and_then(|x| x.as_i64())
            .unwrap_or(0) as i32,
        comments: comment_thread.len() as i32,
        comment_thread,
        commits,
        badge,
        mergeable: obj
            .get("mergeable")
            .and_then(|x| x.as_str())
            .unwrap_or("UNKNOWN")
            .to_string(),
        created_at_ms: obj
            .get("createdAt")
            .and_then(|x| x.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0),
        updated_at_ms: obj
            .get("updatedAt")
            .and_then(|x| x.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0),
    })
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_checkout(workspace_root: String, number: u32) -> Result<String, String> {
    blocking(move || {
        let out = gh_output(&workspace_root, &["pr", "checkout", &number.to_string()])?;
        Ok(out.trim().to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_merge(
    workspace_root: String,
    number: u32,
    method: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        let method = method.unwrap_or_else(|| "merge".to_string());
        let flag = match method.as_str() {
            "merge" => "--merge",
            "squash" => "--squash",
            "rebase" => "--rebase",
            other => return Err(format!("Unknown merge method: {other}")),
        };
        let out = gh_output(
            &workspace_root,
            &["pr", "merge", &number.to_string(), flag, "--delete-branch"],
        )?;
        Ok(out.trim().to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_open(workspace_root: String, number: u32) -> Result<String, String> {
    blocking(move || {
        // `gh pr view --web` opens the PR in the default browser; we return the
        // resolved URL so the UI can show a toast.
        let url = gh_output(
            &workspace_root,
            &[
                "pr",
                "view",
                &number.to_string(),
                "--json",
                "url",
                "-q",
                ".url",
            ],
        )?;
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err(format!("PR #{number} has no URL"));
        }
        Command::new("open")
            .arg(&url)
            .output()
            .or_else(|_| Command::new("xdg-open").arg(&url).output())
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        Ok(url)
    })
    .await
}

#[tauri::command]
pub(crate) async fn git_pr_merged(workspace_root: String, number: u32) -> Result<bool, String> {
    blocking(move || {
        // `gh pr view <n> --json merged -q .merged` is the cheapest signal.
        let raw = gh_output(
            &workspace_root,
            &[
                "pr",
                "view",
                &number.to_string(),
                "--json",
                "merged",
                "-q",
                ".merged",
            ],
        )?;
        Ok(raw.trim().eq_ignore_ascii_case("true"))
    })
    .await
}

// ── Worktrees (the "fleet" primitive) ───────────────────────────────────
//
// A worktree is just a second checkout of the repo on its own branch, in its
// own directory — so a delegate/Klide run launched with that directory as its
// cwd works on an isolated branch without touching the main checkout. Klide
// places them in a SIBLING dir, `<repo>-worktrees/<name>`, deliberately
// OUTSIDE the checkout: a worktree inside the repo dumps a full duplicate
// tree into whatever is watching the workspace (Klide's own file explorer, a
// `vite`/`cargo` dev watcher when Klide edits itself), which trips reloads and
// pollutes search. Outside, none of that fires and no `.gitignore` dance is
// needed. The read side already exists: `delegate::runs::worktree_label`
// labels a run by the worktree it ran in (it reads the `.git` pointer, so the
// location doesn't matter).

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeInfo {
    /// Absolute path to the worktree checkout — pass this as a run's cwd.
    pub path: String,
    /// Branch checked out there (empty for a detached HEAD).
    pub branch: String,
    /// Untracked config files copied in from the main checkout (e.g. `.env`),
    /// so a fresh worktree can actually build. Empty when nothing was copied.
    #[serde(default)]
    pub bootstrapped: Vec<String>,
}

/// Copy small untracked config files (e.g. `.env`) from the main checkout into
/// a fresh worktree. A worktree has every TRACKED file but none of the
/// gitignored secrets/config a build needs — the #1 reason a fresh worktree
/// won't run. Top-level files only (no `/` or `..`, so this can't be coaxed
/// into writing outside the worktree); skips any already present in the
/// worktree or missing from the source. Returns the names actually copied.
fn bootstrap_worktree_files(
    source_root: &str,
    worktree: &std::path::Path,
    files: &[String],
) -> Vec<String> {
    let mut copied = Vec::new();
    for name in files {
        let name = name.trim();
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            continue;
        }
        let src = std::path::Path::new(source_root).join(name);
        let dst = worktree.join(name);
        if src.is_file() && !dst.exists() && std::fs::copy(&src, &dst).is_ok() {
            copied.push(name.to_string());
        }
    }
    copied
}

/// Default config files Klide copies into a new worktree when the caller
/// doesn't specify a list. The common local-secret/config names.
fn default_worktree_copy_files() -> Vec<String> {
    [
        ".env",
        ".env.local",
        ".env.development",
        ".env.development.local",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Turn a branch name into one safe directory segment for the worktree dir.
/// Keeps `[A-Za-z0-9._-]`; every other run of characters (including `/`)
/// collapses to a single `-`. Never empty.
fn worktree_dir_name(branch: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in branch.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "worktree".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Create a worktree on `branch` and return its checkout path. If the branch
/// already exists it is checked out; otherwise it's created off the current
/// HEAD. Idempotent on the directory: an existing checkout at the target path
/// is returned as-is rather than re-added.
#[tauri::command]
pub(crate) async fn git_worktree_add(
    workspace_root: String,
    branch: String,
    copy_files: Option<Vec<String>>,
) -> Result<WorktreeInfo, String> {
    blocking(move || {
        let branch = branch.trim();
        if branch.is_empty() {
            return Err("Worktree branch name is required".to_string());
        }
        let toplevel = git_output(&workspace_root, &["rev-parse", "--show-toplevel"])?
            .trim()
            .to_string();
        if toplevel.is_empty() {
            return Err("Not inside a git repository".to_string());
        }
        let copy_files = copy_files.unwrap_or_else(default_worktree_copy_files);

        // A worktree dir deleted by hand (rm -rf, Finder) leaves a stale
        // registration that keeps its branch claimed — re-creating a worktree on
        // that branch then fails with "already checked out". Prune first so the
        // add always starts from git's real on-disk state. Warn-only.
        let _ = run_git(&toplevel, &["worktree", "prune"]);

        // Sibling of the checkout: `<repo>-worktrees/<name>`. Outside the repo so
        // it never trips a file watcher or shows up in the workspace tree.
        let dir = std::path::PathBuf::from(format!("{toplevel}-worktrees"))
            .join(worktree_dir_name(branch));
        let path = dir.to_string_lossy().to_string();

        // Already checked out here → reuse, so the action is safe to re-trigger.
        // Report the branch actually on disk, not the requested name: two distinct
        // branch names can sanitise to the same dir, so echoing the request could
        // mislabel the existing checkout. Still top up any config files missing
        // from the reused checkout.
        if dir.join(".git").exists() {
            let actual = git_output(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|_| branch.to_string());
            let bootstrapped = bootstrap_worktree_files(&toplevel, &dir, &copy_files);
            return Ok(WorktreeInfo {
                path,
                branch: if actual == "HEAD" {
                    String::new()
                } else {
                    actual
                },
                bootstrapped,
            });
        }
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create worktrees dir: {e}"))?;
        }

        // Does the branch already exist? Decides -b (create) vs plain (check out).
        let branch_exists = run_git(
            &toplevel,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok();
        // Capture what HEAD is on *before* the add, so a newly created branch can
        // record what it forked from. None on a detached HEAD.
        let base_branch = git_output(&toplevel, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|s| s.trim().to_string())
            .ok()
            .filter(|b| !b.is_empty() && b != "HEAD");

        let args: Vec<&str> = if branch_exists {
            vec!["worktree", "add", &path, branch]
        } else {
            vec!["worktree", "add", "-b", branch, &path]
        };
        run_git(&toplevel, &args)?;

        // Post-create config — the recipe both Orca and Superset converged on
        // (docs/competitors-orca-superset.md). Worktrees share the repo's config
        // file, so both writes land once at repo scope. Warn-only: a run in a
        // worktree without them still works, just less smoothly.
        //
        // - push.autoSetupRemote: a bare `git push` from the agent's terminal
        //   publishes the branch and sets its upstream (no -u needed). Only set
        //   when unset, so a user's explicit `false` is preserved.
        // - branch.<name>.base: what the branch forked from, so review surfaces
        //   can later diff against the right base. Only recorded for branches
        //   this call created — an adopted existing branch keeps its history.
        if git_output(&toplevel, &["config", "--get", "push.autoSetupRemote"]).is_err() {
            let _ = run_git(&toplevel, &["config", "push.autoSetupRemote", "true"]);
        }
        if !branch_exists {
            if let Some(base) = base_branch {
                let key = format!("branch.{branch}.base");
                let _ = run_git(&toplevel, &["config", &key, &base]);
            }
        }

        let bootstrapped = bootstrap_worktree_files(&toplevel, &dir, &copy_files);
        Ok(WorktreeInfo {
            path,
            branch: branch.to_string(),
            bootstrapped,
        })
    })
    .await
}

/// List the repo's worktrees (parsed from `git worktree list --porcelain`),
/// main checkout included.
#[tauri::command]
pub(crate) async fn git_worktree_list(workspace_root: String) -> Result<Vec<WorktreeInfo>, String> {
    blocking(move || {
        let out = git_output(&workspace_root, &["worktree", "list", "--porcelain"])?;
        Ok(parse_worktree_list(&out))
    })
    .await
}

/// Merge a worktree's `branch` into the branch currently checked out in the
/// main `workspace_root` — the "pull the fleet's work back" action. Refuses if
/// the target has uncommitted changes (a merge would entangle them). On
/// conflict it aborts the merge, leaving the checkout exactly as it was, and
/// returns the conflicted files so resolving stays an explicit next step
/// rather than a half-finished merge sitting in the tree.
#[tauri::command]
pub(crate) async fn git_worktree_merge(
    workspace_root: String,
    branch: String,
) -> Result<String, String> {
    blocking(move || {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch to merge is required".to_string());
    }
    let dirty = git_output(&workspace_root, &["status", "--porcelain"])?;
    if !dirty.trim().is_empty() {
        return Err(
            "Main checkout has uncommitted changes — commit or stash them before merging."
                .to_string(),
        );
    }
    let target = git_output(&workspace_root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    match run_git(&workspace_root, &["merge", "--no-ff", branch]) {
        Ok(()) => Ok(format!("Merged {branch} into {target}.")),
        Err(merge_err) => {
            let conflicts =
                git_output(&workspace_root, &["diff", "--name-only", "--diff-filter=U"])
                    .unwrap_or_default();
            // Abort so the working tree is left clean, never half-merged.
            let _ = run_git(&workspace_root, &["merge", "--abort"]);
            let list: Vec<&str> = conflicts.lines().filter(|l| !l.trim().is_empty()).collect();
            if list.is_empty() {
                Err(format!("Merge failed: {merge_err}"))
            } else {
                Err(format!(
                    "Merge conflicts in {} — aborted, nothing changed. Resolve in the worktree, then retry.",
                    list.join(", ")
                ))
            }
        }
    }
    })
    .await
}

/// Remove a worktree checkout. Fails (surfacing git's message) if it has
/// uncommitted changes, unless `force`.
#[tauri::command]
pub(crate) async fn git_worktree_remove(
    workspace_root: String,
    path: String,
    force: Option<bool>,
) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["worktree", "remove"];
        if force.unwrap_or(false) {
            args.push("--force");
        }
        args.push(&path);
        run_git(&workspace_root, &args)
    })
    .await
}

/// Parse `git worktree list --porcelain`: records separated by blank lines,
/// each with `worktree <path>` and either `branch refs/heads/<name>` or
/// `detached`.
fn parse_worktree_list(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut branch = String::new();
    let mut flush = |path: &mut Option<String>, branch: &mut String| {
        if let Some(p) = path.take() {
            out.push(WorktreeInfo {
                path: p,
                branch: std::mem::take(branch),
                bootstrapped: Vec::new(),
            });
        }
    };
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch);
            path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b
                .trim()
                .strip_prefix("refs/heads/")
                .unwrap_or(b.trim())
                .to_string();
        }
    }
    flush(&mut path, &mut branch);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_dir_name_strips_dot_git_and_segments() {
        assert_eq!(repo_dir_name("https://github.com/user/klide.git"), "klide");
        assert_eq!(repo_dir_name("https://github.com/user/klide"), "klide");
        assert_eq!(repo_dir_name("git@github.com:user/klide.git"), "klide");
        assert_eq!(repo_dir_name("https://github.com/user/klide/"), "klide");
    }

    #[test]
    fn worktree_dir_name_sanitizes_and_collapses() {
        assert_eq!(worktree_dir_name("klide/fix-bug"), "klide-fix-bug");
        assert_eq!(worktree_dir_name("feature/AB_12.3"), "feature-AB_12.3");
        assert_eq!(worktree_dir_name("///"), "worktree");
        assert_eq!(worktree_dir_name("a@@@b"), "a-b");
        assert_eq!(worktree_dir_name("-trim-"), "trim");
    }

    #[test]
    fn tracking_summary_parses_ahead_and_behind() {
        assert_eq!(parse_tracking_ahead_behind("ahead 3"), (3, 0));
        assert_eq!(parse_tracking_ahead_behind("behind 2"), (0, 2));
        assert_eq!(parse_tracking_ahead_behind("ahead 3, behind 2"), (3, 2));
        assert_eq!(parse_tracking_ahead_behind(""), (0, 0));
    }

    #[test]
    fn commit_files_zip_status_with_counts() {
        let name_status = "M\tsrc/a.rs\nR100\told.txt\tnew.txt\nA\tassets/logo.png\n";
        let numstat = "10\t2\tsrc/a.rs\n0\t0\tnew.txt\n-\t-\tassets/logo.png\n";
        let files = merge_commit_files(name_status, numstat);
        assert_eq!(
            files,
            vec![
                CommitFile {
                    path: "src/a.rs".into(),
                    status: "M".into(),
                    additions: 10,
                    deletions: 2
                },
                CommitFile {
                    path: "new.txt".into(),
                    status: "R".into(),
                    additions: 0,
                    deletions: 0
                },
                CommitFile {
                    path: "assets/logo.png".into(),
                    status: "A".into(),
                    additions: 0,
                    deletions: 0
                },
            ]
        );
    }

    #[test]
    fn graph_log_parses_parents_and_refs() {
        // NUL-separated %H %h %P %s %an %ct %d — a merge commit with two
        // parents and decorations, then a root commit with none.
        let out = concat!(
            "aaa\0aa1\0bbb ccc\0Merge branch 'x'\0Pierre\0p@x.dev\01700000000\0 (HEAD -> main, origin/main)\n",
            "bbb\0bb1\0\0first\0Pierre\0p@x.dev\01690000000\0\n",
        );
        let commits = parse_graph_log(out);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(commits[0].refs, vec!["HEAD -> main", "origin/main"]);
        assert_eq!(commits[0].author_email, "p@x.dev");
        assert_eq!(commits[0].timestamp, 1_700_000_000);
        assert!(commits[1].parents.is_empty());
        assert!(commits[1].refs.is_empty());
    }

    #[test]
    fn bootstrap_copies_only_missing_top_level_files() {
        let base = std::env::temp_dir().join(format!("klide-wt-bootstrap-{}", std::process::id()));
        let src = base.join("main");
        let wt = base.join("wt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(src.join(".env"), "SECRET=1").unwrap();
        std::fs::write(src.join(".env.local"), "L=2").unwrap();
        // Already present in the worktree → must not be overwritten.
        std::fs::write(wt.join(".env.local"), "KEEP").unwrap();

        let copied = bootstrap_worktree_files(
            src.to_str().unwrap(),
            &wt,
            &[
                ".env".into(),
                ".env.local".into(),   // exists in wt → skipped
                ".env.missing".into(), // not in src → skipped
                "../escape".into(),    // traversal → rejected
                "nested/x".into(),     // not top-level → rejected
            ],
        );

        assert_eq!(copied, vec![".env".to_string()]);
        assert_eq!(
            std::fs::read_to_string(wt.join(".env")).unwrap(),
            "SECRET=1"
        );
        assert_eq!(
            std::fs::read_to_string(wt.join(".env.local")).unwrap(),
            "KEEP"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parse_worktree_list_reads_path_and_branch() {
        let porcelain = "\
worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-worktrees/klide-fix
HEAD def456
branch refs/heads/klide/fix

worktree /repo-worktrees/detached
HEAD 999aaa
detached
";
        let list = parse_worktree_list(porcelain);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].path, "/repo");
        assert_eq!(list[0].branch, "main");
        assert_eq!(list[1].branch, "klide/fix");
        assert_eq!(list[2].path, "/repo-worktrees/detached");
        assert_eq!(list[2].branch, ""); // detached → no branch
    }

    /// A throwaway git repo with one commit on `main`, for exercising the
    /// worktree commands against real git.
    fn temp_repo(name: &str) -> (std::path::PathBuf, String) {
        let base =
            std::env::temp_dir().join(format!("klide-git-test-{name}-{}", std::process::id()));
        let repo = base.join("repo");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_str().unwrap().to_string();
        run_git(&repo_s, &["init", "-b", "main"]).unwrap();
        run_git(&repo_s, &["config", "user.email", "test@klide.local"]).unwrap();
        run_git(&repo_s, &["config", "user.name", "Klide Test"]).unwrap();
        std::fs::write(repo.join("a.txt"), "hi").unwrap();
        run_git(&repo_s, &["add", "."]).unwrap();
        run_git(&repo_s, &["commit", "-m", "init"]).unwrap();
        (base, repo_s)
    }

    #[tokio::test]
    async fn worktree_add_applies_the_fleet_recipe() {
        let (base, repo) = temp_repo("wt-recipe");

        let wt = git_worktree_add(repo.clone(), "klide/test-run".into(), Some(vec![]))
            .await
            .unwrap();
        assert_eq!(wt.branch, "klide/test-run");
        assert!(std::path::Path::new(&wt.path).join(".git").exists());
        // New branch records what it forked from, and a bare `git push` from
        // the worktree will publish the branch (autoSetupRemote).
        assert_eq!(
            git_output(&repo, &["config", "--get", "branch.klide/test-run.base"])
                .unwrap()
                .trim(),
            "main"
        );
        assert_eq!(
            git_output(&repo, &["config", "--get", "push.autoSetupRemote"])
                .unwrap()
                .trim(),
            "true"
        );

        // Re-adding is idempotent: same path back, no error.
        let again = git_worktree_add(repo.clone(), "klide/test-run".into(), Some(vec![]))
            .await
            .unwrap();
        assert_eq!(again.path, wt.path);

        // A worktree dir deleted by hand leaves a stale registration that
        // claims the branch; the prune-before-add must revive it cleanly.
        std::fs::remove_dir_all(&wt.path).unwrap();
        let revived = git_worktree_add(repo.clone(), "klide/test-run".into(), Some(vec![]))
            .await
            .unwrap();
        assert_eq!(revived.path, wt.path);
        assert!(std::path::Path::new(&revived.path).join(".git").exists());

        // `<repo>-worktrees` is a sibling of the repo inside `base`, so this
        // sweeps the worktree checkouts too.
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn branch_diff_defaults_to_the_recorded_fork_base() {
        let (base, repo) = temp_repo("wt-diff-base");
        let wt = git_worktree_add(repo.clone(), "klide/diffed".into(), Some(vec![]))
            .await
            .unwrap();
        // Move main forward AFTER the fork, then commit a change in the
        // worktree — the merge-base diff must contain only the worktree's
        // change, and the base must come from branch.<name>.base, not from
        // whatever main now looks like.
        std::fs::write(std::path::Path::new(&repo).join("main-only.txt"), "m").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["commit", "-m", "main moves on"]).unwrap();
        std::fs::write(std::path::Path::new(&wt.path).join("feature.txt"), "f").unwrap();
        run_git(&wt.path, &["add", "."]).unwrap();
        run_git(&wt.path, &["commit", "-m", "worktree change"]).unwrap();

        let diff = git_branch_diff(repo.clone(), "klide/diffed".into(), None)
            .await
            .unwrap();
        assert_eq!(diff.base_branch, "main", "recorded fork base wins");
        assert!(diff.diff.contains("feature.txt"));
        assert!(
            !diff.diff.contains("main-only.txt"),
            "merge-base diff excludes base-branch drift"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn worktree_add_respects_an_explicit_autosetupremote_choice() {
        let (base, repo) = temp_repo("wt-guard");
        // The user explicitly opted out — the recipe must not clobber that.
        run_git(&repo, &["config", "push.autoSetupRemote", "false"]).unwrap();
        git_worktree_add(repo.clone(), "klide/guarded".into(), Some(vec![]))
            .await
            .unwrap();
        assert_eq!(
            git_output(&repo, &["config", "--get", "push.autoSetupRemote"])
                .unwrap()
                .trim(),
            "false"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn count_diff_lines_ignores_file_headers() {
        let diff = "\
diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,2 +1,3 @@
 context line
-removed line
+added one
+added two";
        // The +++/--- file headers must not be counted as additions/deletions;
        // the @@ hunk header and the context line count as neither.
        assert_eq!(count_diff_lines(diff), (2, 1));
    }

    #[test]
    fn count_diff_lines_empty_diff_is_zero() {
        assert_eq!(count_diff_lines(""), (0, 0));
    }

    #[test]
    fn porcelain_timestamp_parses_seconds_and_tolerates_junk() {
        assert_eq!(parse_porcelain_timestamp("1700000000"), 1_700_000_000);
        assert_eq!(parse_porcelain_timestamp("  123 "), 123); // trimmed
        assert_eq!(parse_porcelain_timestamp(""), 0); // empty → 0
        assert_eq!(parse_porcelain_timestamp("not-a-number"), 0); // junk → 0
    }
}
