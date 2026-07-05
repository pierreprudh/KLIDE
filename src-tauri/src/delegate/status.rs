//! Hook-based delegate status — the pattern both Orca and Superset converged
//! on (docs/competitors-orca-superset.md): never scrape a TUI's output to
//! guess what an agent is doing. Instead, install lifecycle hooks into the
//! CLI's *own* config that POST a tiny request to a loopback HTTP server
//! Klide owns. The hook command is env-guarded — it only fires when the PTY
//! carries `KLIDE_HOOK_URL`, i.e. when Klide launched the CLI — so the same
//! CLI run from a plain terminal is completely unaffected.
//!
//! The flow, end to end:
//! 1. `delegate_pty_spawn` (pty.rs) calls the adapter's `ensure_status_hooks`
//!    (per-CLI knowledge, behind the Delegate seam) and injects
//!    `KLIDE_HOOK_URL=http://127.0.0.1:<port>/hook/<token>/<session_id>`
//!    into the PTY environment.
//! 2. The CLI fires its lifecycle hooks; each one curls
//!    `$KLIDE_HOOK_URL/<state>` where `<state>` is already normalized —
//!    the event → state mapping lives in the installer, so the server needs
//!    no per-CLI vocabulary.
//! 3. The server records `session_id → state` and emits
//!    `delegate-status:changed`; `delegate_pty_live_sessions` joins the map
//!    so Mission Control's Live strip shows real states instead of an
//!    idle-timer guess.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

/// Normalized delegate status. Three states, deliberately few:
/// - `Working` — running a turn or a tool.
/// - `Blocked` — stopped on something only the user can answer (permission
///   prompt, "waiting for your input" notification).
/// - `Waiting` — the turn finished; the agent is idle at its composer.
/// "Done" isn't here: a finished CLI exits, and the PTY exit event already
/// removes the session everywhere.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentStatus {
    Working,
    Blocked,
    Waiting,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Working => "working",
            AgentStatus::Blocked => "blocked",
            AgentStatus::Waiting => "waiting",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "working" => Some(AgentStatus::Working),
            "blocked" => Some(AgentStatus::Blocked),
            "waiting" => Some(AgentStatus::Waiting),
            _ => None,
        }
    }
}

/// `session_id → (status, epoch ms of the last hook)`. Shared between the
/// server thread (writer) and `delegate_pty_live_sessions` (reader).
pub type StatusMap = Arc<Mutex<HashMap<String, (AgentStatus, i64)>>>;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Loopback hook server ────────────────────────────────────────────────

pub struct HookServer {
    pub port: u16,
    pub token: String,
}

/// The whole app holds one status map and (lazily) one hook server. Managed
/// by Tauri; `hook_url_for` is the only way in, so the server can't start
/// twice.
#[derive(Default)]
pub struct DelegateStatusState {
    pub statuses: StatusMap,
    server: Mutex<Option<HookServer>>,
}

impl DelegateStatusState {
    /// This session's private callback URL, starting the loopback listener on
    /// first use. `None` when the listener can't start — hooks then no-op
    /// (env var absent) and the timer heuristic carries the status instead.
    pub fn hook_url_for(&self, app: &tauri::AppHandle, session_id: &str) -> Option<String> {
        let mut server = self.server.lock().unwrap();
        if server.is_none() {
            let app = app.clone();
            let on_change = move |session_id: String, status: String| {
                let _ = app.emit(
                    "delegate-status:changed",
                    serde_json::json!({ "sessionId": session_id, "status": status }),
                );
            };
            match start_hook_server(self.statuses.clone(), Box::new(on_change)) {
                Ok(s) => *server = Some(s),
                Err(e) => {
                    eprintln!("delegate status hook server failed to start: {e}");
                    return None;
                }
            }
        }
        let s = server.as_ref().unwrap();
        Some(format!(
            "http://127.0.0.1:{}/hook/{}/{}",
            s.port, s.token, session_id
        ))
    }
}

