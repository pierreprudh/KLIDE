fn main() {
    // The SSH helper's identity: the trees it is built from, not the commit,
    // so a frontend or docs merge reuses the last published helper.
    println!("cargo:rerun-if-env-changed=KLIDE_HOST_SOURCE");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");
    println!("cargo:rerun-if-changed=../scripts/remote-host/source-paths");
    let source = std::env::var("KLIDE_HOST_SOURCE")
        .ok()
        .or_else(host_source)
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=KLIDE_HOST_SOURCE={source}");
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

/// `git ls-tree HEAD -- <source-paths> | git hash-object --stdin`, the same
/// command `linux-host.yml` names its release with. Uncommitted edits are not
/// part of it, exactly as a commit id never was.
fn host_source() -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let list = std::fs::read_to_string("../scripts/remote-host/source-paths").ok()?;
    let paths: Vec<&str> = list
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    let tree = Command::new("git").args(["-C", "..", "ls-tree", "HEAD", "--"]).args(&paths).output().ok()?;
    if !tree.status.success() || tree.stdout.is_empty() {
        return None;
    }
    let mut hash = Command::new("git")
        .args(["hash-object", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    hash.stdin.take()?.write_all(&tree.stdout).ok()?;
    let out = hash.wait_with_output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
