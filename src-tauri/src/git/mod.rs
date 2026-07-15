// Git — every git interaction Klide makes, all shell-outs with an
// explicit `-C <workspace_root>` (no libgit2). Status/stage/commit for the
// sidebar and Git Review, log/branch/stash for the workbench. Read-only
// data is parsed into the structs below and serialized camelCase for the
// frontend. Everything GitHub-flavored (gh CLI, PRs, avatars) lives in the
// `github` submodule.

pub(crate) mod github;

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


/// A git-shaped diff for an UNTRACKED file (plain `git diff` shows nothing for
/// those). The `@@ -0,0 +1,N @@` hunk header is load-bearing: the frontend's
/// diff parser derives line numbers from it, and line comments anchor to those
/// numbers — without it every row parses as line 0.
fn synthesize_new_file_diff(path: &str, content: &str) -> String {
    let mut out = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
    );
    let line_count = content.lines().count();
    if line_count > 0 {
        out.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
        for line in content.lines() {
            out.push('+');
            out.push_str(line);
            out.push('\n');
        }
    }
    out
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
                synthesize_new_file_diff(&path, &content)
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
    /// Dependency dirs symlinked from the main checkout (recipe `linkDirs`).
    #[serde(default)]
    pub linked: Vec<String>,
    /// Deterministic dev-server port (recipe `portBase`), when configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// True when a recipe `setupScript` was started in the background — its
    /// outcome arrives later on the `worktree-setup:done` event.
    #[serde(default)]
    pub script_started: bool,
}

/// Payload of the `worktree-setup:done` event — the background setup script's
/// outcome, reported once it finishes (or is killed at the recipe timeout).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeSetupDone {
    path: String,
    branch: String,
    ok: bool,
    /// Combined output tail — enough to see why a setup failed.
    output: String,
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

/// How the background setup script reports its outcome. Production emits the
/// `worktree-setup:done` event; tests pass a sink — the seam that keeps the
/// worktree core drivable without a Tauri app.
type SetupNotify = std::sync::Arc<dyn Fn(WorktreeSetupDone) + Send + Sync>;

/// Apply the workspace's worktree-setup recipe to a (new or reused) checkout:
/// copy env files, link dependency dirs, derive the port, and start the setup
/// script on a background thread that reports through `notify`.
/// `copy_files` overrides the recipe's list when the caller passes one.
fn apply_worktree_setup(
    notify: SetupNotify,
    toplevel: &str,
    dir: &std::path::Path,
    branch: &str,
    copy_files: Option<Vec<String>>,
) -> (Vec<String>, Vec<String>, Option<u16>, bool) {
    use crate::worktree_setup;
    let setup = worktree_setup::load(toplevel);
    let copy = copy_files.unwrap_or_else(|| setup.copy_files.clone());
    let bootstrapped = worktree_setup::copy_files_into(toplevel, dir, &copy);
    let linked = worktree_setup::link_dirs_into(toplevel, dir, &setup.link_dirs);
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let port = setup.port_base.map(|base| worktree_setup::port_for(base, &name));

    let script_started = match setup.setup_script.clone().filter(|s| !s.trim().is_empty()) {
        Some(script) => {
            // Background: an `npm install` must not block opening the panel.
            // The outcome lands on the notify seam; the frontend toasts it.
            let envs = worktree_setup::script_env(toplevel, dir, branch, port);
            let dir = dir.to_path_buf();
            let branch = branch.to_string();
            let timeout = setup.script_timeout_secs;
            std::thread::spawn(move || {
                let outcome = worktree_setup::run_script(&script, &dir, &envs, timeout);
                notify(WorktreeSetupDone {
                    path: dir.to_string_lossy().to_string(),
                    branch,
                    ok: outcome.ok,
                    output: outcome.output,
                });
            });
            true
        }
        None => false,
    };
    (bootstrapped, linked, port, script_started)
}

/// Create a worktree on `branch` and return its checkout path. If the branch
/// already exists it is checked out; otherwise it's created off the current
/// HEAD. Idempotent on the directory: an existing checkout at the target path
/// is returned as-is rather than re-added.
#[tauri::command]
pub(crate) async fn git_worktree_add(
    app: tauri::AppHandle,
    workspace_root: String,
    branch: String,
    copy_files: Option<Vec<String>>,
) -> Result<WorktreeInfo, String> {
    use tauri::Emitter;
    let notify: SetupNotify = std::sync::Arc::new(move |done: WorktreeSetupDone| {
        let _ = app.emit("worktree-setup:done", done);
    });
    worktree_add_core(workspace_root, branch, copy_files, notify).await
}