/// An unguessable path segment, so nothing else on the machine can spoof
/// status posts to the loopback port. Loopback-only + token is the same
/// posture Orca ships; the worst a spoofed post could do is flip a label.
fn fresh_token() -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "{:?}-{}-{:?}",
        std::time::SystemTime::now(),
        std::process::id(),
        std::thread::current().id()
    ));
    let mut token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());
    token.truncate(22);
    token
}

type OnChange = Box<dyn Fn(String, String) + Send>;

/// Bind 127.0.0.1 on an ephemeral port and serve hook posts on one thread.
/// The thread lives for the app's lifetime — delegate sessions come and go,
/// the listener stays.
pub fn start_hook_server(statuses: StatusMap, on_change: OnChange) -> Result<HookServer, String> {
    let server =
        tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("bind hook server: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "hook server has no IP port".to_string())?;
    let token = fresh_token();
    let thread_token = token.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let method = request.method().to_string();
            let code = handle_hook_request(
                &method,
                request.url(),
                &thread_token,
                &statuses,
                on_change.as_ref(),
            );
            let _ = request.respond(tiny_http::Response::empty(code));
        }
    });
    Ok(HookServer { port, token })
}

/// Apply one hook post: `POST /hook/<token>/<session_id>/<state>` where
/// `<state>` is a normalized status or `end` (session over → forget it).
/// Returns the HTTP status code; pure apart from the map + callback, so
/// tests drive it directly without a socket.
fn handle_hook_request(
    method: &str,
    url: &str,
    token: &str,
    statuses: &StatusMap,
    on_change: &(dyn Fn(String, String) + Send),
) -> u16 {
    if method != "POST" {
        return 405;
    }
    // Strip any query string, then split the path. The session id sits
    // between the token and the state and may itself contain separators
    // (it's `{convoId}:{provider}`), so join the middle back together.
    let path = url.split('?').next().unwrap_or(url);
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    if segments.len() < 4 || segments[0] != "hook" {
        return 404;
    }
    if segments[1] != token {
        return 403;
    }
    let state = *segments.last().unwrap();
    let session_id = segments[2..segments.len() - 1].join("/");
    if session_id.is_empty() {
        return 400;
    }
    if state == "end" {
        statuses.lock().unwrap().remove(&session_id);
        on_change(session_id, "end".to_string());
        return 204;
    }
    match AgentStatus::parse(state) {
        Some(status) => {
            statuses
                .lock()
                .unwrap()
                .insert(session_id.clone(), (status, now_ms()));
            on_change(session_id, status.as_str().to_string());
            204
        }
        None => 400,
    }
}

// ── Claude Code hook installer ──────────────────────────────────────────
//
// Claude Code runs `settings.json` hooks as shell commands with the hook
// event's JSON on stdin. Klide's entries are env-guarded (no KLIDE_HOOK_URL
// → drain stdin and exit 0) and self-identifying: the KLIDE_HOOK_URL string
// itself is the marker the sweep uses, so user-authored hooks are never
// touched and stale Klide entries are replaced wholesale on the next
// install.

/// Claude Code lifecycle events → normalized state posted for each.
/// `true` marks tool events, which take a matcher ("*" = every tool).
const CLAUDE_HOOK_EVENTS: [(&str, bool, &str); 7] = [
    ("SessionStart", false, "working"),
    ("UserPromptSubmit", false, "working"),
    ("PreToolUse", true, "working"),
    ("PostToolUse", true, "working"),
    ("Notification", false, "blocked"),
    ("Stop", false, "waiting"),
    ("SessionEnd", false, "end"),
];

fn claude_hook_command(state: &str) -> String {
    format!(
        "if [ -n \"$KLIDE_HOOK_URL\" ]; then curl -sS --max-time 2 -X POST \"$KLIDE_HOOK_URL/{state}\" --data-binary @- >/dev/null 2>&1; else cat >/dev/null 2>&1; fi; true"
    )
}

