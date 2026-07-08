// GitHub — everything Klide knows about GitHub lives here: the gh CLI seam
// (login-shell binary resolution + output capture), the PR commands, avatar
// resolution, and the pure parsers that turn gh's JSON into the structs the
// frontend renders. The parsers take &str and return structs, so they are
// fixture-tested without a gh binary, a network, or a live repo — the
// commands are thin: gh_output → parse.

use std::process::Command;

use super::{blocking, git_output, run_git};

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

/// ISO-8601 value → unix millis, 0 when absent/unparsable.
fn ms_from_rfc3339(v: Option<&serde_json::Value>) -> i64 {
    v.and_then(|x| x.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

fn str_field(obj: &serde_json::Map<String, serde_json::Value>, key: &str, default: &str) -> String {
    obj.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or(default)
        .to_string()
}

fn badge_for(state: &str, is_draft: bool) -> String {
    if is_draft {
        "draft".to_string()
    } else {
        state.to_lowercase()
    }
}

/// Parse `gh pr list --json …` output. Pure — fixture-tested below.
fn parse_pr_list(json: &str, current_branch: &str) -> Result<Vec<PullRequest>, String> {
    let raw: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Could not parse `gh pr list` output: {e}"))?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    let mut prs: Vec<PullRequest> = Vec::with_capacity(arr.len());
    for v in arr {
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let state = str_field(obj, "state", "OPEN");
        let is_draft = obj
            .get("isDraft")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let head_ref = str_field(obj, "headRefName", "");
        let comment_arr = obj.get("comments").and_then(|x| x.as_array());
        let comments = comment_arr.map(|a| a.len()).unwrap_or(0) as i32;
        // Distinct commenter logins in first-seen order — feeds the avatar stack.
        let mut comment_authors: Vec<String> = Vec::new();
        if let Some(arr) = comment_arr {
            for c in arr {
                if let Some(login) = c
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|a| a.as_str())
                {
                    let login = login.to_string();
                    if !login.is_empty() && !comment_authors.contains(&login) {
                        comment_authors.push(login);
                    }
                }
            }
        }
        prs.push(PullRequest {
            number: obj.get("number").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            title: str_field(obj, "title", ""),
            badge: badge_for(&state, is_draft),
            state,
            is_draft,
            author: obj
                .get("author")
                .and_then(|x| x.get("login"))
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
                .to_string(),
            is_current_branch: !current_branch.is_empty() && head_ref == current_branch,
            head_ref,
            base_ref: str_field(obj, "baseRefName", ""),
            url: str_field(obj, "url", ""),
            additions: obj.get("additions").and_then(|x| x.as_i64()).unwrap_or(0),
            deletions: obj.get("deletions").and_then(|x| x.as_i64()).unwrap_or(0),
            changed_files: obj
                .get("changedFiles")
                .and_then(|x| x.as_i64())
                .unwrap_or(0) as i32,
            comments,
            comment_authors,
            updated_at_ms: ms_from_rfc3339(obj.get("updatedAt")),
        });
    }
    // Mixed states come back grouped by state; sort newest-first so the panel
    // reads chronologically regardless of the open/merged/closed mix.
    prs.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(prs)
}

/// Parse `gh pr view --json …` output. Pure — fixture-tested below.
fn parse_pr_view(json: &str, number: u32) -> Result<PullRequestDetails, String> {
    let obj: serde_json::Value = serde_json::from_str(json)
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
                        created_at_ms: ms_from_rfc3339(c.get("committedDate")),
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
                    created_at_ms: ms_from_rfc3339(c.get("createdAt")),
                })
                .collect()
        })
        .unwrap_or_default();
    let state = str_field(obj, "state", "OPEN");
    let is_draft = obj
        .get("isDraft")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    Ok(PullRequestDetails {
        number: obj.get("number").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        title: str_field(obj, "title", ""),
        body: str_field(obj, "body", ""),
        badge: badge_for(&state, is_draft),
        state,
        is_draft,
        author: obj
            .get("author")
            .and_then(|x| x.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
        head_ref: str_field(obj, "headRefName", ""),
        base_ref: str_field(obj, "baseRefName", ""),
        url: str_field(obj, "url", ""),
        additions: obj.get("additions").and_then(|x| x.as_i64()).unwrap_or(0),
        deletions: obj.get("deletions").and_then(|x| x.as_i64()).unwrap_or(0),
        changed_files: obj
            .get("changedFiles")
            .and_then(|x| x.as_i64())
            .unwrap_or(0) as i32,
        comments: comment_thread.len() as i32,
        comment_thread,
        commits,
        mergeable: str_field(obj, "mergeable", "UNKNOWN"),
        created_at_ms: ms_from_rfc3339(obj.get("createdAt")),
        updated_at_ms: ms_from_rfc3339(obj.get("updatedAt")),
    })
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
        let current_branch = git_output(&workspace_root, &["branch", "--show-current"])
            .unwrap_or_default()
            .trim()
            .to_string();
        parse_pr_list(&json, &current_branch)
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
        parse_pr_view(&json, number)
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

#[cfg(test)]
mod tests {
    use super::*;

    const PR_LIST_JSON: &str = r#"[
      {
        "number": 7,
        "title": "Older draft",
        "state": "OPEN",
        "isDraft": true,
        "author": { "login": "pierre" },
        "headRefName": "feat/older",
        "baseRefName": "main",
        "url": "https://github.com/o/r/pull/7",
        "additions": 10,
        "deletions": 2,
        "changedFiles": 3,
        "comments": [
          { "author": { "login": "alice" }, "body": "first" },
          { "author": { "login": "bob" }, "body": "second" },
          { "author": { "login": "alice" }, "body": "third" }
        ],
        "updatedAt": "2026-07-01T10:00:00Z"
      },
      {
        "number": 9,
        "title": "Newer merged",
        "state": "MERGED",
        "isDraft": false,
        "author": { "login": "carol" },
        "headRefName": "feat/newer",
        "baseRefName": "main",
        "url": "https://github.com/o/r/pull/9",
        "additions": 1,
        "deletions": 1,
        "changedFiles": 1,
        "comments": [],
        "updatedAt": "2026-07-05T10:00:00Z"
      }
    ]"#;

    #[test]
    fn pr_list_parses_sorts_and_derives_badges() {
        let prs = parse_pr_list(PR_LIST_JSON, "feat/older").expect("parses");
        assert_eq!(prs.len(), 2);
        // Newest-first regardless of gh's state grouping.
        assert_eq!(prs[0].number, 9);
        assert_eq!(prs[0].badge, "merged");
        assert!(!prs[0].is_current_branch);
        // Draft badge wins over open state; current branch matched by head ref.
        assert_eq!(prs[1].badge, "draft");
        assert!(prs[1].is_current_branch);
        // Distinct commenters in first-seen order.
        assert_eq!(prs[1].comments, 3);
        assert_eq!(prs[1].comment_authors, vec!["alice", "bob"]);
        assert!(prs[0].updated_at_ms > prs[1].updated_at_ms);
    }

    #[test]
    fn pr_list_tolerates_missing_fields_and_junk_entries() {
        let prs = parse_pr_list(r#"[{"number": 3}, 42]"#, "").expect("parses");
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 3);
        assert_eq!(prs[0].author, "unknown");
        assert_eq!(prs[0].badge, "open");
        assert_eq!(prs[0].updated_at_ms, 0);
        assert!(!prs[0].is_current_branch);
    }

    const PR_VIEW_JSON: &str = r#"{
      "number": 12,
      "title": "Premium PR panel",
      "body": "Timeline + hero.",
      "state": "OPEN",
      "isDraft": false,
      "author": { "login": "pierre" },
      "headRefName": "feat/pr-panel",
      "baseRefName": "main",
      "url": "https://github.com/o/r/pull/12",
      "additions": 120,
      "deletions": 30,
      "changedFiles": 4,
      "comments": [
        { "author": { "login": "alice" }, "body": "Nice.", "createdAt": "2026-07-02T09:00:00Z" }
      ],
      "commits": [
        {
          "oid": "0123456789abcdef",
          "messageHeadline": "feat(git): timeline",
          "authors": [ { "login": "pierre" } ],
          "committedDate": "2026-07-01T08:00:00Z"
        }
      ],
      "mergeable": "MERGEABLE",
      "createdAt": "2026-06-30T12:00:00Z",
      "updatedAt": "2026-07-02T09:00:00Z"
    }"#;

    #[test]
    fn pr_view_parses_timeline_pieces() {
        let d = parse_pr_view(PR_VIEW_JSON, 12).expect("parses");
        assert_eq!(d.number, 12);
        assert_eq!(d.badge, "open");
        assert_eq!(d.mergeable, "MERGEABLE");
        // comments mirrors the actual thread length.
        assert_eq!(d.comments, 1);
        assert_eq!(d.comment_thread[0].author, "alice");
        assert_eq!(d.commits.len(), 1);
        assert_eq!(d.commits[0].short_hash, "0123456");
        assert_eq!(d.commits[0].author, "pierre");
        assert!(d.commits[0].created_at_ms > 0);
        assert!(d.created_at_ms < d.updated_at_ms);
    }

    #[test]
    fn pr_view_rejects_non_object_payload() {
        let err = match parse_pr_view("null", 5) {
            Ok(_) => panic!("expected an error for a null payload"),
            Err(e) => e,
        };
        assert!(err.contains("PR #5 not found"), "{err}");
    }
}
