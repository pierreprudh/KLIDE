// The Stored conversation index on disk — one JSON file per conversation
// under `<app data>/conversations/`.
//
// The index used to live in the webview's localStorage, which WebKit caps at
// about 5 MB for the whole origin, shared with every other Klide key. A
// month of real use filled it, and every new thread then evicted an old one.
// A file per conversation has no such ceiling, and a streamed token rewrites
// only the conversation it belongs to, not the whole index.
//
// Rust stores and returns opaque JSON: the record's shape is the renderer's
// (`components/ai/storedConversations.ts`), which keeps the in-memory copy
// every surface reads synchronously and writes back here behind a debounce.
// The filename is the sha256 of the conversation id, so no id — whatever
// characters it carries — can name a path outside this folder.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

fn conversations_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("conversations"))
        .map_err(|e| format!("Unable to resolve the app data dir: {e}"))
}

fn file_for(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}

/// Every stored record, as one JSON array, plus how many files could not be
/// read. A corrupt file is skipped, not fatal: this is the conversation list's
/// cache, and the Run transcript stays the durable record of what was said.
#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConversations {
    pub json: String,
    pub skipped: usize,
}

fn load(dir: &Path) -> Result<LoadedConversations, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LoadedConversations { json: "[]".into(), skipped: 0 })
        }
        Err(e) => return Err(format!("Unable to read {}: {e}", dir.display())),
    };
    let mut records: Vec<String> = Vec::new();
    let mut skipped = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            skipped += 1;
            continue;
        };
        // Only an object is a record; anything else would break the array.
        match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text) {
            Ok(_) => records.push(text),
            Err(_) => skipped += 1,
        }
    }
    Ok(LoadedConversations {
        json: format!("[{}]", records.join(",")),
        skipped,
    })
}

#[derive(Deserialize, Debug)]
pub struct ConversationRecord {
    pub id: String,
    /// The record, already serialized by the renderer.
    pub json: String,
}

fn write(dir: &Path, records: &[ConversationRecord], removed: &[String]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Unable to create {}: {e}", dir.display()))?;
    for record in records {
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&record.json)
            .map_err(|e| format!("Conversation {} is not a JSON object: {e}", record.id))?;
        crate::durable::write_atomic(&file_for(dir, &record.id), record.json.as_bytes())?;
    }
    for id in removed {
        match std::fs::remove_file(file_for(dir, id)) {
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

/// Write the records that changed and delete the ones that were forgotten.
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
        let dir = std::env::temp_dir().join(format!("klide-convos-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn record(id: &str, json: &str) -> ConversationRecord {
        ConversationRecord { id: id.into(), json: json.into() }
    }

    fn ids(loaded: &LoadedConversations) -> Vec<String> {
        let values: Vec<serde_json::Value> = serde_json::from_str(&loaded.json).unwrap();
        let mut ids: Vec<String> = values.iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_missing_folder_is_an_empty_index() {
        let dir = temp("missing");
        assert_eq!(load(&dir).unwrap(), LoadedConversations { json: "[]".into(), skipped: 0 });
    }

    #[test]
    fn writes_replace_and_forget_one_record_at_a_time() {
        let dir = temp("roundtrip");
        write(&dir, &[record("a", r#"{"id":"a","n":1}"#), record("b", r#"{"id":"b"}"#)], &[]).unwrap();
        write(&dir, &[record("a", r#"{"id":"a","n":2}"#)], &["b".into()]).unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(ids(&loaded), vec!["a"]);
        assert!(loaded.json.contains(r#""n":2"#));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_id_never_names_a_path_outside_the_folder() {
        let dir = temp("traversal");
        write(&dir, &[record("../../escape", r#"{"id":"../../escape"}"#)], &[]).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1);
        assert!(names[0].len() == 64 + ".json".len(), "{names:?}");
        assert!(!dir.parent().unwrap().join("escape").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_is_skipped_and_counted() {
        let dir = temp("corrupt");
        write(&dir, &[record("ok", r#"{"id":"ok"}"#)], &[]).unwrap();
        std::fs::write(dir.join("broken.json"), "{\"id\":").unwrap();
        std::fs::write(dir.join("array.json"), "[1,2]").unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(ids(&loaded), vec!["ok"]);
        assert_eq!(loaded.skipped, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_that_is_not_an_object_is_refused() {
        let dir = temp("refuse");
        assert!(write(&dir, &[record("x", "[]")], &[]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
