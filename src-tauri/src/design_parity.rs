//! Development-only native WKWebView fixture navigation. No provider or Run starts.
use tauri::{
    menu::{MenuItemBuilder, Submenu, SubmenuBuilder},
    Manager,
};

pub(crate) fn enabled() -> bool {
    cfg!(feature = "design-parity")
}

/// The capture matrix the browser scripts use — one file, read by both sides.
const MATRIX: &str = include_str!("../../preview/design-feedback/matrix.json");

#[derive(serde::Deserialize)]
struct Entry {
    id: String,
    label: String,
}
#[derive(serde::Deserialize)]
struct Viewport {
    width: u32,
    height: u32,
}
#[derive(serde::Deserialize)]
struct Matrix {
    scenarios: Vec<Entry>,
    themes: Vec<Entry>,
    viewports: Vec<Viewport>,
}

fn matrix() -> Matrix {
    serde_json::from_str(MATRIX).expect("valid design-feedback matrix.json")
}

/// Menu ids and labels: the reviewer, then every scenario, theme and size.
fn items() -> Vec<(String, String)> {
    let m = matrix();
    let mut items = vec![("review".to_string(), "Open visual reviewer".to_string())];
    items.extend(
        m.scenarios
            .into_iter()
            .map(|e| (format!("scenario:{}", e.id), e.label)),
    );
    items.extend(
        m.themes
            .into_iter()
            .map(|e| (format!("theme:{}", e.id), e.label)),
    );
    items.extend(m.viewports.into_iter().map(|v| {
        (
            format!("size:{}x{}", v.width, v.height),
            format!("Content {} × {}", v.width, v.height),
        )
    }));
    items
}

pub(crate) fn menu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let mut menu = SubmenuBuilder::new(app, "Design parity");
    for (id, label) in items() {
        menu =
            menu.item(&MenuItemBuilder::with_id(format!("design-parity:{id}"), label).build(app)?);
    }
    menu.build()
}

pub(crate) fn handle(app: &tauri::AppHandle, id: &str) -> bool {
    let Some(action) = id.strip_prefix("design-parity:") else {
        return false;
    };
    let result = (|| -> Result<(), String> {
        let window = app.get_webview_window("main").ok_or("No parity window")?;
        if action == "review" {
            let url = tauri::Url::parse("http://127.0.0.1:1465/preview/design-agent.html")
                .map_err(|e| e.to_string())?;
            window.navigate(url).map_err(|e| e.to_string())?;
            return Ok(());
        }
        if let Some(size) = action.strip_prefix("size:") {
            let viewport = matrix()
                .viewports
                .into_iter()
                .find(|v| format!("{}x{}", v.width, v.height) == size)
                .ok_or("Unknown parity size")?;
            window
                .set_size(tauri::LogicalSize::new(
                    viewport.width as f64,
                    viewport.height as f64,
                ))
                .map_err(|e| e.to_string())?;
            let _ = window.center();
            eprintln!("KLIDE_DESIGN_PARITY_SIZE {size}");
            return Ok(());
        }
        let (key, value) = action.split_once(':').ok_or("Invalid parity action")?;
        let mut url = window.url().map_err(|e| e.to_string())?;
        if url.path() == "/preview/design-agent.html" {
            url = tauri::Url::parse("http://127.0.0.1:1465/preview/design-feedback.html?desktop=1&scenario=tools-and-review&theme=klide-light").map_err(|e|e.to_string())?;
        }
        if url.host_str() != Some("127.0.0.1") || url.path() != "/preview/design-feedback.html" {
            return Err("Parity navigation requires the loopback fixture page".into());
        }
        let mut pairs: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| k != key)
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        pairs.push((key.into(), value.into()));
        url.query_pairs_mut().clear().extend_pairs(pairs);
        window.navigate(url).map_err(|e| e.to_string())?;
        eprintln!("KLIDE_DESIGN_PARITY_NAV {key}={value}");
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("KLIDE_DESIGN_PARITY_ERROR {error}");
    }
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_menu_lists_every_scenario_theme_and_size_in_the_matrix() {
        let m = super::matrix();
        let ids: Vec<String> = super::items().into_iter().map(|(id, _)| id).collect();
        assert_eq!(
            ids.len(),
            1 + m.scenarios.len() + m.themes.len() + m.viewports.len()
        );
        assert!(ids.contains(&"scenario:result-and-diff".to_string()));
        assert!(ids.contains(&"size:900x700".to_string()));
    }
}
