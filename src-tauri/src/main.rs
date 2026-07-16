// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `klide ptyd --data-dir <dir>` runs the headless delegate session host
    // instead of the GUI (docs/delegate-session-replay.md, Slice 3). Same
    // binary, so there is nothing extra to bundle, sign, or version-skew.
    #[cfg(unix)]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) == Some("ptyd") {
            let data_dir = args
                .iter()
                .position(|a| a == "--data-dir")
                .and_then(|i| args.get(i + 1))
                .map(std::path::PathBuf::from);
            match data_dir {
                Some(dir) => klide_lib::pty_daemon::daemon_main(dir),
                None => {
                    eprintln!("usage: klide ptyd --data-dir <dir>");
                    std::process::exit(2);
                }
            }
        }
    }
    klide_lib::run()
}
