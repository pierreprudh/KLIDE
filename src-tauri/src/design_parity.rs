//! Development-only native WKWebView fixture navigation. No provider or Run starts.
use tauri::{
    menu::{MenuItemBuilder, Submenu, SubmenuBuilder},
    Manager,
};

pub(crate) fn enabled() -> bool {
    cfg!(feature = "design-parity")
}

/// The scenario / theme / size lists the browser capture uses too — one file,
/// so the native menu can't fall behind the fixtures.
const CATALOG: &str = include_str!("../../preview/design-feedback/catalog.json");

#[derive(serde::Deserialize)]
struct Catalog {
    scenarios: Vec<Entry>,
    themes: Vec<Entry>,
    viewports: Vec<Viewport>,
}
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

fn catalog() -> Catalog {
    serde_json::from_str(CATALOG).expect("valid design-feedback catalog")
}

fn menu_items() -> Vec<(String, String)> {
    let c = catalog();
    let mut items = vec![("review".to_string(), "Open visual reviewer".to_string())];
    items.extend(
        c.scenarios
            .into_iter()
            .map(|s| (format!("scenario:{}", s.id), s.label)),
    );
    items.extend(
        c.themes
            .into_iter()
            .map(|t| (format!("theme:{}", t.id), t.label)),
    );
    items.extend(c.viewports.into_iter().map(|v| {
        (
            format!("size:{}x{}", v.width, v.height),
            format!("Content {} × {}", v.width, v.height),
        )
    }));
    items
}

pub(crate) fn menu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let mut menu = SubmenuBuilder::new(app, "Design parity");
    for (id, label) in menu_items() {
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
            let viewport = catalog()
                .viewports
                .into_iter()
                .find(|v| format!("{}x{}", v.width, v.height) == size)
                .ok_or("Unknown parity size")?;
            let (width, height) = (f64::from(viewport.width), f64::from(viewport.height));
            window
                .set_size(tauri::LogicalSize::new(width, height))
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
    use super::*;

    #[test]
    fn menu_covers_every_catalog_entry() {
        let items = menu_items();
        let c = catalog();
        assert_eq!(
            items.len(),
            1 + c.scenarios.len() + c.themes.len() + c.viewports.len()
        );
        assert!(items.iter().any(|(id, _)| id == "scenario:result-and-diff"));
        assert!(items.iter().any(|(id, _)| id == "size:900x700"));
    }

    /// The parity file is a patch, not a replacement: the app's version,
    /// deep-link plugin and bundle survive, the identifier and window change.
    #[cfg(feature = "design-parity")]
    #[test]
    fn parity_config_merges_over_the_app_config() {
        let base: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let context = crate::app_context();
        let config = context.config();
        assert_eq!(config.identifier, "com.pierre.klide.design-parity");
        assert_eq!(config.version.as_deref(), base["version"].as_str());
        assert!(config.plugins.0.contains_key("deep-link"));
        assert!(config.bundle.active);
        assert_eq!(config.app.windows[0].width, 1440.0);
    }
}