/// Merge Klide's status hooks into a Claude `settings.json` value: sweep
/// every previously-installed Klide command (marker: `KLIDE_HOOK_URL`), then
/// add the current set. Everything user-authored passes through untouched.
/// Returns the merged value and whether it differs from the input.
fn merge_klide_hooks(settings: &serde_json::Value) -> (serde_json::Value, bool) {
    let mut out = if settings.is_object() {
        settings.clone()
    } else {
        serde_json::json!({})
    };
    let root = out.as_object_mut().unwrap();
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    // Sweep: drop Klide commands from every event group, then drop groups
    // that became empty. A group that never had a Klide command is unchanged.
    for (_event, groups) in hooks.iter_mut() {
        if let Some(groups) = groups.as_array_mut() {
            for group in groups.iter_mut() {
                if let Some(inner) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                    inner.retain(|h| {
                        !h.get("command")
                            .and_then(|c| c.as_str())
                            .is_some_and(|c| c.contains("KLIDE_HOOK_URL"))
                    });
                }
            }
            groups.retain(|g| {
                g.get("hooks")
                    .and_then(|h| h.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(true)
            });
        }
    }

    // Add: one group per event, matcher only where the event takes one.
    for (event, is_tool_event, state) in CLAUDE_HOOK_EVENTS {
        let mut group = serde_json::Map::new();
        if is_tool_event {
            group.insert("matcher".to_string(), serde_json::json!("*"));
        }
        group.insert(
            "hooks".to_string(),
            serde_json::json!([{ "type": "command", "command": claude_hook_command(state) }]),
        );
        let list = hooks
            .entry(event)
            .or_insert_with(|| serde_json::json!([]));
        if !list.is_array() {
            *list = serde_json::json!([]);
        }
        list.as_array_mut()
            .unwrap()
            .push(serde_json::Value::Object(group));
    }

    let changed = !settings.is_object() || *settings != out;
    (out, changed)
}

