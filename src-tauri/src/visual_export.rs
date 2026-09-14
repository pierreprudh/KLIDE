use base64::Engine;
use tauri_plugin_dialog::DialogExt;

/// Export is explicitly user-picked: the caller supplies image bytes, never a path.
#[tauri::command]
pub async fn save_visual_png(app: tauri::AppHandle, content: String) -> Result<(), String> {
    crate::blocking::run(move || {
        if content.len() > 90_000_000 { return Err("Image is too large to save".into()); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(content).map_err(|e| e.to_string())?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("Expected a PNG image".into()); }
        let Some(file) = app.dialog().file().set_file_name("visual.png").add_filter("PNG image", &["png"]).blocking_save_file() else { return Ok(()); };
        let path = file.into_path().map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| format!("Could not save image: {e}"))
    }).await
}
