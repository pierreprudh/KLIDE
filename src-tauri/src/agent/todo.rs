use serde::{Deserialize, Serialize};
use std::path::Path;

/// A single task item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    pub created_at: i64,
}

/// The on-disk todo list.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TodoStore {
    pub todos: Vec<TodoItem>,
    pub next_id: u64,
}

fn store_path(root: &str) -> std::path::PathBuf {
    Path::new(root).join(".agents").join("todos.json")
}

fn load(root: &str) -> TodoStore {
    let path = store_path(root);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<TodoStore>(&s).ok())
        .unwrap_or(TodoStore {
            todos: Vec::new(),
            next_id: 1,
        })
}

fn save(root: &str, store: &TodoStore) -> Result<(), String> {
    let path = store_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create .agents dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Cannot serialize todos: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Cannot write todos: {e}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Return a formatted string of all todos, or None if there are none.
pub fn list_todos_text(root: &str) -> Option<String> {
    let store = load(root);
    if store.todos.is_empty() {
        return None;
    }
    let mut lines = Vec::new();
    for item in &store.todos {
        let checkbox = if item.done { "[x]" } else { "[ ]" };
        lines.push(format!("{} {}: {}", checkbox, item.id, item.text));
    }
    Some(lines.join("\n"))
}

/// Add a new todo item. Returns a confirmation message.
pub fn add_todo(root: &str, text: String) -> Result<String, String> {
    let mut store = load(root);
    let id = format!("T{}", store.next_id);
    store.next_id += 1;
    store.todos.push(TodoItem {
        id: id.clone(),
        text,
        done: false,
        created_at: now_ms(),
    });
    save(root, &store)?;
    Ok(format!("Added todo {id}."))
}

/// Toggle the done status of a todo. Returns the updated status.
pub fn toggle_todo(root: &str, id: &str) -> Result<String, String> {
    let mut store = load(root);
    let item = store
        .todos
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Todo {id} not found."))?;
    item.done = !item.done;
    let status = if item.done { "done" } else { "pending" };
    save(root, &store)?;
    Ok(format!("Todo {id} marked as {status}."))
}

/// Remove a todo by id.
pub fn remove_todo(root: &str, id: &str) -> Result<String, String> {
    let mut store = load(root);
    let len_before = store.todos.len();
    store.todos.retain(|t| t.id != id);
    if store.todos.len() == len_before {
        return Err(format!("Todo {id} not found."));
    }
    save(root, &store)?;
    Ok(format!("Removed todo {id}."))
}

/// Clear all completed todos. Returns a count of removed items.
pub fn clear_done(root: &str) -> Result<String, String> {
    let mut store = load(root);
    let len_before = store.todos.len();
    store.todos.retain(|t| !t.done);
    let removed = len_before - store.todos.len();
    save(root, &store)?;
    Ok(format!("Cleared {removed} completed todo(s)."))
}

/// Update the text of a todo item.
pub fn update_text(root: &str, id: &str, text: String) -> Result<String, String> {
    let mut store = load(root);
    let item = store
        .todos
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Todo {id} not found."))?;
    item.text = text;
    save(root, &store)?;
    Ok(format!("Updated todo {id}."))
}
