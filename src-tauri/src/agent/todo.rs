use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A single task item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// A single todo mutation, used by the UI to show how an agent's plan evolved.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoEvent {
    pub seq: u64,
    pub action: String,
    pub todo_id: Option<String>,
    pub text: Option<String>,
    pub previous_text: Option<String>,
    pub done: Option<bool>,
    pub at: i64,
}

/// The on-disk todo list.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TodoStore {
    pub todos: Vec<TodoItem>,
    pub next_id: u64,
    #[serde(default)]
    pub events: Vec<TodoEvent>,
    #[serde(default = "default_next_event_id")]
    pub next_event_id: u64,
}

fn default_next_event_id() -> u64 {
    1
}

fn safe_scope(scope: &str) -> String {
    scope
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn store_path(root: &str, scope: &str) -> PathBuf {
    if scope.trim().is_empty() {
        return Path::new(root).join(".agents").join("todos.json");
    }
    Path::new(root)
        .join(".agents")
        .join("todos")
        .join(format!("{}.json", safe_scope(scope)))
}

fn load(root: &str, scope: &str) -> TodoStore {
    let path = store_path(root, scope);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<TodoStore>(&s).ok())
        .unwrap_or(TodoStore {
            todos: Vec::new(),
            next_id: 1,
            events: Vec::new(),
            next_event_id: 1,
        })
}

fn save(root: &str, scope: &str, store: &TodoStore) -> Result<(), String> {
    let path = store_path(root, scope);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create .agents dir: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(store).map_err(|e| format!("Cannot serialize todos: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Cannot write todos: {e}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn push_event(
    store: &mut TodoStore,
    action: &str,
    todo_id: Option<String>,
    text: Option<String>,
    previous_text: Option<String>,
    done: Option<bool>,
    at: i64,
) {
    store.events.push(TodoEvent {
        seq: store.next_event_id,
        action: action.to_string(),
        todo_id,
        text,
        previous_text,
        done,
        at,
    });
    store.next_event_id += 1;
    const MAX_EVENTS: usize = 120;
    if store.events.len() > MAX_EVENTS {
        let overflow = store.events.len() - MAX_EVENTS;
        store.events.drain(0..overflow);
    }
}

/// Return a formatted string of all todos, or None if there are none.
pub fn list_todos_text(root: &str, scope: &str) -> Option<String> {
    let store = load(root, scope);
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
pub fn add_todo(root: &str, scope: &str, text: String) -> Result<String, String> {
    let mut store = load(root, scope);
    let id = format!("T{}", store.next_id);
    store.next_id += 1;
    let at = now_ms();
    store.todos.push(TodoItem {
        id: id.clone(),
        text: text.clone(),
        done: false,
        created_at: at,
        updated_at: at,
    });
    push_event(&mut store, "add", Some(id.clone()), Some(text), None, Some(false), at);
    save(root, scope, &store)?;
    Ok(format!("Added todo {id}."))
}

/// Set the done status of a todo. Returns the updated status.
pub fn set_todo_done(root: &str, scope: &str, id: &str, done: bool) -> Result<String, String> {
    let mut store = load(root, scope);
    let at = now_ms();
    let item = store
        .todos
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Todo {id} not found."))?;
    let changed = item.done != done;
    item.done = done;
    item.updated_at = at;
    let status = if item.done { "done" } else { "pending" };
    if changed {
        push_event(
            &mut store,
            if done { "complete" } else { "uncomplete" },
            Some(id.to_string()),
            None,
            None,
            Some(done),
            at,
        );
    }
    save(root, scope, &store)?;
    Ok(format!("Todo {id} marked as {status}."))
}

/// Remove a todo by id.
pub fn remove_todo(root: &str, scope: &str, id: &str) -> Result<String, String> {
    let mut store = load(root, scope);
    let Some(index) = store.todos.iter().position(|t| t.id == id) else {
        return Err(format!("Todo {id} not found."));
    };
    let removed = store.todos.remove(index);
    push_event(
        &mut store,
        "remove",
        Some(id.to_string()),
        Some(removed.text),
        None,
        Some(removed.done),
        now_ms(),
    );
    save(root, scope, &store)?;
    Ok(format!("Removed todo {id}."))
}

/// Clear all completed todos. Returns a count of removed items.
pub fn clear_done(root: &str, scope: &str) -> Result<String, String> {
    let mut store = load(root, scope);
    let removed_items: Vec<TodoItem> = store.todos.iter().filter(|t| t.done).cloned().collect();
    let len_before = store.todos.len();
    store.todos.retain(|t| !t.done);
    let removed = len_before - store.todos.len();
    let at = now_ms();
    for item in removed_items {
        push_event(
            &mut store,
            "remove",
            Some(item.id),
            Some(item.text),
            None,
            Some(true),
            at,
        );
    }
    save(root, scope, &store)?;
    Ok(format!("Cleared {removed} completed todo(s)."))
}

/// Update the text of a todo item.
pub fn update_text(root: &str, scope: &str, id: &str, text: String) -> Result<String, String> {
    let mut store = load(root, scope);
    let at = now_ms();
    let (previous_text, done) = {
        let item = store
            .todos
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("Todo {id} not found."))?;
        let previous_text = item.text.clone();
        let done = item.done;
        item.text = text.clone();
        item.updated_at = at;
        (previous_text, done)
    };
    if previous_text != text {
        push_event(
            &mut store,
            "edit",
            Some(id.to_string()),
            Some(text),
            Some(previous_text),
            Some(done),
            at,
        );
    }
    save(root, scope, &store)?;
    Ok(format!("Updated todo {id}."))
}
