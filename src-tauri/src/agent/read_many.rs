//! `read_many` — batch reads as a form, not a program.
//!
//! The middle rung between plain reads and `run_script` (script.rs). The
//! common shape of a context-heavy task is "read many files, keep a little
//! from each, combine". Code Mode lets a strong model write that as a
//! program; a small model writes broken programs. Here the model fills in
//! four fields instead — which files, what to pick, what to keep, how to
//! total — and Klide does the rest exactly: the walk, the parse, the filter
//! and the arithmetic. Only the answer enters the conversation.
//!
//! Less general than a script on purpose. Anything outside this shape falls
//! back to the ordinary Tools. Every file goes through the same Workspace
//! guard as `read_file`, so the capability (read workspace) holds.
//!
//! Prototype: offered only when `KLIDE_READ_MANY=1` is set in the app's
//! environment (the benchmark sets it per trial).

use super::glob_match::wildcard_match;
use super::types::ToolResult;
use crate::workspace::{Access, Workspace};
use serde_json::{json, Map, Value};

pub const READ_MANY_TOOL: &str = "read_many";

const MAX_FILES: usize = 500;
const MAX_LIST_ITEMS: usize = 400;
const MAX_RANGE_LINES: usize = 200;
const MAX_LINE_CHARS: usize = 300;

pub fn offered() -> bool {
    matches!(std::env::var("KLIDE_READ_MANY").as_deref(), Ok("1") | Ok("on") | Ok("true"))
}

pub fn description() -> &'static str {
    "Read many workspace files in one call and get back only what you ask for. Use it instead of many read_file calls \
when a task needs the same information from many files. Klide does the counting and summing exactly. \
`files`: a glob such as \"services/*.json\" or a list of paths. \
`pick`: what to take from each file — {\"json\": [field names]} (a JSON file holding an object or an array of objects; each object is one record), \
{\"lines_matching\": \"text\"} (lines containing the text), or {\"lines\": [start, end]}. \
`keep` (json only, optional): conditions every kept record must meet — {\"field\": value} for equality, \
{\"field\": {\">\": 30000}} with >, >=, <, <=, != , or {\"field\": null} for a missing field. \
`total` (optional): \"list\" (default, the records or lines), \"count\", or \"sum:<field>\"."
}

