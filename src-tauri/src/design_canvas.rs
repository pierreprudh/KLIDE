//! Design mode's canvas: a loopback proxy in front of a project's own dev
//! server that adds one script — the element picker — to its HTML pages.
//!
//! The canvas is an iframe, and the page in it belongs to another origin
//! (`http://localhost:5173` is not Klide), so Klide cannot read its DOM. The
//! proxy is the smallest way across: every request is forwarded unchanged to
//! the dev server, except that an HTML document gets
//! `<script src="/__klide_design/agent.js">` and loses the headers that would
//! forbid framing it. The script talks to Klide by `postMessage`, carrying a
//! per-canvas token. WebSocket upgrades (the dev server's hot reload) are
//! piped through untouched, so edits still appear live.
//!
//! Only loopback upstreams are accepted — this never proxies the internet —
//! and the listener binds 127.0.0.1 on a free port. Plain HTTP/1.1 only:
//! development servers do not need more.

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const AGENT: &str = include_str!("design_agent.js");
const AGENT_PATH: &str = "/__klide_design/agent.js";
const MAX_HEAD: usize = 64 * 1024;
const MAX_HTML: usize = 16 * 1024 * 1024;

/// Ports dev servers usually take, probed when Design mode opens.
const COMMON_PORTS: &[u16] = &[5173, 5174, 3000, 3001, 1420, 4321, 4200, 8080, 8000, 5000];

#[derive(Clone, Debug, PartialEq, Eq)]
struct Upstream {
    addr: SocketAddr,
    /// What the dev server expects in `Host` — `localhost:5173`, not our port.
    host: String,
}

struct Canvas {
    upstream: Upstream,
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
}

static CANVAS: Mutex<Option<Canvas>> = Mutex::new(None);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasInfo {
    /// The page to load in the iframe, through the proxy.
    url: String,
    /// Carried by every message the injected script posts.
    token: String,
    /// The proxy's origin — messages from anywhere else are ignored.
    origin: String,
}

/// Parse `http://localhost:5173/path?q` into the upstream and the path. Only
/// loopback hosts are accepted.
fn parse_url(url: &str) -> Result<(Upstream, String), String> {
    let rest = url
        .trim()
        .strip_prefix("http://")
        .ok_or("Design mode opens http:// dev servers only")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => {
            (h, p.parse::<u16>().map_err(|_| format!("Not a port: {p}"))?)
        }
        _ => (authority, 80),
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if !matches!(bare, "localhost" | "127.0.0.1" | "::1") {
        return Err("Design mode only opens servers on this machine (localhost)".into());
    }
    let addr = (
        if bare == "localhost" {
            "127.0.0.1"
        } else {
            bare
        },
        port,
    )
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("Unresolvable address")?;
    Ok((
        Upstream {
            addr,
            host: authority.to_string(),
        },
        path,
    ))
}

