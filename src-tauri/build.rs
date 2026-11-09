fn main() {
    // tauri-codegen resolves the directory's standard config filename, even
    // when generate_context! is passed another filename. TAURI_CONFIG is the
    // CLI's own `--config` channel: a JSON merge patch over tauri.conf.json,
    // read by both tauri-build and the proc macro. The parity file holds only
    // overrides.
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
