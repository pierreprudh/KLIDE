//! Conversation snapshots in SQLite. Run JSONL transcripts remain independent.
//!
//! Metadata and ordered messages are separate rows. Existing per-conversation
//! JSON files are imported once in a transaction and kept as a recovery copy
//! until their conversation is deleted. A completed migration marker prevents
//! deleted conversations being reimported.
//!
//! One connection per database, opened (and migrated) on first use: the
//! renderer flushes every 400 ms while a turn streams, and a fresh open per
//! flush re-ran the schema and took the write lock twice.

use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

fn conversations_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("conversations"))
        .map_err(|e| format!("Unable to resolve the app data dir: {e}"))
}

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConversations {
    pub json: String,
    pub skipped: usize,
}

#[derive(Deserialize, Debug)]
pub struct ConversationRecord {
    pub id: String,
    pub json: String,
}

fn decode(record: &ConversationRecord) -> Result<(Map<String, Value>, Vec<Value>), String> {
    let mut metadata: Map<String, Value> = serde_json::from_str(&record.json)
        .map_err(|e| format!("Conversation {} is not a JSON object: {e}", record.id))?;
    if record.id.is_empty()
        || metadata.get("id").and_then(Value::as_str) != Some(record.id.as_str())
    {
        return Err("Conversation id is missing or does not match its record".into());
    }
    let messages = match metadata.remove("msgs") {
        Some(Value::Array(messages)) => messages,
        _ => return Err(format!("Conversation {} has no message array", record.id)),
    };
    Ok((metadata, messages))
}

fn put(conn: &Connection, record: &ConversationRecord) -> Result<(), String> {
    let (metadata, messages) = decode(record)?;
    let updated = metadata
        .get("updatedAt")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO conversations (id, updated_at, metadata) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, metadata=excluded.metadata",
        params![record.id, updated, Value::Object(metadata).to_string()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM conversation_messages WHERE conversation_id=?1 AND position>=?2",
        params![record.id, messages.len() as i64],
    )
    .map_err(|e| e.to_string())?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO conversation_messages (conversation_id, position, body) VALUES (?1, ?2, ?3)
         ON CONFLICT(conversation_id, position) DO UPDATE SET body=excluded.body
         WHERE conversation_messages.body != excluded.body"
    ).map_err(|e| e.to_string())?;
    for (position, message) in messages.iter().enumerate() {
        insert
            .execute(params![record.id, position as i64, message.to_string()])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn open(dir: &Path) -> Result<(Connection, usize), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Unable to create {}: {e}", dir.display()))?;
    let mut conn =
        Connection::open(dir.join("conversations.sqlite3")).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS conversations_recency ON conversations(updated_at DESC, id);
         CREATE TABLE IF NOT EXISTS conversation_messages (
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            position INTEGER NOT NULL, body TEXT NOT NULL,
            PRIMARY KEY(conversation_id, position)
         );
         CREATE TABLE IF NOT EXISTS conversation_migrations (name TEXT PRIMARY KEY);",
    )
    .map_err(|e| e.to_string())?;
    // The write lock also serializes first-open migration across connections.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let migrated: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_migrations WHERE name='json-files-v1')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut skipped = 0;
    if !migrated {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let json = std::fs::read_to_string(&path)
                .map_err(|e| format!("Unable to read {}: {e}", path.display()))?;
            let record = serde_json::from_str::<Value>(&json).ok().and_then(|v| {
                v.get("id")
                    .and_then(Value::as_str)
                    .map(|id| ConversationRecord {
                        id: id.into(),
                        json,
                    })
            });
            let Some(record) = record else {
                skipped += 1;
                continue;
            };
            if decode(&record).is_err() {
                skipped += 1;
                continue;
            }
            // Existing SQLite rows win on a retry; imports never overwrite them.
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM conversations WHERE id=?1)",
                    [&record.id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                put(&tx, &record)?;
            }
        }
        tx.execute(
            "INSERT INTO conversation_migrations(name) VALUES ('json-files-v1')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok((conn, skipped))
}

struct Store {
    conn: Connection,
    /// Legacy files the one-time import could not read; the next load reports them.
    unimported: usize,
}

/// Keyed by folder so tests, each in its own folder, never share a database.
static STORES: Mutex<BTreeMap<PathBuf, Store>> = Mutex::new(BTreeMap::new());

fn with_store<T>(dir: &Path, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    // A panic mid-transaction already rolled back when its Transaction dropped.
    let mut stores = STORES.lock().unwrap_or_else(|e| e.into_inner());
    if !stores.contains_key(dir) {
        // A failed open is not cached, so a failed import retries next call.
        let (conn, unimported) = open(dir)?;
        stores.insert(dir.to_path_buf(), Store { conn, unimported });
    }
    f(stores.get_mut(dir).expect("inserted above"))
}

