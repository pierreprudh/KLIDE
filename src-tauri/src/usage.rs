//! How much of each subscription CLI's allowance is spent — the numbers the
//! account menu shows under each login.
//!
//! Ported from Token Usage Island (`usage_tool/Sources/Core/Fetchers.swift`),
//! which has already paid for the edge cases recorded below. Three sources,
//! none of them a Klide invention:
//!
//! - **Claude Code** — the same endpoint `/usage` reads,
//!   `GET https://api.anthropic.com/api/oauth/usage`, with the OAuth token
//!   Claude Code keeps in the macOS Keychain (`Claude Code-credentials`), or in
//!   `~/.claude/.credentials.json` where there is no Keychain. The only network
//!   call here, and it goes to Anthropic with the user's own credentials.
//! - **Codex** — the `rate_limits` object Codex writes into its session logs
//!   (`~/.codex/sessions/**/*.jsonl`) on every API turn, as of the last run.
//! - **OpenCode** — pay-as-you-go, so no cap to be a percentage of: this
//!   week's spend and tokens, summed from its SQLite database.
//!
//! Every reader fails soft into a one-line `error`, so one missing CLI never
//! blanks the others.

use serde::Serialize;
use crate::delegate::{Codex, ClaudeCode, OpenCode, Delegate, Env, ProcessEnv};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// One CLI's reading.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    pub provider: &'static str,
    /// "Max", "Plus" — the plan the reading belongs to, when the source says.
    pub plan: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub spend: Option<Spend>,
    /// Why there is no reading ("Sign in with Claude Code.").
    pub error: Option<String>,
}

/// One rate-limit window: how much of it is used and when it resets.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// "Session" (5 h), "Weekly", "Reserve".
    pub label: String,
    /// 0–100.
    pub percent: f64,
    pub resets_at_ms: Option<i64>,
    /// When the reading was taken, when it is not live (Codex: its last run).
    pub seen_at_ms: Option<i64>,
}

/// Pay-as-you-go spend since `since_ms`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    pub cost_usd: f64,
    pub tokens: f64,
    pub since_ms: i64,
}

pub async fn snapshot() -> Vec<ToolUsage> {
    let (claude, rest) = tokio::join!(
        claude(),
        crate::blocking::run_infallible(|| {
            local_usage(&ProcessEnv, chrono::Utc::now().timestamp_millis())
        })
    );
    let mut out = vec![claude];
    out.extend(rest);
    out
}

fn local_usage(env: &dyn Env, now: i64) -> Vec<ToolUsage> {
    let missing = |provider| ToolUsage {
        provider,
        error: Some("No CLI data directory available.".into()),
        ..Default::default()
    };
    vec![
        Codex.sessions_dir(env).map(|path| codex(&path, now)).unwrap_or_else(|| missing("codex")),
        OpenCode.data_home(env).map(|path| opencode(&path.join("opencode.db"), now)).unwrap_or_else(|| missing("opencode")),
    ]
}

// ── Claude Code ──────────────────────────────────────────────────────────

async fn claude() -> ToolUsage {
    let mut tool = ToolUsage { provider: "claude-code", ..Default::default() };
    let Some((token, plan)) = claude_credentials().await else {
        tool.error = Some("Sign in with Claude Code.".into());
        return tool;
    };
    tool.plan = plan.map(|p| capitalize(&p));
    let response = reqwest::Client::new()
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("anthropic-version", "2023-06-01")
        .timeout(Duration::from_secs(12))
        .send()
        .await;
    let response = match response {
        Ok(r) => r,
        Err(_) => {
            tool.error = Some("Offline.".into());
            return tool;
        }
    };
    match response.status().as_u16() {
        401 => tool.error = Some("Token expired — reopen Claude Code.".into()),
        429 => tool.error = Some("Rate limited — retry shortly.".into()),
        _ => match response.json::<serde_json::Value>().await {
            Ok(json) => {
                tool.windows = claude_windows(&json);
                if tool.windows.is_empty() {
                    tool.error = Some("No usage data.".into());
                }
            }
            Err(_) => tool.error = Some("Unreadable response.".into()),
        },
    }
    tool
}

fn claude_windows(json: &serde_json::Value) -> Vec<UsageWindow> {
    [("five_hour", "Session"), ("seven_day", "Weekly")]
        .iter()
        .filter_map(|(key, label)| {
            let window = json.get(key)?;
            Some(UsageWindow {
                label: label.to_string(),
                percent: window.get("utilization")?.as_f64()?,
                resets_at_ms: window.get("resets_at").and_then(|v| v.as_str()).and_then(parse_iso_ms),
                seen_at_ms: None,
            })
        })
        .collect()
}

