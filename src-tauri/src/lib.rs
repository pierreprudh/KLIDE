mod pty;
use pty::{pty_spawn, pty_write, PtyState};
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState { writer: Mutex::new(None) })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


