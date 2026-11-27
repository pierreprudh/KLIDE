// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(
    all(not(debug_assertions), not(feature = "remote-host")),
    windows_subsystem = "windows"
)]

fn main() {
    #[cfg(debug_assertions)]
    if std::env::args().nth(1).as_deref() == Some("design-pilot-run") {
        klide_lib::design_pilot_main();
        return;
    }
    // `klide run "<task>"` — Klide's own agent from a terminal or CI, no
    // window (agent/cli_run.rs, docs/KLIDE_RUN.md).
    if std::env::args().nth(1).as_deref() == Some("run") {
        klide_lib::cli_run_main();
    }
    // `klide mcp coordination` serves the embedded MCP server over stdio for a
    // Delegate CLI Klide launched (mcp_server.rs). Same binary as the GUI and
    // the ptyd daemon below. Every platform: an MCP child has no PTY.
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) == Some("mcp") {
            match args.get(1).map(String::as_str) {
                Some("coordination") => klide_lib::mcp_server::serve_main(),
                Some(klide_lib::connector_relay::SUBCOMMAND) => klide_lib::mcp_server::serve_connectors_main(),
                _ => {
                    eprintln!("usage: klide mcp coordination | klide mcp connectors");
                    std::process::exit(2);
                }
            }
        }
    }
    // `klide ptyd --data-dir <dir>` runs the headless delegate session host
    // instead of the GUI (docs/delegate-session-replay.md, Slice 3). Same
    // binary, so there is nothing extra to bundle, sign, or version-skew.
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if matches!(args.first().map(String::as_str), Some("ptyd" | "scheduled")) {
            if args[0] == "ptyd" && args.get(1).map(String::as_str) == Some("openrouter-status") {
                match klide_lib::machine_inference::configured_key() {
                    Ok(Some(_)) => println!("ready"),
                    Ok(None) => println!("missing"),
                    Err(error) => { eprintln!("{error}"); std::process::exit(1); }
                }
                return;
            }
            if args[0] == "ptyd" && args.get(1).map(String::as_str) == Some("capabilities") {
                println!("{}", klide_lib::machine_inference::CAPABILITY);
                return;
            }
            if args[0] == "ptyd" && args.get(1).map(String::as_str) == Some("version") {
                println!(
                    "{} {} {}",
                    env!("CARGO_PKG_VERSION"),
                    klide_lib::pty_daemon::protocol_version(),
                    env!("KLIDE_HOST_SOURCE")
                );
                return;
            }
            if args[0] == "ptyd"
                && matches!(
                    args.get(1).map(String::as_str),
                    Some("connect" | "ping" | "ensure" | "prepare-upgrade" | "install")
                )
            {
                let option = |name: &str| {
                    args.iter()
                        .position(|a| a == name)
                        .and_then(|i| args.get(i + 1))
                        .map(String::as_str)
                };
                let code = match (args[1].as_str(), option("--data-dir")) {
                    ("install", Some(dir))
                        if option("--expected").is_some() && option("--destination").is_some() =>
                    {
                        klide_lib::machine_install::install_main(
                            std::path::Path::new(option("--destination").unwrap()),
                            std::path::Path::new(dir),
                            option("--expected").unwrap(),
                        )
                    }
                    ("ensure", Some(dir)) => {
                        klide_lib::pty_daemon::ensure_main(std::path::Path::new(dir))
                    }
                    ("prepare-upgrade", Some(dir)) => {
                        klide_lib::pty_daemon::prepare_upgrade_main(std::path::Path::new(dir))
                    }
                    ("connect", Some(dir)) => klide_lib::pty_daemon::connect_main(
                        std::path::Path::new(dir),
                        args.iter().any(|a| a == "--ensure"),
                    ),
                    ("ping", Some(dir))
                        if option("--ssh").is_some() && option("--binary").is_some() =>
                    {
                        klide_lib::pty_daemon::ping_remote_main(
                            option("--ssh").unwrap(),
                            option("--binary").unwrap(),
                            dir,
                        )
                    }
                    _ => {
                        eprintln!("usage: klide ptyd connect --data-dir <dir>\n       klide ptyd ping --ssh <host> --binary <remote-path> --data-dir <remote-dir>");
                        2
                    }
                };
                std::process::exit(code);
            }
            let data_dir = args
                .iter()
                .position(|a| a == "--data-dir")
                .and_then(|i| args.get(i + 1))
                .map(std::path::PathBuf::from);
            match data_dir {
                Some(dir) if args[0] == "scheduled" => klide_lib::pty_daemon::scheduled_main(dir),
                Some(dir) => klide_lib::pty_daemon::daemon_main(dir),
                None => {
                    eprintln!("usage: klide {} --data-dir <dir>", args[0]);
                    std::process::exit(2);
                }
            }
        }
    }
    klide_lib::run()
}