/// The OAuth token and plan name. The Keychain read runs `security`, which
/// blocks for as long as macOS's permission dialog is up — hence the bound.
async fn claude_credentials() -> Option<(String, Option<String>)> {
    #[cfg(target_os = "macos")]
    {
        let keychain = tokio::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .kill_on_drop(true)
            .output();
        if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(20), keychain).await {
            if out.status.success() {
                if let Some(found) = decode_claude_blob(&out.stdout) {
                    return Some(found);
                }
            }
        }
    }
    let file = ClaudeCode.config_home(&ProcessEnv)?.join(".credentials.json");
    decode_claude_blob(&std::fs::read(file).ok()?)
}

fn decode_claude_blob(bytes: &[u8]) -> Option<(String, Option<String>)> {
    let json: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let oauth = json.get("claudeAiOauth")?;
    let token = oauth.get("accessToken")?.as_str()?.to_string();
    let plan = oauth.get("subscriptionType").and_then(|v| v.as_str()).map(str::to_string);
    Some((token, plan))
}

// ── Codex ────────────────────────────────────────────────────────────────

/// One `rate_limits` object as Codex logs it, with the turn it was written in.
///
/// Since Codex 0.155 a session can report two allowances: the plan (the 5 h
/// and weekly windows `/status` shows) and, on eligible accounts, "Luna
/// Reserve", a fallback with one weekly window. The tag alone does not tell
/// them apart — reserve lines have shipped as `limit_id: "codex"` with no
/// name — but the turn does: the `turn_context` that opens a turn names its
/// model, and every `rate_limits` line until the next one belongs to it.
#[derive(Debug, Clone)]
struct CodexReading {
    bucket: String,
    name: Option<String>,
    model: Option<String>,
    at_ms: Option<i64>,
    raw: serde_json::Value,
}

impl CodexReading {
    fn is_reserve(&self) -> bool {
        self.model.as_deref() == Some("gpt-reserve")
            || self.name.as_deref() == Some("gpt-reserve")
            || self.bucket == "base_model_inference"
    }
    fn is_plan(&self) -> bool {
        self.bucket == "codex" && !self.is_reserve()
    }
    /// A `codex`-tagged line whose turn we did not see could be either.
    fn is_ambiguous(&self) -> bool {
        self.model.is_none() && self.bucket == "codex" && self.name.is_none()
    }
}

fn parse_codex(text: &str) -> Vec<CodexReading> {
    let mut out = Vec::new();
    let mut model: Option<String> = None;
    for line in text.lines() {
        if line.contains("\"type\":\"turn_context\"") {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                model = value.pointer("/payload/model").and_then(|v| v.as_str()).map(str::to_string);
            }
            continue;
        }
        if !line.contains("rate_limits") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(rl) = find_key(&value, "rate_limits").filter(|v| v.is_object()) else { continue };
        out.push(CodexReading {
            bucket: rl.get("limit_id").and_then(|v| v.as_str()).unwrap_or("codex").to_string(),
            name: rl.get("limit_name").and_then(|v| v.as_str()).map(str::to_string),
            model: model.clone(),
            at_ms: value.get("timestamp").and_then(|v| v.as_str()).and_then(parse_iso_ms),
            raw: rl.clone(),
        });
    }
    out
}

/// A session's readings, read from the tail and grown until conclusive —
/// every line classifiable and, when `want_plan`, a plan line among them — or
/// the whole file read. An active session costs one 64 KB read.
fn codex_readings(path: &Path, want_plan: bool) -> Option<Vec<CodexReading>> {
    let size = std::fs::metadata(path).ok()?.len() as usize;
    if size == 0 {
        return None;
    }
    let ceiling = size.min(1 << 24);
    let mut window = size.min(1 << 16);
    loop {
        let readings = parse_codex(&tail_of_file(path, window)?);
        let settled = !readings.is_empty()
            && !readings.iter().any(CodexReading::is_ambiguous)
            && (!want_plan || readings.iter().any(CodexReading::is_plan));
        if settled || window >= ceiling {
            return Some(readings);
        }
        window = (window * 4).min(ceiling);
    }
}