fn token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("system randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn start(upstream: Upstream) -> Result<Canvas, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = token();
    let stop = Arc::new(AtomicBool::new(false));
    let (up, tok, halt) = (upstream.clone(), token.clone(), stop.clone());
    std::thread::Builder::new()
        .name("design-canvas".into())
        .spawn(move || {
            for conn in listener.incoming() {
                if halt.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(client) = conn else { continue };
                let (up, tok) = (up.clone(), tok.clone());
                let _ = std::thread::Builder::new()
                    .name("design-canvas-conn".into())
                    .spawn(move || {
                        let _ = serve(client, &up, &tok);
                    });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Canvas {
        upstream,
        port,
        token,
        stop,
    })
}

fn stop_canvas(canvas: Canvas) {
    canvas.stop.store(true, Ordering::SeqCst);
    // Wake the accept loop so it sees the flag.
    let _ = TcpStream::connect(("127.0.0.1", canvas.port));
}

/// Open (or reuse) the canvas for `url`; returns the proxied page address.
pub fn open(url: &str) -> Result<CanvasInfo, String> {
    let (upstream, path) = parse_url(url)?;
    TcpStream::connect_timeout(&upstream.addr, Duration::from_millis(800))
        .map_err(|_| format!("Nothing is answering at {url} — is the dev server running?"))?;
    let mut slot = CANVAS.lock().map_err(|_| "canvas lock poisoned")?;
    if slot.as_ref().map(|c| &c.upstream) != Some(&upstream) {
        if let Some(old) = slot.take() {
            stop_canvas(old);
        }
        *slot = Some(start(upstream)?);
    }
    let c = slot.as_ref().expect("canvas just set");
    let origin = format!("http://127.0.0.1:{}", c.port);
    Ok(CanvasInfo {
        url: format!("{origin}{path}"),
        token: c.token.clone(),
        origin,
    })
}

pub fn close() {
    if let Ok(mut slot) = CANVAS.lock() {
        if let Some(old) = slot.take() {
            stop_canvas(old);
        }
    }
}

/// Common dev-server ports that accept a connection right now.
pub fn candidates() -> Vec<String> {
    COMMON_PORTS
        .iter()
        .filter(|p| {
            TcpStream::connect_timeout(
                &SocketAddr::from(([127, 0, 0, 1], **p)),
                Duration::from_millis(120),
            )
            .is_ok()
        })
        .map(|p| format!("http://localhost:{p}/"))
        .collect()
}

// ── HTTP ────────────────────────────────────────────────────────────────────

struct Head {
    first: String,
    headers: Vec<(String, String)>,
}

impl Head {
    fn get(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    fn without(mut self, names: &[&str]) -> Self {
        self.headers
            .retain(|(k, _)| !names.iter().any(|n| k.eq_ignore_ascii_case(n)));
        self
    }
    fn with(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
    fn bytes(&self) -> Vec<u8> {
        let mut out = format!("{}\r\n", self.first);
        for (k, v) in &self.headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str("\r\n");
        out.into_bytes()
    }
}

/// Read up to the blank line. Returns the parsed head and any body bytes that
/// arrived in the same reads.
fn read_head(stream: &mut TcpStream) -> io::Result<(Head, Vec<u8>)> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let text = String::from_utf8_lossy(&buf[..end]).to_string();
            let mut lines = text.split("\r\n");
            let first = lines.next().unwrap_or_default().to_string();
            let headers = lines
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                .collect();
            return Ok((Head { first, headers }, buf[end + 4..].to_vec()));
        }
        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "header too large",
            ));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn respond(client: &mut TcpStream, status: &str, kind: &str, body: &[u8]) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    client.write_all(head.as_bytes())?;
    client.write_all(body)
}

fn pipe(mut from: TcpStream, mut to: TcpStream) {
    let _ = io::copy(&mut from, &mut to);
    let _ = to.shutdown(Shutdown::Write);
}