pub fn schema_properties() -> Value {
    json!({
        "files": { "description": "A glob (\"docs/**/*.md\") or an array of workspace-relative paths.",
                   "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] },
        "pick": { "type": "object", "description": "One of {\"json\": [fields]}, {\"lines_matching\": \"text\"}, {\"lines\": [start, end]}." },
        "keep": { "type": "object", "description": "json only: conditions a record must meet." },
        "total": { "type": "string", "description": "\"list\" (default), \"count\" or \"sum:<field>\"." }
    })
}

pub fn summary(call: &super::tools::NormalizedToolCall) -> String {
    match &call.input["files"] {
        Value::String(glob) => format!("read_many {glob}"),
        Value::Array(list) => format!("read_many {} files", list.len()),
        _ => "read_many".into(),
    }
}

enum Pick {
    Json(Vec<String>),
    Matching(String),
    Range(usize, usize),
}

enum Total {
    List,
    Count,
    Sum(String),
}

fn fail(message: String) -> ToolResult {
    ToolResult { ok: false, content: message, metadata: None }
}

pub fn run(ws: &Workspace, input: &Value, _run_id: &str, _runs_dir: Option<&std::path::Path>) -> ToolResult {
    let pick = match parse_pick(&input["pick"]) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let total = match input["total"].as_str().unwrap_or("list").trim() {
        "list" | "" => Total::List,
        "count" => Total::Count,
        s if s.starts_with("sum:") && s.len() > 4 => Total::Sum(s[4..].trim().to_string()),
        other => return fail(format!("total must be \"list\", \"count\" or \"sum:<field>\", not {other:?}.")),
    };
    let keep = match &input["keep"] {
        Value::Null => None,
        Value::Object(map) if matches!(pick, Pick::Json(_)) => Some(map.clone()),
        Value::Object(_) => return fail("keep works only with pick {\"json\": [...]}.".into()),
        _ => return fail("keep must be an object of conditions.".into()),
    };
    if let (Total::Sum(_), false) = (&total, matches!(pick, Pick::Json(_))) {
        return fail("sum:<field> works only with pick {\"json\": [...]}.".into());
    }
    let paths = match resolve_files(ws, &input["files"]) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };

    let mut failed = Vec::new();
    let mut items: Vec<Value> = Vec::new();
    let mut seen = 0usize;
    for rel in &paths {
        let text = match ws.resolve_existing(rel).and_then(|full| ws.read_text(&full, Access::Agent)) {
            Ok(t) => t,
            Err(e) => {
                failed.push(json!({ "file": rel, "error": e }));
                continue;
            }
        };
        match &pick {
            Pick::Json(fields) => {
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        failed.push(json!({ "file": rel, "error": format!("not JSON: {e}") }));
                        continue;
                    }
                };
                let records: Vec<&Value> = match &parsed {
                    Value::Array(rows) => rows.iter().collect(),
                    other => vec![other],
                };
                for record in records {
                    let Some(obj) = record.as_object() else { continue };
                    seen += 1;
                    if let Some(conditions) = &keep {
                        match matches_all(obj, conditions) {
                            Ok(true) => {}
                            Ok(false) => continue,
                            Err(e) => return fail(e),
                        }
                    }
                    let mut row = Map::new();
                    row.insert("file".into(), json!(rel));
                    for field in fields {
                        if let Some(v) = obj.get(field) {
                            row.insert(field.clone(), v.clone());
                        }
                    }
                    items.push(Value::Object(row));
                }
            }
            Pick::Matching(needle) => {
                for (i, line) in text.lines().enumerate() {
                    if line.contains(needle.as_str()) {
                        seen += 1;
                        items.push(json!({ "file": rel, "line": i + 1, "text": clip(line) }));
                    }
                }
            }
            Pick::Range(start, end) => {
                let lines: Vec<String> = text.lines().skip(start - 1).take(end + 1 - start).map(clip).collect();
                seen += 1;
                items.push(json!({ "file": rel, "from": start, "lines": lines }));
            }
        }
    }

    let mut out = Map::new();
    out.insert("files_read".into(), json!(paths.len() - failed.len()));
    if !failed.is_empty() {
        out.insert("files_failed".into(), Value::Array(failed));
    }
    if matches!(pick, Pick::Json(_)) {
        out.insert("records_seen".into(), json!(seen));
    }
    match total {
        Total::Count => {
            out.insert("count".into(), json!(items.len()));
        }
        Total::Sum(field) => {
            let mut sum = 0f64;
            let mut summed = 0usize;
            let mut not_numeric = 0usize;
            for item in &items {
                match item.get(&field) {
                    Some(v) if v.is_number() => {
                        sum += v.as_f64().unwrap_or(0.0);
                        summed += 1;
                    }
                    _ => not_numeric += 1,
                }
            }
            out.insert("count".into(), json!(items.len()));
            out.insert(format!("sum_{field}"), number(sum));
            if not_numeric > 0 {
                out.insert("records_without_numeric_field".into(), json!(not_numeric));
            }
            let _ = summed;
        }
        Total::List => {
            if items.len() > MAX_LIST_ITEMS {
                return fail(format!(
                    "{} items match — more than {MAX_LIST_ITEMS} to list. Narrow `keep`, or use total \"count\" / \"sum:<field>\".",
                    items.len()
                ));
            }
            out.insert("count".into(), json!(items.len()));
            out.insert("items".into(), Value::Array(items));
        }
    }
    ToolResult { ok: true, content: Value::Object(out).to_string(), metadata: Some(json!({ "filesRead": paths.len() })) }
}

/// Integral sums print without a trailing `.0`.
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn clip(line: &str) -> String {
    if line.chars().count() > MAX_LINE_CHARS {
        format!("{}…", line.chars().take(MAX_LINE_CHARS).collect::<String>())
    } else {
        line.to_string()
    }
}