fn codex(sessions: &Path, now_ms: i64) -> ToolUsage {
    let mut tool = ToolUsage { provider: "codex", ..Default::default() };
    let logs = newest_first(sessions, "jsonl");
    let Some(current) = logs.first().and_then(|p| codex_readings(p, true)) else {
        tool.error = Some("No Codex sessions yet.".into());
        return tool;
    };
    // The plan line is usually in the current session; one that has spent its
    // whole logged life on the reserve sends us back a bounded few sessions.
    let mut plan = current.iter().rev().find(|r| r.is_plan()).cloned();
    if plan.is_none() {
        plan = logs.iter().skip(1).take(30).find_map(|p| {
            codex_readings(p, true)?.into_iter().rev().find(CodexReading::is_plan)
        });
    }
    // The reserve only matters while the current session draws on it.
    let reserve = current.iter().rev().find(|r| r.is_reserve() && r.raw.get("primary").is_some()).cloned();
    tool.plan = plan
        .as_ref()
        .or(reserve.as_ref())
        .and_then(|r| r.raw.get("plan_type")?.as_str().map(capitalize));
    if let Some(plan) = &plan {
        for slot in ["primary", "secondary"] {
            if let Some(w) = codex_window(plan, slot, now_ms) {
                tool.windows.push(w);
            }
        }
    }
    if let Some(reserve) = &reserve {
        if let Some(mut w) = codex_window(reserve, "primary", now_ms) {
            w.label = "Reserve".into();
            tool.windows.push(w);
        }
    }
    if tool.windows.is_empty() {
        tool.error = Some("No rate-limit data yet.".into());
    }
    tool
}

/// One window of a reading, honest about its age: a window whose reset has
/// passed since the reading was taken reads 0% — its last value is history.
fn codex_window(reading: &CodexReading, slot: &str, now_ms: i64) -> Option<UsageWindow> {
    let w = reading.raw.get(slot)?;
    let used = w.get("used_percent")?.as_f64()?;
    let minutes = w.get("window_minutes").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let label = if minutes >= 10080.0 { "Weekly" } else if minutes >= 300.0 { "Session" } else { "Limit" };
    let resets_at_ms = w.get("resets_at").and_then(|v| v.as_f64()).map(|s| (s * 1000.0) as i64);
    let passed = matches!((resets_at_ms, reading.at_ms), (Some(r), Some(seen)) if r <= now_ms && seen < r);
    Some(UsageWindow {
        label: label.into(),
        percent: if passed { 0.0 } else { used },
        resets_at_ms: if passed { None } else { resets_at_ms },
        seen_at_ms: reading.at_ms,
    })
}

// ── OpenCode ─────────────────────────────────────────────────────────────

fn opencode(db: &Path, now_ms: i64) -> ToolUsage {
    let mut tool = ToolUsage { provider: "opencode", ..Default::default() };
    if !db.exists() {
        tool.error = Some("No OpenCode history yet.".into());
        return tool;
    }
    let since_ms = now_ms - 7 * 86_400_000;
    let read = || -> rusqlite::Result<(Option<f64>, Option<f64>)> {
        let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.busy_timeout(Duration::from_secs(2))?;
        conn.query_row(
            "SELECT SUM(json_extract(data,'$.cost')),
                    SUM(COALESCE(json_extract(data,'$.tokens.input'),0)
                      + COALESCE(json_extract(data,'$.tokens.output'),0)
                      + COALESCE(json_extract(data,'$.tokens.cache.read'),0)
                      + COALESCE(json_extract(data,'$.tokens.cache.write'),0))
             FROM message WHERE time_created > ?1",
            [since_ms],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    };
    match read() {
        // Both NULL when nothing falls in the window — zero spend, not a failure.
        Ok((cost, tokens)) => {
            tool.spend = Some(Spend {
                cost_usd: cost.unwrap_or(0.0),
                tokens: tokens.unwrap_or(0.0),
                since_ms,
            })
        }
        Err(_) => tool.error = Some("Couldn't read OpenCode's history.".into()),
    }
    tool
}

// ── Shared ───────────────────────────────────────────────────────────────

/// The last `bytes` of a file, starting after the first newline so a window
/// that opens inside a multi-byte character (session logs are mostly prompt
/// text) still decodes: 0x0A never occurs inside a UTF-8 sequence.
fn tail_of_file(path: &Path, bytes: usize) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len() as usize;
    let take = size.min(bytes);
    let offset = size - take;
    file.seek(SeekFrom::Start(offset as u64)).ok()?;
    let mut data = Vec::with_capacity(take);
    file.take(take as u64).read_to_end(&mut data).ok()?;
    if offset > 0 {
        match data.iter().position(|b| *b == b'\n') {
            Some(nl) => {
                data.drain(..=nl);
            }
            // One line longer than the window: only the whole file parses.
            None => data = std::fs::read(path).ok()?,
        }
    }
    Some(String::from_utf8_lossy(&data).into_owned())
}

fn newest_first(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut found: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some(ext) {
                found.push((path, meta.modified().unwrap_or(std::time::UNIX_EPOCH)));
            }
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1));
    found.into_iter().map(|(p, _)| p).collect()
}