/// Install (or refresh) Klide's status hooks in `~/.claude/settings.json`.
/// Returns whether the file was written. A settings file that exists but
/// doesn't parse is left strictly alone — never risk clobbering a
/// hand-edited config for a status label.
pub fn install_claude_hooks(home: &str) -> Result<bool, String> {
    let dir = std::path::Path::new(home).join(".claude");
    let path = dir.join("settings.json");
    let current = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|e| format!("~/.claude/settings.json didn't parse ({e}) — left untouched"))?,
        Err(_) => serde_json::json!({}),
    };
    let (merged, changed) = merge_klide_hooks(&current);
    if !changed {
        return Ok(false);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create ~/.claude: {e}"))?;
    // One rolling backup the first time Klide ever touches the file, so a
    // hand-edited settings.json is always recoverable.
    let backup = dir.join("settings.json.klide-bak");
    if path.exists() && !backup.exists() {
        let _ = std::fs::copy(&path, &backup);
    }
    let pretty =
        serde_json::to_string_pretty(&merged).map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, pretty).map_err(|e| format!("write settings.json: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collecting() -> (Arc<Mutex<Vec<(String, String)>>>, OnChange) {
        let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (
            seen,
            Box::new(move |id, status| sink.lock().unwrap().push((id, status))),
        )
    }

    #[test]
    fn handle_updates_clears_and_rejects() {
        let statuses: StatusMap = Default::default();
        let (seen, on_change) = collecting();
        let tok = "tok123";
        let post = |url: &str| handle_hook_request("POST", url, tok, &statuses, on_change.as_ref());

        // Working, then blocked, for a session id that contains a colon.
        assert_eq!(post("/hook/tok123/conv-1:claude-code/working"), 204);
        assert_eq!(
            statuses.lock().unwrap().get("conv-1:claude-code").unwrap().0,
            AgentStatus::Working
        );
        assert_eq!(post("/hook/tok123/conv-1:claude-code/blocked"), 204);
        assert_eq!(
            statuses.lock().unwrap().get("conv-1:claude-code").unwrap().0,
            AgentStatus::Blocked
        );
        // `end` forgets the session.
        assert_eq!(post("/hook/tok123/conv-1:claude-code/end"), 204);
        assert!(statuses.lock().unwrap().is_empty());
        // Rejections: bad token, junk state, wrong shape, wrong method.
        assert_eq!(post("/hook/WRONG/conv-1:claude-code/working"), 403);
        assert_eq!(post("/hook/tok123/conv-1:claude-code/exploded"), 400);
        assert_eq!(post("/nothook/tok123/x/working"), 404);
        assert_eq!(
            handle_hook_request("GET", "/hook/tok123/s/working", tok, &statuses, on_change.as_ref()),
            405
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "only accepted posts signal a change");
        assert_eq!(seen[2].1, "end");
    }

    #[test]
    fn server_round_trip_over_a_real_socket() {
        use std::io::{Read, Write};
        let statuses: StatusMap = Default::default();
        let (_seen, on_change) = collecting();
        let server = start_hook_server(statuses.clone(), on_change).unwrap();

        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", server.port)).expect("connect hook server");
        write!(
            stream,
            "POST /hook/{}/sess:claude-code/waiting HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            server.token
        )
        .unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        assert!(response.starts_with("HTTP/1.1 204"), "got: {response}");
        assert_eq!(
            statuses.lock().unwrap().get("sess:claude-code").unwrap().0,
            AgentStatus::Waiting
        );
    }

    #[test]
    fn merge_installs_all_events_and_is_idempotent() {
        let (merged, changed) = merge_klide_hooks(&serde_json::json!({}));
        assert!(changed);
        let hooks = merged.get("hooks").and_then(|h| h.as_object()).unwrap();
        assert_eq!(hooks.len(), CLAUDE_HOOK_EVENTS.len());
        // Tool events carry the match-everything matcher; others don't.
        let pre = &hooks["PreToolUse"][0];
        assert_eq!(pre["matcher"], "*");
        assert!(hooks["Stop"][0].get("matcher").is_none());
        let stop_cmd = hooks["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(stop_cmd.contains("KLIDE_HOOK_URL") && stop_cmd.contains("/waiting"));

        // Running the merge again over its own output changes nothing.
        let (again, changed_again) = merge_klide_hooks(&merged);
        assert!(!changed_again);
        assert_eq!(again, merged);
    }

    #[test]
    fn merge_preserves_user_hooks_and_replaces_stale_klide_ones() {
        let settings = serde_json::json!({
            "model": "opus",
            "hooks": {
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "say done" }] },
                    // A stale Klide entry from an older template — must be
                    // swept, not duplicated.
                    { "hooks": [{ "type": "command", "command": "curl $KLIDE_HOOK_URL/old-shape" }] }
                ]
            }
        });
        let (merged, changed) = merge_klide_hooks(&settings);
        assert!(changed);
        assert_eq!(merged["model"], "opus", "non-hook settings pass through");
        let stop = merged["hooks"]["Stop"].as_array().unwrap();
        let commands: Vec<&str> = stop
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap())
            .map(|h| h["command"].as_str().unwrap())
            .collect();
        assert!(commands.contains(&"say done"), "user hook survives");
        let klide: Vec<&&str> = commands
            .iter()
            .filter(|c| c.contains("KLIDE_HOOK_URL"))
            .collect();
        assert_eq!(klide.len(), 1, "exactly one Klide command after refresh");
        assert!(klide[0].contains("/waiting"), "and it's the current template");
    }

    #[test]
    fn install_writes_backs_up_and_never_clobbers_junk() {
        let home = std::env::temp_dir().join(format!("klide-hooks-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let home_s = home.to_str().unwrap();
        let settings = home.join(".claude/settings.json");
        let backup = home.join(".claude/settings.json.klide-bak");

        // Existing user settings: install merges, keeps user keys, backs up.
        std::fs::write(&settings, r#"{"model":"opus"}"#).unwrap();
        assert_eq!(install_claude_hooks(home_s), Ok(true));
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            r#"{"model":"opus"}"#,
            "first touch snapshots the original"
        );
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(written["model"], "opus");
        assert!(written["hooks"]["Stop"].is_array());

        // Second install is a no-op — nothing to write.
        assert_eq!(install_claude_hooks(home_s), Ok(false));

        // A file that doesn't parse is refused, not overwritten.
        std::fs::write(&settings, "{ not json").unwrap();
        assert!(install_claude_hooks(home_s).is_err());
        assert_eq!(
            std::fs::read_to_string(&settings).unwrap(),
            "{ not json",
            "unparseable settings are left strictly alone"
        );

        let _ = std::fs::remove_dir_all(&home);
    }
}