fn serve(mut client: TcpStream, up: &Upstream, token: &str) -> io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(30)))?;
    let (req, early) = read_head(&mut client)?;
    let target = req.first.split(' ').nth(1).unwrap_or("/").to_string();
    if target.split('?').next() == Some(AGENT_PATH) {
        let script = AGENT.replace("__KLIDE_TOKEN__", token);
        return respond(
            &mut client,
            "200 OK",
            "text/javascript; charset=utf-8",
            script.as_bytes(),
        );
    }
    let upgrade = req.get("upgrade").is_some();
    let mut server = TcpStream::connect_timeout(&up.addr, Duration::from_secs(5))?;
    let req = req
        .without(&[
            "host",
            "accept-encoding",
            "connection",
            "keep-alive",
            "proxy-connection",
        ])
        .with("Host", &up.host)
        .with("Accept-Encoding", "identity")
        .with("Connection", if upgrade { "Upgrade" } else { "close" });
    server.write_all(&req.bytes())?;
    server.write_all(&early)?;

    if upgrade {
        // Hot reload: from here on it is the dev server's own protocol.
        client.set_read_timeout(None)?;
        let (c2, s2) = (client.try_clone()?, server.try_clone()?);
        std::thread::spawn(move || pipe(c2, s2));
        pipe(server, client);
        return Ok(());
    }

    // Request body: dev traffic is mostly GET; forward a declared length.
    let declared: usize = req
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if declared > early.len() {
        let mut body = (&mut client).take((declared - early.len()) as u64);
        io::copy(&mut body, &mut server)?;
    }

    server.set_read_timeout(Some(Duration::from_secs(60)))?;
    let (res, start) = read_head(&mut server)?;
    let html = res
        .get("content-type")
        .is_some_and(|t| t.to_ascii_lowercase().starts_with("text/html"));
    let ok = res.first.split(' ').nth(1) == Some("200");
    if !(html && ok) {
        let res = res
            .without(&["connection", "keep-alive"])
            .with("Connection", "close");
        client.write_all(&res.bytes())?;
        client.write_all(&start)?;
        io::copy(&mut server, &mut client)?;
        return Ok(());
    }
    // An HTML page: we asked for `Connection: close`, so the body ends at EOF.
    let mut body = start;
    (&mut server).take(MAX_HTML as u64).read_to_end(&mut body)?;
    if res
        .get("transfer-encoding")
        .is_some_and(|t| t.eq_ignore_ascii_case("chunked"))
    {
        body = dechunk(&body);
    }
    let body = inject(&body);
    let res = res
        .without(&[
            "content-length",
            "transfer-encoding",
            "content-encoding",
            "connection",
            "keep-alive",
            "content-security-policy",
            "x-frame-options",
            "etag",
        ])
        .with("Content-Length", &body.len().to_string())
        .with("Cache-Control", "no-store")
        .with("Connection", "close");
    client.write_all(&res.bytes())?;
    client.write_all(&body)
}

fn dechunk(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while let Some(eol) = raw[i..].windows(2).position(|w| w == b"\r\n") {
        let size_line = String::from_utf8_lossy(&raw[i..i + eol]).to_string();
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("0").trim(), 16)
            .unwrap_or(0);
        i += eol + 2;
        if size == 0 || i + size > raw.len() {
            break;
        }
        out.extend_from_slice(&raw[i..i + size]);
        i += size + 2;
    }
    out
}

/// Put the picker script first in `<head>`, or first in the document.
fn inject(html: &[u8]) -> Vec<u8> {
    let tag = format!("<script src=\"{AGENT_PATH}\"></script>");
    let lower = html.to_ascii_lowercase();
    let at = lower
        .windows(5)
        .position(|w| w == b"<head")
        .and_then(|h| {
            lower[h..]
                .iter()
                .position(|b| *b == b'>')
                .map(|g| h + g + 1)
        })
        .unwrap_or(0);
    let mut out = Vec::with_capacity(html.len() + tag.len());
    out.extend_from_slice(&html[..at]);
    out.extend_from_slice(tag.as_bytes());
    out.extend_from_slice(&html[at..]);
    out
}

// ── the project's dev server, started from Design mode ──────────────────────
//
// "Run" in an empty canvas starts the project's own dev script (the renderer
// reads package.json and sends the exact command it shows the user). It runs
// in the user's login shell — a Finder-launched app has a minimal PATH, and
// node often comes from nvm in the shell's rc — in its own process group, so
// Stop and app exit take the whole tree down. Output is kept as a short tail
// and scanned for the first local address the server prints.

struct DevServer {
    child: std::process::Child,
    command: String,
    tail: Arc<Mutex<String>>,
    url: Arc<Mutex<Option<String>>>,
}

static DEV: Mutex<Option<DevServer>> = Mutex::new(None);
const TAIL: usize = 8 * 1024;

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevStatus {
    running: bool,
    command: Option<String>,
    /// The first local address the server printed.
    url: Option<String>,
    /// The end of its output, ANSI codes removed.
    tail: String,
    exit_code: Option<i32>,
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The first `http://localhost:PORT/...` or `http://127.0.0.1:PORT/...` in a line.
fn local_url(line: &str) -> Option<String> {
    for host in ["http://localhost:", "http://127.0.0.1:", "http://[::1]:"] {
        if let Some(at) = line.find(host) {
            let rest = &line[at..];
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')')
                .unwrap_or(rest.len());
            let url = rest[..end].trim_end_matches(['.', ',']);
            if url.len() > host.len() && url[host.len()..].starts_with(|c: char| c.is_ascii_digit())
            {
                return Some(url.to_string());
            }
        }
    }
    None
}