fn find_key<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match value {
        serde_json::Value::Object(map) => map.get(key).or_else(|| map.values().find_map(|v| find_key(v, key))),
        serde_json::Value::Array(items) => items.iter().find_map(|v| find_key(v, key)),
        _ => None,
    }
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAN: &str = r#"{"timestamp":"2026-09-30T10:00:00Z","type":"event_msg","payload":{"rate_limits":{"limit_id":"codex","primary":{"used_percent":44.0,"window_minutes":300,"resets_at":1790796767},"secondary":{"used_percent":57.0,"window_minutes":10080,"resets_at":1791143762},"plan_type":"plus"}}}"#;

    #[test]
    fn usage_reads_the_overridden_cli_data_directories() {
        use crate::delegate::home::MapEnv;
        let root = std::env::temp_dir().join(format!("klide-usage-overrides-{}", std::process::id()));
        let codex_home = root.join("moved-codex");
        let data_home = root.join("moved-data");
        std::fs::create_dir_all(codex_home.join("sessions")).unwrap();
        std::fs::create_dir_all(data_home.join("opencode")).unwrap();
        let turn = r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#;
        std::fs::write(codex_home.join("sessions/run.jsonl"), format!("{turn}\n{PLAN}\n")).unwrap();
        let db = rusqlite::Connection::open(data_home.join("opencode/opencode.db")).unwrap();
        db.execute_batch("CREATE TABLE message (data TEXT, time_created INTEGER);").unwrap();
        db.execute("INSERT INTO message VALUES (?1, ?2)", rusqlite::params![r#"{"cost":2.5,"tokens":{"input":100}}"#, 1790790000000_i64]).unwrap();
        drop(db);
        let env = MapEnv::with_home(&root).set("CODEX_HOME", &codex_home).set("XDG_DATA_HOME", &data_home);
        let readings = local_usage(&env, 1790790000000);
        assert_eq!(readings[0].windows[0].percent, 44.0);
        assert_eq!(readings[1].spend.as_ref().unwrap().cost_usd, 2.5);
        assert!(readings.iter().all(|r| r.error.is_none()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn usage_without_a_home_does_not_read_relative_paths() {
        let env = crate::delegate::home::MapEnv(Default::default());
        assert!(local_usage(&env, 0).iter().all(|r| r.error.as_deref() == Some("No CLI data directory available.")));
    }

    #[test]
    fn a_codex_log_reads_as_its_plan_windows() {
        let turn = r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#;
        let readings = parse_codex(&format!("{turn}\n{PLAN}\n"));
        assert_eq!(readings.len(), 1);
        assert!(readings[0].is_plan() && !readings[0].is_ambiguous());
        let session = codex_window(&readings[0], "primary", 1790790000000).unwrap();
        assert_eq!((session.label.as_str(), session.percent), ("Session", 44.0));
        let weekly = codex_window(&readings[0], "secondary", 1790790000000).unwrap();
        assert_eq!((weekly.label.as_str(), weekly.percent), ("Weekly", 57.0));
    }

    #[test]
    fn the_reserve_is_told_by_the_turn_model_not_the_tag() {
        let turn = r#"{"type":"turn_context","payload":{"model":"gpt-reserve"}}"#;
        let readings = parse_codex(&format!("{turn}\n{PLAN}\n"));
        assert!(readings[0].is_reserve() && !readings[0].is_plan());
    }

    #[test]
    fn a_window_that_reset_since_the_reading_reads_zero() {
        let readings = parse_codex(&format!("{}\n{PLAN}\n", r#"{"type":"turn_context","payload":{"model":"m"}}"#));
        // Long after both resets.
        let w = codex_window(&readings[0], "primary", 1_800_000_000_000).unwrap();
        assert_eq!((w.percent, w.resets_at_ms), (0.0, None));
    }

    #[test]
    fn the_claude_endpoint_reads_both_windows() {
        let json = serde_json::json!({
            "five_hour": { "utilization": 47.0, "resets_at": "2026-09-30T17:30:00.000Z" },
            "seven_day": { "utilization": 6.0, "resets_at": "2026-10-05T09:00:00Z" },
        });
        let w = claude_windows(&json);
        assert_eq!(w.iter().map(|w| (w.label.as_str(), w.percent)).collect::<Vec<_>>(), [("Session", 47.0), ("Weekly", 6.0)]);
        assert!(w[0].resets_at_ms.is_some());
    }

    #[test]
    fn a_tail_that_opens_mid_character_still_decodes() {
        let dir = std::env::temp_dir().join(format!("klide-usage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        std::fs::write(&path, format!("{}\n{PLAN}\n", "é".repeat(40_000))).unwrap();
        let text = tail_of_file(&path, PLAN.len() + 3).unwrap();
        assert_eq!(parse_codex(&text).len(), 1);
        std::fs::remove_dir_all(dir).ok();
    }

    /// The real readers against this machine. `cargo test --lib -- --ignored live_usage --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_usage() {
        for tool in snapshot().await {
            eprintln!("{tool:?}");
        }
    }
}
