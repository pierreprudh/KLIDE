fn main() {
    // The parity file holds only overrides. TAURI_CONFIG is the same merge
    // patch the Tauri CLI's `--config` sets: tauri-build and the
    // generate_context! macro both apply it on top of tauri.conf.json, so the
    // version, plugins and bundle settings still come from the app config.
    if std::env::var_os("CARGO_FEATURE_DESIGN_PARITY").is_some() {
        let config =
            std::fs::read_to_string("tauri.design-parity.conf.json").expect("design parity config");
        let compact: serde_json::Value = serde_json::from_str(&config).expect("valid parity JSON");
        let compact = compact.to_string();
        std::env::set_var("TAURI_CONFIG", &compact);
        println!("cargo:rustc-env=TAURI_CONFIG={compact}");
        println!("cargo:rerun-if-changed=tauri.design-parity.conf.json");
    }
    tauri_build::build()
}