/// The file the pre-SQLite store kept this conversation in.
fn legacy_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}

fn conversation(
    messages: &mut rusqlite::CachedStatement,
    id: &str,
    json: &str,
) -> Result<Value, String> {
    let mut metadata: Map<String, Value> =
        serde_json::from_str(json).map_err(|e| format!("Invalid conversation {id}: {e}"))?;
    let bodies = messages
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut content = Vec::new();
    for body in bodies {
        content.push(
            serde_json::from_str::<Value>(&body.map_err(|e| e.to_string())?)
                .map_err(|e| format!("Invalid conversation message in {id}: {e}"))?,
        );
    }
    metadata.insert("msgs".into(), Value::Array(content));
    Ok(Value::Object(metadata))
}

/// Every conversation, newest first. A row that no longer decodes is counted
/// and left in place rather than failing the load: one bad row must not hide
/// the whole history (the Run transcript still has what was said).
fn load(dir: &Path) -> Result<LoadedConversations, String> {
    with_store(dir, |store| {
        let mut skipped = 0;
        let mut records = Vec::new();
        {
            // One read transaction keeps metadata and messages at the same revision.
            let tx = store.conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let mut rows = tx
                .prepare("SELECT id, metadata FROM conversations ORDER BY updated_at DESC, id")
                .map_err(|e| e.to_string())?;
            let rows = rows
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let mut messages = tx
                .prepare_cached(
                    "SELECT body FROM conversation_messages WHERE conversation_id=?1 ORDER BY position",
                )
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, json) = row.map_err(|e| e.to_string())?;
                match conversation(&mut messages, &id, &json) {
                    Ok(record) => records.push(record),
                    Err(_) => skipped += 1,
                }
            }
        }
        skipped += std::mem::take(&mut store.unimported);
        Ok(LoadedConversations {
            json: Value::Array(records).to_string(),
            skipped,
        })
    })
}