fn parse_pick(pick: &Value) -> Result<Pick, String> {
    let Some(obj) = pick.as_object() else {
        return Err("pick is required: {\"json\": [fields]}, {\"lines_matching\": \"text\"} or {\"lines\": [start, end]}.".into());
    };
    if let Some(fields) = obj.get("json") {
        let fields: Vec<String> = fields
            .as_array()
            .ok_or("pick.json must be an array of field names.")?
            .iter()
            .filter_map(|f| f.as_str().map(str::to_string))
            .collect();
        if fields.is_empty() {
            return Err("pick.json needs at least one field name.".into());
        }
        return Ok(Pick::Json(fields));
    }
    if let Some(text) = obj.get("lines_matching") {
        let text = text.as_str().filter(|t| !t.is_empty()).ok_or("pick.lines_matching must be non-empty text.")?;
        return Ok(Pick::Matching(text.to_string()));
    }
    if let Some(range) = obj.get("lines") {
        let nums: Vec<u64> = range.as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
        return match nums.as_slice() {
            [s, e] if *s >= 1 && e >= s && (e - s) as usize <= MAX_RANGE_LINES => Ok(Pick::Range(*s as usize, *e as usize)),
            _ => Err(format!("pick.lines must be [start, end], 1-based, at most {MAX_RANGE_LINES} lines.")),
        };
    }
    Err("pick must have one of json, lines_matching or lines.".into())
}

fn resolve_files(ws: &Workspace, files: &Value) -> Result<Vec<String>, String> {
    let mut out = match files {
        Value::String(pattern) if !pattern.trim().is_empty() => {
            let pattern = pattern.trim();
            let mut all = Vec::new();
            super::tools::walk_files(ws.root(), ws.root(), &mut all);
            all.into_iter()
                .map(|p| ws.display(&p))
                .filter(|rel| wildcard_match(pattern, rel) || wildcard_match(&pattern.replace("**/", ""), rel))
                .collect::<Vec<_>>()
        }
        Value::Array(list) if !list.is_empty() => list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => return Err("files must be a glob string or a non-empty array of paths.".into()),
    };
    out.sort();
    out.dedup();
    if out.is_empty() {
        return Err("No files match `files`.".into());
    }
    if out.len() > MAX_FILES {
        return Err(format!("{} files match; the limit is {MAX_FILES}. Narrow the glob.", out.len()));
    }
    Ok(out)
}

fn matches_all(record: &Map<String, Value>, conditions: &Map<String, Value>) -> Result<bool, String> {
    for (field, cond) in conditions {
        let actual = record.get(field);
        let ok = match cond {
            Value::Null => actual.is_none() || actual == Some(&Value::Null),
            Value::Object(ops) if ops.keys().all(|k| matches!(k.as_str(), ">" | ">=" | "<" | "<=" | "!=")) && !ops.is_empty() => {
                let mut all = true;
                for (op, rhs) in ops {
                    all &= compare(actual, op, rhs)?;
                }
                all
            }
            other => actual == Some(other),
        };
        if !ok {
            return Ok(false);
        }
    }
    Ok(true)
}

