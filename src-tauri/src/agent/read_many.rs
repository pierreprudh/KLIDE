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
`files`: a glob such as \"services/*.json\", a list of paths, or {\"from\": \"index.json\", \"key\": \"batches\"} to read exactly \
the paths a JSON file lists. When the task says to follow a list or index, use `from`, not a glob. \
`pick`: what to take from each file — {\"json\": [field names]} (a JSON file holding an object or an array of objects; each object is one record), \
{\"lines_matching\": \"text\"} (lines containing the text), or {\"lines\": [start, end]}. \
`keep` (json only, optional): conditions every kept record must meet — {\"field\": value} for equality, \
{\"field\": {\">\": 30000}} with >, >=, <, <=, != , or {\"field\": null} for a missing field. \
`total` (optional): \"list\" (default, the records or lines), \"count\", or \"sum:<field>\"."
}

pub fn schema_properties() -> Value {
    json!({
        "files": { "description": "A glob (\"docs/**/*.md\"), an array of workspace-relative paths, or {\"from\": \"index.json\", \"key\": \"batches\"} for the paths a JSON file lists.",
                   "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } },
                             { "type": "object", "properties": { "from": { "type": "string" }, "key": { "type": "string" } }, "required": ["from"] }] },
        "pick": { "type": "object", "description": "One of {\"json\": [fields]}, {\"lines_matching\": \"text\"}, {\"lines\": [start, end]}." },
        "keep": { "type": "object", "description": "json only: conditions a record must meet." },
        "total": { "type": "string", "description": "\"list\" (default), \"count\" or \"sum:<field>\"." }
    })
}