fn write(dir: &Path, records: &[ConversationRecord], removed: &[String]) -> Result<(), String> {
    with_store(dir, |store| {
        let tx = store
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        for record in records {
            put(&tx, record)?;
        }
        for id in removed {
            tx.execute("DELETE FROM conversations WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    })?;
    // A deleted conversation must not survive in its pre-SQLite recovery copy.
    // After the commit, so a rolled-back delete keeps its file; an error here
    // makes the renderer retry the delete, which finds the rows already gone.
    for id in removed {
        match std::fs::remove_file(legacy_file(dir, id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Unable to forget conversation {id}: {e}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn conversations_load(app: tauri::AppHandle) -> Result<LoadedConversations, String> {
    crate::blocking::run(move || load(&conversations_dir(&app)?)).await
}

#[tauri::command]
pub async fn conversations_write(
    app: tauri::AppHandle,
    records: Vec<ConversationRecord>,
    removed: Vec<String>,
) -> Result<(), String> {
    crate::blocking::run(move || write(&conversations_dir(&app)?, &records, &removed)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klide-sqlite-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn record(id: &str, n: i64) -> ConversationRecord {
        ConversationRecord { id: id.into(), json: serde_json::json!({
            "id":id,"updatedAt":n,"title":"kept","forkedFrom":{"conversationId":"parent"},
            "msgs":[{"role":"user","content":format!("turn {n}"),"attachments":[{"path":"pic.png"}]},{"role":"assistant","thinking":"notes","toolCalls":[]}]
        }).to_string() }
    }
    fn values(dir: &Path) -> Vec<Value> {
        serde_json::from_str(&load(dir).unwrap().json).unwrap()
    }

    #[test]
    fn roundtrip_update_delete_and_unbounded_history() {
        let dir = temp("roundtrip");
        let records: Vec<_> = (0..350).map(|n| record(&format!("c{n}"), n)).collect();
        write(&dir, &records, &[]).unwrap();
        assert_eq!(values(&dir).len(), 350);
        write(&dir, &[record("c0", 500)], &["c1".into()]).unwrap();
        let loaded = values(&dir);
        assert_eq!(loaded.len(), 349);
        assert_eq!(
            loaded[0],
            serde_json::from_str::<Value>(&record("c0", 500).json).unwrap()
        );
        assert!(!loaded.iter().any(|v| v["id"] == "c1"));
        let conn = Connection::open(dir.join("conversations.sqlite3")).unwrap();
        let orphans: i64 = conn
            .query_row(
                "SELECT count(*) FROM conversation_messages WHERE conversation_id='c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn migrates_json_once_without_touching_transcripts_or_resurrecting_deletions() {
        let dir = temp("migration");
        let original = record("legacy", 1);
        std::fs::write(dir.join("old.json"), &original.json).unwrap();
        std::fs::write(dir.join("broken.json"), "{").unwrap();
        std::fs::write(dir.join("run.jsonl"), "original transcript").unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(loaded.skipped, 1);
        assert_eq!(
            values(&dir),
            vec![serde_json::from_str::<Value>(&original.json).unwrap()]
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("old.json")).unwrap(),
            original.json
        );
        write(&dir, &[], &["legacy".into()]).unwrap();
        assert!(values(&dir).is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join("run.jsonl")).unwrap(),
            "original transcript"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_batch_rolls_back_updates_and_deletions() {
        let dir = temp("rollback");
        write(&dir, &[record("a", 1), record("b", 2)], &[]).unwrap();
        let bad = ConversationRecord {
            id: "bad".into(),
            json: "[]".into(),
        };
        assert!(write(&dir, &[record("a", 3), bad], &["b".into()]).is_err());
        let loaded = values(&dir);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[1]["updatedAt"], 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn edited_and_shortened_snapshots_replace_messages_without_stale_tail_rows() {
        let dir = temp("messages");
        write(&dir, &[record("a", 1)], &[]).unwrap();
        let changed = ConversationRecord {
            id: "a".into(),
            json: serde_json::json!({
                "id":"a", "updatedAt":2, "msgs":[{"role":"user","content":"edited"}]
            })
            .to_string(),
        };
        write(&dir, &[changed], &[]).unwrap();
        assert_eq!(
            values(&dir)[0]["msgs"],
            serde_json::json!([{"role":"user","content":"edited"}])
        );
        write(
            &dir,
            &[ConversationRecord {
                id: "a".into(),
                json: r#"{"id":"a","msgs":[]}"#.into(),
            }],
            &[],
        )
        .unwrap();
        assert_eq!(values(&dir)[0]["msgs"], serde_json::json!([]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_file_migration_is_retryable_and_never_publishes_a_partial_import() {
        let dir = temp("retry");
        std::fs::write(dir.join("good.json"), record("good", 1).json).unwrap();
        // An unreadable source is an IO failure, not a corrupt record to skip.
        std::fs::create_dir(dir.join("unreadable.json")).unwrap();
        assert!(load(&dir).is_err());
        let conn = Connection::open(dir.join("conversations.sqlite3")).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM conversations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        std::fs::remove_dir(dir.join("unreadable.json")).unwrap();
        assert_eq!(values(&dir).len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn deleting_a_conversation_removes_its_legacy_recovery_copy() {
        let dir = temp("legacy-delete");
        let gone = legacy_file(&dir, "gone");
        let kept = legacy_file(&dir, "kept");
        std::fs::write(&gone, record("gone", 1).json).unwrap();
        std::fs::write(&kept, record("kept", 2).json).unwrap();
        assert_eq!(values(&dir).len(), 2);
        write(&dir, &[], &["gone".into()]).unwrap();
        assert!(!gone.exists());
        assert!(kept.exists());
        // A conversation that never had a legacy file deletes cleanly too.
        write(&dir, &[record("new", 3)], &[]).unwrap();
        write(&dir, &[], &["new".into()]).unwrap();
        assert_eq!(values(&dir).len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_corrupt_row_is_counted_and_never_hides_the_rest() {
        let dir = temp("corrupt-row");
        write(&dir, &[record("a", 1), record("b", 2), record("c", 3)], &[]).unwrap();
        let conn = Connection::open(dir.join("conversations.sqlite3")).unwrap();
        conn.execute("UPDATE conversation_messages SET body='{' WHERE conversation_id='b'", [])
            .unwrap();
        conn.execute("UPDATE conversations SET metadata='[' WHERE id='c'", [])
            .unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(loaded.skipped, 2);
        let ids: Vec<Value> = serde_json::from_str::<Vec<Value>>(&loaded.json)
            .unwrap()
            .into_iter()
            .map(|v| v["id"].clone())
            .collect();
        assert_eq!(ids, vec![Value::from("a")]);
        // Rewriting the thread repairs it.
        write(&dir, &[record("b", 4)], &[]).unwrap();
        assert_eq!(values(&dir).len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_legacy_files_are_reported_on_the_first_load_only() {
        let dir = temp("report-once");
        std::fs::write(dir.join("broken.json"), "{").unwrap();
        assert_eq!(load(&dir).unwrap().skipped, 1);
        assert_eq!(load(&dir).unwrap().skipped, 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ids_are_database_keys_and_must_match_the_payload() {
        let dir = temp("ids");
        write(&dir, &[record("../../escape'", 1)], &[]).unwrap();
        assert_eq!(values(&dir)[0]["id"], "../../escape'");
        assert!(write(
            &dir,
            &[ConversationRecord {
                id: "wrong".into(),
                json: record("other", 1).json
            }],
            &[]
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