fn compare(actual: Option<&Value>, op: &str, rhs: &Value) -> Result<bool, String> {
    if op == "!=" {
        return Ok(actual != Some(rhs));
    }
    let rhs = rhs.as_f64().ok_or_else(|| format!("keep: {op} needs a number."))?;
    let Some(lhs) = actual.and_then(Value::as_f64) else { return Ok(false) };
    Ok(match op {
        ">" => lhs > rhs,
        ">=" => lhs >= rhs,
        "<" => lhs < rhs,
        _ => lhs <= rhs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(files: &[(&str, &str)]) -> (std::path::PathBuf, Workspace) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("klide-read-many-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (name, body) in files {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let ws = Workspace::new(dir.to_str().unwrap()).unwrap();
        (dir, ws)
    }

    fn call(ws: &Workspace, input: Value) -> Value {
        let result = run(ws, &input, "run", None);
        assert!(result.ok, "{}", result.content);
        serde_json::from_str(&result.content).unwrap()
    }

    #[test]
    fn sums_and_counts_kept_records_across_files() {
        let (dir, ws) = workspace(&[
            ("b/0.json", r#"[{"active":true,"cents":10},{"active":false,"cents":99},{"active":true,"cents":-3}]"#),
            ("b/1.json", r#"[{"active":true,"cents":0}]"#),
            ("other.json", r#"[{"active":true,"cents":1000}]"#),
        ]);
        let out = call(&ws, json!({ "files": "b/*.json", "pick": { "json": ["cents"] }, "keep": { "active": true }, "total": "sum:cents" }));
        assert_eq!(out["files_read"], 2);
        assert_eq!(out["records_seen"], 4);
        assert_eq!(out["count"], 3);
        assert_eq!(out["sum_cents"], 7);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn comparisons_and_missing_fields_filter_an_audit() {
        let (dir, ws) = workspace(&[
            ("s/a.json", r#"{"name":"a","enabled":true,"timeout_ms":45000}"#),
            ("s/b.json", r#"{"name":"b","enabled":true,"timeout_ms":30000}"#),
            ("s/c.json", r#"{"name":"c","enabled":true,"timeout_ms":60000,"owner":"x"}"#),
            ("s/d.json", r#"{"name":"d","enabled":false,"timeout_ms":60000}"#),
        ]);
        let out = call(&ws, json!({ "files": "s/*.json", "pick": { "json": ["name"] },
            "keep": { "enabled": true, "timeout_ms": { ">": 30000 }, "owner": null } }));
        assert_eq!(out["records_seen"], 4);
        assert_eq!(out["items"], json!([{ "file": "s/a.json", "name": "a" }]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lines_matching_and_ranges() {
        let (dir, ws) = workspace(&[("x.md", "one\nTODO two\nthree\nTODO four"), ("y.md", "nothing")]);
        let out = call(&ws, json!({ "files": "*.md", "pick": { "lines_matching": "TODO" } }));
        assert_eq!(out["count"], 2);
        assert_eq!(out["items"][1], json!({ "file": "x.md", "line": 4, "text": "TODO four" }));
        let out = call(&ws, json!({ "files": ["x.md"], "pick": { "lines": [2, 3] } }));
        assert_eq!(out["items"][0]["lines"], json!(["TODO two", "three"]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_bad_file_is_reported_and_the_rest_still_counted() {
        let (dir, ws) = workspace(&[("a.json", r#"{"n":1}"#), ("b.json", "not json")]);
        let out = call(&ws, json!({ "files": ["a.json", "b.json", "../outside.json"], "pick": { "json": ["n"] }, "total": "sum:n" }));
        assert_eq!(out["files_read"], 1);
        assert_eq!(out["files_failed"].as_array().unwrap().len(), 2, "unparseable and outside the Workspace");
        assert_eq!(out["sum_n"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_malformed_form_gets_a_precise_error() {
        let (dir, ws) = workspace(&[("a.json", "{}")]);
        for (input, needle) in [
            (json!({ "files": "*.json" }), "pick is required"),
            (json!({ "files": "*.json", "pick": { "json": [] } }), "at least one field"),
            (json!({ "files": "*.json", "pick": { "json": ["n"] }, "total": "avg" }), "total must be"),
            (json!({ "files": "*.md", "pick": { "json": ["n"] } }), "No files match"),
            (json!({ "files": "*.json", "pick": { "lines_matching": "x" }, "keep": { "a": 1 } }), "keep works only"),
            (json!({ "files": "*.json", "pick": { "json": ["n"] }, "keep": { "n": { ">": "big" } } }), "needs a number"),
        ] {
            let result = run(&ws, &input, "run", None);
            assert!(!result.ok, "{input}");
            assert!(result.content.contains(needle), "{input}: {}", result.content);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