fn kill_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn run_dev(workspace: &str, command: &str) -> Result<(), String> {
    let dir = std::path::Path::new(workspace);
    if !dir.is_dir() {
        return Err("The project folder is not available".into());
    }
    let command = command.trim();
    if command.is_empty() || command.len() > 300 || command.contains('\n') {
        return Err("Not a dev command".into());
    }
    stop_dev();
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = std::process::Command::new(&shell);
    cmd.args(["-l", "-i", "-c", command])
        .current_dir(dir)
        .env("FORCE_COLOR", "0")
        .env("BROWSER", "none") // don't open a browser tab; the canvas is the browser
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start {command}: {e}"))?;
    let tail = Arc::new(Mutex::new(String::new()));
    let url = Arc::new(Mutex::new(None));
    for stream in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let (tail, url) = (tail.clone(), url.clone());
        std::thread::spawn(move || {
            let mut reader = io::BufReader::new(stream);
            let mut line = String::new();
            while io::BufRead::read_line(&mut reader, &mut line)
                .map(|n| n > 0)
                .unwrap_or(false)
            {
                let clean = strip_ansi(&line);
                if let Ok(mut u) = url.lock() {
                    if u.is_none() {
                        *u = local_url(&clean);
                    }
                }
                if let Ok(mut t) = tail.lock() {
                    t.push_str(&clean);
                    if t.len() > TAIL {
                        let cut = t.len() - TAIL;
                        let cut = (cut..t.len())
                            .find(|i| t.is_char_boundary(*i))
                            .unwrap_or(t.len());
                        t.drain(..cut);
                    }
                }
                line.clear();
            }
        });
    }
    *DEV.lock().map_err(|_| "dev lock poisoned")? = Some(DevServer {
        child,
        command: command.to_string(),
        tail,
        url,
    });
    Ok(())
}

pub fn dev_status() -> DevStatus {
    let Ok(mut slot) = DEV.lock() else {
        return DevStatus::default();
    };
    let Some(dev) = slot.as_mut() else {
        return DevStatus::default();
    };
    let exit = dev.child.try_wait().ok().flatten();
    DevStatus {
        running: exit.is_none(),
        command: Some(dev.command.clone()),
        url: dev.url.lock().ok().and_then(|u| u.clone()),
        tail: dev.tail.lock().map(|t| t.clone()).unwrap_or_default(),
        exit_code: exit.and_then(|s| s.code()),
    }
}

/// Stop the server Design mode started, if any. Called on Stop, when Design
/// mode goes away, and at app exit.
pub fn stop_dev() {
    let taken = DEV.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut dev) = taken {
        kill_group(&mut dev.child);
    }
}

// ── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn design_canvas_open(url: String) -> Result<CanvasInfo, String> {
    crate::blocking::run(move || open(&url)).await
}

