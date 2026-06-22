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
    /// ISO-8601 updated timestamp.
    updated_at_ms: i64,
    /// "open" | "merged" | "closed" | "draft" — derived for the badge.
    badge: String,
    /// True if this PR targets the current branch.
    is_current_branch: bool,
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
    /// "open" | "merged" | "closed" | "draft" — derived for the badge.
    badge: String,
    mergeable: String,
    created_at_ms: i64,
    updated_at_ms: i64,
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
pub(crate) fn git_status(workspace_root: String) -> Result<GitStatus, String> {
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
}

#[tauri::command]
pub(crate) fn git_stage(workspace_root: String, path: String) -> Result<(), String> {
    run_git(&workspace_root, &["add", "--", &path])
}

#[tauri::command]
pub(crate) fn git_unstage(workspace_root: String, path: String) -> Result<(), String> {
    run_git(&workspace_root, &["restore", "--staged", "--", &path])
}

#[tauri::command]
pub(crate) fn git_commit(workspace_root: String, message: String) -> Result<(), String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    run_git(&workspace_root, &["commit", "-m", trimmed])
}

#[tauri::command]
pub(crate) fn create_pr(
    workspace_root: String,
    title: String,
    body: Option<String>,
) -> Result<String, String> {
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
    let gh_check = Command::new("gh").arg("--version").output();
    if gh_check.is_err() || !gh_check.unwrap().status.success() {
        return Err(
            "GitHub CLI (gh) is not installed. Install it with: brew install gh".to_string(),
        );
    }

    // Stage all changes
    run_git(&workspace_root, &["add", "-A"])?;

    // Check if there's anything to commit
    let status = Command::new("git")
        .args(["-C", &workspace_root, "diff", "--cached", "--quiet"])
        .status()
        .map_err(|e| format!("Failed to check git status: {e}"))?;
    if status.success() {
        return Err("No changes to commit".to_string());
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

    let pr = Command::new("gh")
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
}


#[tauri::command]
pub(crate) fn git_diff(
    workspace_root: String,
    path: String,
    staged: bool,
) -> Result<GitDiff, String> {
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
}

// -----------------------------------------------------------------------------
// Git Review — full-window view: history, branches, sync, stash, PRs.
// -----------------------------------------------------------------------------

fn parse_porcelain_timestamp(s: &str) -> i64 {
    // `git log --format=%ct` returns a unix timestamp in seconds.
    s.trim().parse::<i64>().unwrap_or(0)
}

fn resolve_git_log(workspace_root: &str, limit: usize) -> Result<GitLog, String> {
    // Branches — current, local, remote. We grab them with `for-each-ref` so
    // we can pull ahead/behind and the subject of the tip commit in one shot.
    let branch_out = git_output(
        workspace_root,
        &[
            "for-each-ref",
            "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(ahead:integer)/%(behind:integer)%00%(subject)",
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
        if parts.len() < 5 {
            continue;
        }
        let is_current = parts[0] == "*";
        let name = parts[1].to_string();
        // Skip the HEAD remote pointer (e.g. "origin/main" pointing to where
        // origin/main currently is on the remote); the user wants real refs.
        let is_remote = name.contains('/');
        let (ahead, behind) = if parts[3] == "-" {
            (0, 0)
        } else {
            let mut split = parts[3].split('/');
            (
                split.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                split.next().and_then(|n| n.parse().ok()).unwrap_or(0),
            )
        };
        branches.push(GitBranch {
            name,
            is_current,
            is_remote,
            ahead,
            behind,
            last_subject: parts[4].to_string(),
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
        Some(up) => {
            let ab = git_output(
                workspace_root,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("{up}...HEAD"),
                ],
            )
            .unwrap_or_default();
            let mut it = ab.split_whitespace();
            (
                it.next().and_then(|n| n.parse().ok()).unwrap_or(0),
                it.next().and_then(|n| n.parse().ok()).unwrap_or(0),
            )
        }
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
pub(crate) fn git_log(workspace_root: String, limit: Option<usize>) -> Result<GitLog, String> {
    let limit = limit.unwrap_or(60).clamp(5, 500);
    resolve_git_log(&workspace_root, limit)
}

#[tauri::command]
pub(crate) fn git_checkout_branch(workspace_root: String, branch: String) -> Result<(), String> {
    if branch.is_empty() {
        return Err("Branch name is required".to_string());
    }
    run_git(&workspace_root, &["checkout", &branch])
}

#[tauri::command]
pub(crate) fn git_fetch(workspace_root: String, remote: Option<String>) -> Result<String, String> {
    let remote = remote.unwrap_or_else(|| "--all".to_string());
    run_git(&workspace_root, &["fetch", &remote])?;
    Ok(format!("Fetched {remote}"))
}

#[tauri::command]
pub(crate) fn git_pull(workspace_root: String) -> Result<String, String> {
    run_git(&workspace_root, &["pull", "--ff-only"])?;
    Ok("Pulled (fast-forward)".to_string())
}

#[tauri::command]
pub(crate) fn git_push(workspace_root: String) -> Result<String, String> {
    // `git push` follows the upstream if configured; if not, this errors and
    // the UI surfaces a clear message. The user can set upstream via
    // `git push -u origin <branch>` if needed.
    run_git(&workspace_root, &["push"])?;
    Ok("Pushed".to_string())
}

#[tauri::command]
pub(crate) fn git_discard(workspace_root: String, path: String) -> Result<(), String> {
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
}

#[tauri::command]
pub(crate) fn git_stash(
    workspace_root: String,
    action: String,
    message: Option<String>,
) -> Result<String, String> {
    match action.as_str() {
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
    }
}

#[tauri::command]
pub(crate) fn git_stash_list(workspace_root: String) -> Result<Vec<GitStash>, String> {
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
}

#[tauri::command]
pub(crate) fn git_pr_list(workspace_root: String) -> Result<Vec<PullRequest>, String> {
    let json = git_output(
        &workspace_root,
        &[
            "pr",
            "list",
            "--json",
            "number,title,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,updatedAt",
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
            updated_at_ms,
            badge,
            is_current_branch: !current_branch.is_empty() && head_ref == current_branch,
        });
    }
    Ok(prs)
}

#[tauri::command]
pub(crate) fn git_pr_view(
    workspace_root: String,
    number: u32,
) -> Result<PullRequestDetails, String> {
    let json = git_output(
        &workspace_root,
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "number,title,body,state,isDraft,author,headRefName,baseRefName,url,additions,deletions,changedFiles,mergeable,createdAt,updatedAt",
        ],
    )?;
    let obj: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Could not parse `gh pr view` output: {e}"))?;
    let obj = match obj.as_object() {
        Some(o) => o,
        None => return Err(format!("PR #{number} not found")),
    };
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
}

#[tauri::command]
pub(crate) fn git_pr_checkout(workspace_root: String, number: u32) -> Result<String, String> {
    let out = git_output(&workspace_root, &["pr", "checkout", &number.to_string()])?;
    Ok(out.trim().to_string())
}

#[tauri::command]
pub(crate) fn git_pr_merge(
    workspace_root: String,
    number: u32,
    method: Option<String>,
) -> Result<String, String> {
    let method = method.unwrap_or_else(|| "merge".to_string());
    let flag = match method.as_str() {
        "merge" => "--merge",
        "squash" => "--squash",
        "rebase" => "--rebase",
        other => return Err(format!("Unknown merge method: {other}")),
    };
    let out = git_output(
        &workspace_root,
        &["pr", "merge", &number.to_string(), flag, "--delete-branch"],
    )?;
    Ok(out.trim().to_string())
}

#[tauri::command]
pub(crate) fn git_pr_open(workspace_root: String, number: u32) -> Result<String, String> {
    // `gh pr view --web` opens the PR in the default browser; we return the
    // resolved URL so the UI can show a toast.
    let url = git_output(
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
}

#[tauri::command]
pub(crate) fn git_pr_merged(workspace_root: String, number: u32) -> Result<bool, String> {
    // `gh pr view <n> --json merged -q .merged` is the cheapest signal.
    let raw = git_output(
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
    [".env", ".env.local", ".env.development", ".env.development.local"]
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
pub(crate) fn git_worktree_add(
    workspace_root: String,
    branch: String,
    copy_files: Option<Vec<String>>,
) -> Result<WorktreeInfo, String> {
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
            branch: if actual == "HEAD" { String::new() } else { actual },
            bootstrapped,
        });
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create worktrees dir: {e}"))?;
    }

    // Does the branch already exist? Decides -b (create) vs plain (check out).
    let branch_exists = run_git(
        &toplevel,
        &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")],
    )
    .is_ok();
    let args: Vec<&str> = if branch_exists {
        vec!["worktree", "add", &path, branch]
    } else {
        vec!["worktree", "add", "-b", branch, &path]
    };
    run_git(&toplevel, &args)?;

    let bootstrapped = bootstrap_worktree_files(&toplevel, &dir, &copy_files);
    Ok(WorktreeInfo {
        path,
        branch: branch.to_string(),
        bootstrapped,
    })
}

/// List the repo's worktrees (parsed from `git worktree list --porcelain`),
/// main checkout included.
#[tauri::command]
pub(crate) fn git_worktree_list(workspace_root: String) -> Result<Vec<WorktreeInfo>, String> {
    let out = git_output(&workspace_root, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktree_list(&out))
}

/// Merge a worktree's `branch` into the branch currently checked out in the
/// main `workspace_root` — the "pull the fleet's work back" action. Refuses if
/// the target has uncommitted changes (a merge would entangle them). On
/// conflict it aborts the merge, leaving the checkout exactly as it was, and
/// returns the conflicted files so resolving stays an explicit next step
/// rather than a half-finished merge sitting in the tree.
#[tauri::command]
pub(crate) fn git_worktree_merge(
    workspace_root: String,
    branch: String,
) -> Result<String, String> {
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
}

/// Remove a worktree checkout. Fails (surfacing git's message) if it has
/// uncommitted changes, unless `force`.
#[tauri::command]
pub(crate) fn git_worktree_remove(
    workspace_root: String,
    path: String,
    force: Option<bool>,
) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force.unwrap_or(false) {
        args.push("--force");
    }
    args.push(&path);
    run_git(&workspace_root, &args)
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
            branch = b.trim().strip_prefix("refs/heads/").unwrap_or(b.trim()).to_string();
        }
    }
    flush(&mut path, &mut branch);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_dir_name_sanitizes_and_collapses() {
        assert_eq!(worktree_dir_name("klide/fix-bug"), "klide-fix-bug");
        assert_eq!(worktree_dir_name("feature/AB_12.3"), "feature-AB_12.3");
        assert_eq!(worktree_dir_name("///"), "worktree");
        assert_eq!(worktree_dir_name("a@@@b"), "a-b");
        assert_eq!(worktree_dir_name("-trim-"), "trim");
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
                ".env.local".into(),     // exists in wt → skipped
                ".env.missing".into(),   // not in src → skipped
                "../escape".into(),      // traversal → rejected
                "nested/x".into(),       // not top-level → rejected
            ],
        );

        assert_eq!(copied, vec![".env".to_string()]);
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1");
        assert_eq!(std::fs::read_to_string(wt.join(".env.local")).unwrap(), "KEEP");
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