pub fn summary(call: &super::tools::NormalizedToolCall) -> String {
    match &call.input["files"] {
        Value::String(glob) => format!("read_many {glob}"),
        Value::Array(list) => format!("read_many {} files", list.len()),
        Value::Object(o) if o.get("from").and_then(Value::as_str).is_some() => format!("read_many files listed in {}", o["from"].as_str().unwrap_or("")),
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
    let pick_field = decoded_object(&input["pick"]);
    let keep_field = decoded_object(&input["keep"]);
    let pick = match parse_pick(&pick_field) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let total = match input["total"].as_str().unwrap_or("list").trim() {
        "list" | "" => Total::List,
        "count" => Total::Count,
        s if s.starts_with("sum:") && s.len() > 4 => Total::Sum(s[4..].trim().to_string()),
        other => return fail(format!("total must be \"list\", \"count\" or \"sum:<field>\", not {other:?}.")),
    };
    let keep = match &keep_field {
        Value::Null => None,
        Value::Object(map) if matches!(pick, Pick::Json(_)) => Some(map.clone()),
        Value::Object(_) => return fail("keep works only with pick {\"json\": [...]}.".into()),
        _ => return fail("keep must be an object of conditions.".into()),
    };
    if let (Total::Sum(_), false) = (&total, matches!(pick, Pick::Json(_))) {
        return fail("sum:<field> works only with pick {\"json\": [...]}.".into());
    }
    let Resolved { paths, index_note } = match resolve_files(ws, &input["files"]) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let mut notes: Vec<String> = index_note.into_iter().collect();
    if keep.is_none() && matches!(pick, Pick::Json(_)) && !matches!(total, Total::List) {
        notes.push("No keep was given, so every record was counted. Add keep if the task counts only some records.".into());
    }

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
    if !notes.is_empty() {
        out.insert("notes".into(), json!(notes));
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

/// Small models send an object field JSON-encoded in a string
/// (`"pick": "{\"json\": [...]}"`). Take it as the object it plainly is.
fn decoded_object(field: &Value) -> Value {
    match field {
        Value::String(text) if text.trim_start().starts_with('{') => {
            serde_json::from_str::<Value>(text.trim()).ok().filter(Value::is_object).unwrap_or_else(|| field.clone())
        }
        _ => field.clone(),
    }
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

struct Resolved {
    paths: Vec<String>,
    /// Set when a glob matched files that a JSON list in the Workspace leaves out.
    index_note: Option<String>,
}

fn resolve_files(ws: &Workspace, files: &Value) -> Result<Resolved, String> {
    // Models often send the list JSON-encoded inside a string. Take it as the
    // list it plainly is rather than as a glob that matches nothing.
    let decoded = match files {
        Value::String(text) if text.trim_start().starts_with('[') || text.trim_start().starts_with('{') => {
            serde_json::from_str::<Value>(text.trim()).ok()
        }
        _ => None,
    };
    let files = decoded.as_ref().filter(|v| v.is_array() || v.is_object()).unwrap_or(files);
    let mut index_note = None;
    let mut out = match files {
        Value::String(pattern) if !pattern.trim().is_empty() => {
            let pattern = pattern.trim();
            let mut all = Vec::new();
            super::tools::walk_files(ws.root(), ws.root(), &mut all);
            let all: Vec<String> = all.into_iter().map(|p| ws.display(&p)).collect();
            let mut matched: Vec<String> = all
                .iter()
                .filter(|rel| wildcard_match(pattern, rel) || wildcard_match(&pattern.replace("**/", ""), rel))
                .cloned()
                .collect();
            matched.sort();
            index_note = index_note_for(ws, &all, &matched);
            matched
        }
        Value::Array(list) if !list.is_empty() => list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        Value::Object(spec) => listed_in(ws, spec)?,
        _ => return Err("files must be a glob string, a non-empty array of paths, or {\"from\": \"index.json\", \"key\": \"...\"}.".into()),
    };
    out.sort();
    out.dedup();
    if out.is_empty() {
        return Err(match files {
            Value::String(pattern) => format!("No files match the glob {pattern:?}. Pass a glob like \"dir/*.json\" or a JSON array of paths."),
            Value::Object(_) => "That list names no paths.".into(),
            _ => "None of the listed paths exist.".into(),
        });
    }
    if out.len() > MAX_FILES {
        return Err(format!("{} files match; the limit is {MAX_FILES}. Narrow the glob.", out.len()));
    }
    Ok(Resolved { paths: out, index_note })
}

/// `{"from": "index.json", "key": "batches"}` — the paths a JSON file lists,
/// relative to that file's folder. Without `key`, a top-level array or the
/// object's only array of strings.
fn listed_in(ws: &Workspace, spec: &Map<String, Value>) -> Result<Vec<String>, String> {
    let from = spec.get("from").and_then(Value::as_str).filter(|f| !f.trim().is_empty()).ok_or("files.from must name a JSON file.")?;
    let text = ws.resolve_existing(from).and_then(|full| ws.read_text(&full, Access::Agent)).map_err(|e| format!("files.from {from:?}: {e}"))?;
    let doc: Value = serde_json::from_str(&text).map_err(|e| format!("files.from {from:?} is not JSON: {e}"))?;
    let list = match spec.get("key").and_then(Value::as_str) {
        Some(key) => doc.get(key).ok_or_else(|| format!("{from:?} has no field {key:?}. Fields: {}.", field_names(&doc)))?,
        None => match &doc {
            Value::Array(_) => &doc,
            Value::Object(map) => {
                let mut arrays = map.values().filter(|v| is_string_list(v));
                match (arrays.next(), arrays.next()) {
                    (Some(only), None) => only,
                    _ => return Err(format!("{from:?} has several fields; name one with key. Fields: {}.", field_names(&doc))),
                }
            }
            _ => return Err(format!("{from:?} holds no list of paths.")),
        },
    };
    if !is_string_list(list) {
        return Err(format!("files.from {from:?}: that field is not a list of paths."));
    }
    let dir = from.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    Ok(list.as_array().unwrap().iter().filter_map(Value::as_str).map(|p| join(dir, p)).collect())
}

fn field_names(doc: &Value) -> String {
    doc.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>().join(", ")).unwrap_or_else(|| "none".into())
}

fn is_string_list(v: &Value) -> bool {
    v.as_array().is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_string))
}

fn join(dir: &str, path: &str) -> String {
    if dir.is_empty() || path.starts_with('/') {
        path.to_string()
    } else {
        format!("{dir}/{path}")
    }
}

/// A glob is the easy shortcut past an index: it also catches files the
/// index leaves out. If a small JSON file in the Workspace lists at least two
/// of the matched files but not all of them, say so — the model decides.
fn index_note_for(ws: &Workspace, all: &[String], matched: &[String]) -> Option<String> {
    const MAX_CANDIDATES: usize = 50;
    const MAX_INDEX_BYTES: u64 = 256 * 1024;
    if matched.len() < 3 {
        return None;
    }
    let matched_set: std::collections::HashSet<&str> = matched.iter().map(String::as_str).collect();
    let mut best: Option<(String, Vec<String>)> = None;
    for rel in all.iter().filter(|r| r.ends_with(".json") && !matched_set.contains(r.as_str())).take(MAX_CANDIDATES) {
        let Ok(full) = ws.resolve_existing(rel) else { continue };
        if std::fs::metadata(&full).map(|m| m.len() > MAX_INDEX_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(doc) = ws.read_text(&full, Access::Agent).map_err(|_| ()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|_| ())) else {
            continue;
        };
        let dir = rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        let mut named = Vec::new();
        collect_strings(&doc, &mut |s| {
            let path = join(dir, s);
            if matched_set.contains(path.as_str()) {
                named.push(path);
            }
        });
        named.sort();
        named.dedup();
        if named.len() >= 2 && named.len() < matched.len() && best.as_ref().is_none_or(|(_, b)| named.len() > b.len()) {
            best = Some((rel.clone(), named));
        }
    }
    let (index, named) = best?;
    let named: std::collections::HashSet<&str> = named.iter().map(String::as_str).collect();
    let unlisted: Vec<&str> = matched.iter().map(String::as_str).filter(|m| !named.contains(m)).collect();
    let shown: Vec<&str> = unlisted.iter().take(5).copied().collect();
    let more = if unlisted.len() > shown.len() { format!(" and {} more", unlisted.len() - shown.len()) } else { String::new() };
    Some(format!(
        "{index} lists {} of the {} files this glob matched; not listed: {}{more}. If the task follows {index}, call again with files {{\"from\": \"{index}\"}}.",
        named.len(),
        matched.len(),
        shown.join(", ")
    ))
}

fn collect_strings(v: &Value, f: &mut impl FnMut(&str)) {
    match v {
        Value::String(s) => f(s),
        Value::Array(a) => a.iter().for_each(|x| collect_strings(x, f)),
        Value::Object(m) => m.values().for_each(|x| collect_strings(x, f)),
        _ => {}
    }
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
    fn a_list_sent_as_a_json_string_is_read_as_the_list() {
        let (dir, ws) = workspace(&[("a.json", r#"{"n":2}"#), ("b.json", r#"{"n":3}"#), ("c.json", r#"{"n":100}"#)]);
        let out = call(&ws, json!({ "files": "[\"a.json\", \"b.json\"]", "pick": { "json": ["n"] }, "total": "sum:n" }));
        assert_eq!(out["files_read"], 2);
        assert_eq!(out["sum_n"], 5);
        let out = call(&ws, json!({ "files": "*.json", "pick": "{\"json\": [\"n\"]}", "keep": "{\"n\": {\">\": 2}}", "total": "sum:n" }));
        assert_eq!(out["sum_n"], 103, "pick and keep sent as JSON strings");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn files_from_an_index_reads_exactly_what_it_lists() {
        let (dir, ws) = workspace(&[
            ("d/index.json", r#"{"title":"x","batches":["a.json","b.json"]}"#),
            ("d/a.json", r#"[{"n":2}]"#),
            ("d/b.json", r#"[{"n":3}]"#),
            ("d/unlisted.json", r#"[{"n":1000}]"#),
        ]);
        let out = call(&ws, json!({ "files": { "from": "d/index.json", "key": "batches" }, "pick": { "json": ["n"] }, "total": "sum:n" }));
        assert_eq!((out["files_read"].clone(), out["sum_n"].clone()), (json!(2), json!(5)));
        let out = call(&ws, json!({ "files": { "from": "d/index.json" }, "pick": { "json": ["n"] }, "total": "sum:n" }));
        assert_eq!(out["sum_n"], 5, "the only list of strings is taken without a key");
        let out = call(&ws, json!({ "files": "{\"from\": \"d/index.json\"}", "pick": { "json": ["n"] }, "total": "sum:n" }));
        assert_eq!(out["sum_n"], 5, "the spec sent as a JSON string");
        let result = run(&ws, &json!({ "files": { "from": "d/index.json", "key": "nope" }, "pick": { "json": ["n"] } }), "run", None);
        assert!(!result.ok && result.content.contains("has no field \"nope\"") && result.content.contains("batches"), "{}", result.content);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_glob_past_an_index_is_flagged_and_a_missing_keep_is_named() {
        let (dir, ws) = workspace(&[
            ("index.json", r#"{"batches":["batch-0.json","batch-1.json","batch-2.json"]}"#),
            ("batch-0.json", r#"[{"active":true,"cents":1}]"#),
            ("batch-1.json", r#"[{"active":false,"cents":2}]"#),
            ("batch-2.json", r#"[{"active":true,"cents":3}]"#),
            ("batch-unlisted.json", r#"[{"active":true,"cents":1000}]"#),
        ]);
        let out = call(&ws, json!({ "files": "batch-*.json", "pick": { "json": ["cents"] }, "total": "sum:cents" }));
        let notes = out["notes"].to_string();
        assert!(notes.contains("index.json lists 3 of the 4 files") && notes.contains("batch-unlisted.json"), "{notes}");
        assert!(notes.contains("No keep was given"), "{notes}");
        let out = call(&ws, json!({ "files": { "from": "index.json" }, "pick": { "json": ["cents"] }, "keep": { "active": true }, "total": "sum:cents" }));
        assert!(out.get("notes").is_none(), "{out}");
        assert_eq!(out["sum_cents"], 4);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_glob_no_list_names_carries_no_note() {
        let (dir, ws) = workspace(&[("s/a.json", "{}"), ("s/b.json", "{}"), ("s/c.json", "{}"), ("package.json", r#"{"name":"x"}"#)]);
        let out = call(&ws, json!({ "files": "s/*.json", "pick": { "json": ["n"] } }));
        assert!(out.get("notes").is_none(), "{out}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_malformed_form_gets_a_precise_error() {
        let (dir, ws) = workspace(&[("a.json", "{}")]);
        for (input, needle) in [
            (json!({ "files": "*.json" }), "pick is required"),
            (json!({ "files": "*.json", "pick": { "json": [] } }), "at least one field"),
            (json!({ "files": "*.json", "pick": { "json": ["n"] }, "total": "avg" }), "total must be"),
            (json!({ "files": "*.md", "pick": { "json": ["n"] } }), "No files match the glob"),
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