#[tauri::command]
pub async fn design_canvas_close() -> Result<(), String> {
    crate::blocking::run(|| {
        close();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn design_canvas_candidates() -> Result<Vec<String>, String> {
    crate::blocking::run(|| Ok(candidates())).await
}

#[tauri::command]
pub async fn design_dev_run(workspace: String, command: String) -> Result<(), String> {
    crate::blocking::run(move || run_dev(&workspace, &command)).await
}

#[tauri::command]
pub async fn design_dev_status() -> Result<DevStatus, String> {
    crate::blocking::run(|| Ok(dev_status())).await
}

#[tauri::command]
pub async fn design_dev_stop() -> Result<(), String> {
    crate::blocking::run(|| {
        stop_dev();
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_servers_are_proxied() {
        assert!(parse_url("http://localhost:5173/").is_ok());
        assert_eq!(
            parse_url("http://127.0.0.1:3000/app?x=1").unwrap().1,
            "/app?x=1"
        );
        assert_eq!(parse_url("http://localhost:5173").unwrap().1, "/");
        assert!(parse_url("http://example.com:80/").is_err());
        assert!(parse_url("https://localhost:5173/").is_err());
        assert!(parse_url("http://192.168.1.4:5173/").is_err());
    }

    #[test]
    fn the_script_goes_first_in_head() {
        let out = String::from_utf8(inject(
            b"<!doctype html><html><HEAD lang=x><title>t</title></HEAD></html>",
        ))
        .unwrap();
        assert!(
            out.contains("<HEAD lang=x><script src=\"/__klide_design/agent.js\"></script><title>")
        );
        let bare = String::from_utf8(inject(b"<p>hi</p>")).unwrap();
        assert!(bare.starts_with("<script"));
    }

    #[test]
    fn chunked_bodies_are_reassembled() {
        assert_eq!(
            dechunk(b"5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n"),
            b"hello world"
        );
    }

    #[test]
    fn a_page_is_proxied_with_the_picker_and_without_frame_blocks() {
        // A one-shot "dev server".
        let dev = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = dev.local_addr().unwrap().port();
        std::thread::spawn(move || {
            // The first connection is open()'s reachability probe, which says nothing.
            for conn in dev.incoming().take(3) {
                let mut s = conn.unwrap();
                let Ok((head, _)) = read_head(&mut s) else {
                    continue;
                };
                assert_eq!(head.get("host"), Some(format!("localhost:{port}").as_str()));
                assert_eq!(head.get("accept-encoding"), Some("identity"));
                let body = if head.first.contains("/app.js") {
                    "console.log(1)"
                } else {
                    "<html><head></head><body>ok</body></html>"
                };
                let kind = if head.first.contains("/app.js") {
                    "text/javascript"
                } else {
                    "text/html"
                };
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nX-Frame-Options: DENY\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len());
            }
        });
        let info = open(&format!("http://localhost:{port}/page")).unwrap();
        let get = |path: &str| {
            let mut s = TcpStream::connect(info.origin.trim_start_matches("http://")).unwrap();
            write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        };
        let page = get("/page");
        assert!(
            page.contains("<head><script src=\"/__klide_design/agent.js\"></script></head>"),
            "{page}"
        );
        assert!(!page.to_ascii_lowercase().contains("x-frame-options"));
        let script = get(AGENT_PATH);
        assert!(script.contains(&info.token) && !script.contains("__KLIDE_TOKEN__"));
        let js = get("/app.js");
        assert!(js.contains("console.log(1)") && !js.contains("agent.js"));
        close();
    }

    #[test]
    fn the_address_a_dev_server_prints_is_found() {
        assert_eq!(
            local_url("  ➜  Local:   http://localhost:5173/"),
            Some("http://localhost:5173/".into())
        );
        assert_eq!(
            local_url("ready - started server on http://127.0.0.1:3000, url"),
            Some("http://127.0.0.1:3000".into())
        );
        assert_eq!(
            local_url(&strip_ansi(
                "\u{1b}[32mLocal:\u{1b}[39m http://localhost:\u{1b}[1m4321\u{1b}[22m/"
            )),
            Some("http://localhost:4321/".into())
        );
        assert_eq!(local_url("see http://localhost: for docs"), None);
        assert_eq!(local_url("Network: http://192.168.1.4:5173/"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_started_server_reports_its_address_and_stops_with_its_children() {
        let dir = std::env::temp_dir();
        run_dev(
            dir.to_str().unwrap(),
            "echo 'Local: http://localhost:59999/'; sleep 30 & wait",
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while dev_status().url.is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let status = dev_status();
        assert!(status.running, "{}", status.tail);
        assert_eq!(status.url.as_deref(), Some("http://localhost:59999/"));
        stop_dev();
        assert!(!dev_status().running);
    }
}