/// The command's body behind the notify seam, so tests can drive it against a
/// real temp repo without a Tauri app.
async fn worktree_add_core(
    workspace_root: String,
    branch: String,
    copy_files: Option<Vec<String>>,
    notify: SetupNotify,
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
            let actual = if actual == "HEAD" { String::new() } else { actual };
            let (bootstrapped, linked, port, script_started) =
                apply_worktree_setup(notify, &toplevel, &dir, &actual, copy_files);
            return Ok(WorktreeInfo {
                path,
                branch: actual,
                bootstrapped,
                linked,
                port,
                script_started,
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

        let (bootstrapped, linked, port, script_started) =
            apply_worktree_setup(notify, &toplevel, &dir, branch, copy_files);
        Ok(WorktreeInfo {
            path,
            branch: branch.to_string(),
            bootstrapped,
            linked,
            port,
            script_started,
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
///
/// `clean_files` lists worktree-relative recipe artifacts (the bootstrapped
/// config copies from `git_worktree_add`) to delete first — without this, a
/// non-ignored `.env` copy makes git refuse a non-force removal, so a checkout
/// whose run never started could never be discarded without `--force`.
/// `delete_branch` drops the named branch after the checkout is gone (its
/// `branch.<name>.*` config section goes with it) — for callers discarding a
/// branch they created for this worktree.
#[tauri::command]
pub(crate) async fn git_worktree_remove(
    workspace_root: String,
    path: String,
    force: Option<bool>,
    clean_files: Option<Vec<String>>,
    delete_branch: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        for rel in clean_files.unwrap_or_default() {
            let rel_path = std::path::Path::new(&rel);
            // Worktree-relative only: an absolute or `..`-escaping entry could
            // reach outside the checkout being discarded.
            if rel_path.is_absolute()
                || rel_path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err(format!("Invalid cleanup path: {rel}"));
            }
            let target = std::path::Path::new(&path).join(rel_path);
            match std::fs::symlink_metadata(&target) {
                Ok(meta) if meta.is_dir() => {
                    return Err(format!("Refusing to delete directory during cleanup: {rel}"));
                }
                Ok(_) => {
                    std::fs::remove_file(&target).map_err(|e| format!("delete {rel}: {e}"))?
                }
                Err(_) => {} // already gone
            }
        }
        let mut args = vec!["worktree", "remove"];
        if force.unwrap_or(false) {
            args.push("--force");
        }
        args.push(&path);
        run_git(&workspace_root, &args)?;
        if let Some(branch) = delete_branch
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
        {
            // -D, not -d: the branch may be unmerged (it usually just mirrors
            // its base when the run never started, but -d would refuse any
            // stray commit). The checkout is already gone either way.
            run_git(&workspace_root, &["branch", "-D", &branch])?;
        }
        Ok(())
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
                linked: Vec::new(),
                port: None,
                script_started: false,
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

    // (The copy/link/port/script setup helpers live — with their tests — in
    // crate::worktree_setup; this file only orchestrates them.)

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
    /// Tests don't have a Tauri app to emit `worktree-setup:done` — drop it.
    fn noop_notify() -> SetupNotify {
        std::sync::Arc::new(|_| {})
    }

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

    #[test]
    fn synthesized_new_file_diff_carries_a_hunk_header() {
        let diff = synthesize_new_file_diff("HAIKU.md", "old pane\nnew branch grows\n");
        assert!(diff.contains("new file mode 100644"));
        assert!(
            diff.contains("@@ -0,0 +1,2 @@"),
            "hunk header drives frontend line numbers: {diff}"
        );
        assert!(diff.contains("+old pane\n+new branch grows\n"));
        // An empty new file has nothing to number — no hunk header, no rows.
        let empty = synthesize_new_file_diff("empty.txt", "");
        assert!(!empty.contains("@@"));
    }

    /// The case Pierre hit reviewing a freshly created file: plain `git diff`
    /// shows nothing for an untracked file, so git_diff must synthesize a
    /// parseable new-file diff (with line numbers) instead of returning empty.
    #[tokio::test]
    async fn git_diff_synthesizes_a_diff_for_untracked_files() {
        let (base, repo) = temp_repo("untracked-diff");
        std::fs::write(
            std::path::Path::new(&repo).join("HAIKU.md"),
            "# Worktrees\n\nbranches drift apart\n",
        )
        .unwrap();

        let diff = git_diff(repo.clone(), "HAIKU.md".to_string(), false)
            .await
            .expect("untracked diff");
        assert_eq!(diff.additions, 3);
        assert!(diff.diff.contains("@@ -0,0 +1,3 @@"), "got: {}", diff.diff);
        assert!(diff.diff.contains("+# Worktrees"));

        // Staged view of the same untracked file stays empty (nothing staged),
        // and a TRACKED clean file yields an empty working diff.
        let staged = git_diff(repo.clone(), "HAIKU.md".to_string(), true)
            .await
            .expect("staged diff");
        assert!(staged.diff.trim().is_empty());
        let clean = git_diff(repo.clone(), "a.txt".to_string(), false)
            .await
            .expect("clean diff");
        assert!(clean.diff.trim().is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn worktree_add_applies_the_fleet_recipe() {
        let (base, repo) = temp_repo("wt-recipe");

        let wt = worktree_add_core(repo.clone(),"klide/test-run".into(), Some(vec![]), noop_notify())
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
        let again = worktree_add_core(repo.clone(),"klide/test-run".into(), Some(vec![]), noop_notify())
            .await
            .unwrap();
        assert_eq!(again.path, wt.path);

        // A worktree dir deleted by hand leaves a stale registration that
        // claims the branch; the prune-before-add must revive it cleanly.
        std::fs::remove_dir_all(&wt.path).unwrap();
        let revived = worktree_add_core(repo.clone(),"klide/test-run".into(), Some(vec![]), noop_notify())
            .await
            .unwrap();
        assert_eq!(revived.path, wt.path);
        assert!(std::path::Path::new(&revived.path).join(".git").exists());

        // `<repo>-worktrees` is a sibling of the repo inside `base`, so this
        // sweeps the worktree checkouts too.
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The race failure path: a fresh worktree holding only recipe artifacts
    /// (a non-ignored `.env` copy) must be removable without --force once the
    /// artifacts are cleaned, and the branch created for it must go too —
    /// while real (non-listed) content still blocks a non-force removal.
    #[tokio::test]
    async fn worktree_remove_cleans_recipe_artifacts_and_the_created_branch() {
        let (base, repo) = temp_repo("wt-discard");
        let wt = worktree_add_core(repo.clone(), "klide/race-x-1".into(), Some(vec![]), noop_notify())
            .await
            .unwrap();
        // Untracked, not ignored — exactly the copy that makes bare
        // `git worktree remove` refuse.
        std::fs::write(std::path::Path::new(&wt.path).join(".env"), "K=1").unwrap();

        // An escaping cleanup path is rejected before anything is touched.
        let escape = git_worktree_remove(
            repo.clone(),
            wt.path.clone(),
            Some(false),
            Some(vec!["../outside".into()]),
            None,
        )
        .await;
        assert!(escape.unwrap_err().contains("Invalid cleanup path"));

        git_worktree_remove(
            repo.clone(),
            wt.path.clone(),
            Some(false),
            Some(vec![".env".into()]),
            Some("klide/race-x-1".into()),
        )
        .await
        .expect("clean removal");
        assert!(!std::path::Path::new(&wt.path).exists());
        assert!(
            run_git(&repo, &["show-ref", "--verify", "--quiet", "refs/heads/klide/race-x-1"])
                .is_err(),
            "created branch is deleted with the discarded worktree"
        );
        assert!(
            git_output(&repo, &["config", "--get", "branch.klide/race-x-1.base"]).is_err(),
            "branch config section goes with the branch"
        );

        // Content NOT in clean_files still blocks a non-force removal.
        let wt2 = worktree_add_core(repo.clone(), "klide/race-x-2".into(), Some(vec![]), noop_notify())
            .await
            .unwrap();
        std::fs::write(std::path::Path::new(&wt2.path).join("work.txt"), "w").unwrap();
        let refused = git_worktree_remove(repo.clone(), wt2.path.clone(), Some(false), None, None).await;
        assert!(refused.is_err(), "dirty checkout survives non-force cleanup");
        assert!(std::path::Path::new(&wt2.path).join("work.txt").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn branch_diff_defaults_to_the_recorded_fork_base() {
        let (base, repo) = temp_repo("wt-diff-base");
        let wt = worktree_add_core(repo.clone(),"klide/diffed".into(), Some(vec![]), noop_notify())
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
        worktree_add_core(repo.clone(),"klide/guarded".into(), Some(vec![]), noop_notify())
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
