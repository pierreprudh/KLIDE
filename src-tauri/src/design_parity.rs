//! Development-only native WKWebView fixture navigation. No provider or Run starts.
use tauri::{
    menu::{MenuItemBuilder, Submenu, SubmenuBuilder},
    Manager,
};

pub(crate) fn enabled() -> bool {
    cfg!(feature = "design-parity")
}

pub(crate) fn menu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let mut menu = SubmenuBuilder::new(app, "Design parity");
    for (id, label) in [
        ("review", "Open visual reviewer"),
        ("scenario:conversation-long", "Long conversation"),
        ("scenario:compose-empty", "Empty composer"),
        ("scenario:tools-and-review", "Tools and review"),
        ("scenario:waiting-and-error", "Questions and recovery"),
        ("scenario:subagent-activity", "Child activity"),
        ("scenario:composer-menu", "Model menu"),
        ("theme:klide-light", "Light theme"),
        ("theme:sage-garden-dark", "Dark theme"),
        ("size:1440x900", "Content 1440 × 900"),
        ("size:900x700", "Content 900 × 700"),
    ] {
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
            let (width, height) = match size {
                "1440x900" => (1440.0, 900.0),
                "900x700" => (900.0, 700.0),
                _ => return Err("Unknown parity size".into()),
            };
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
