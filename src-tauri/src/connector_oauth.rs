//! Sign-in for remote connectors — the MCP authorization flow.
//!
//! Most hosted MCP servers (Notion, Linear, Atlassian, Sentry, Canva, …) take
//! no API key: they expect the client to sign the person in through their
//! browser, the way Claude does. This module is that flow, per the MCP
//! authorization spec (OAuth 2.1 + PKCE):
//!
//! 1. **Find the authorization server.** An unauthenticated `initialize` is
//!    answered `401` with `WWW-Authenticate: Bearer resource_metadata="…"`;
//!    that document (RFC 9728) names the authorization server. Servers written
//!    to the earlier revision skip it, so the well-known paths and finally the
//!    server's own origin are tried in turn.
//! 2. **Read its metadata** (RFC 8414 / OpenID discovery) for the authorize,
//!    token and registration endpoints.
//! 3. **Register Klide** as a public client (RFC 7591), with a loopback
//!    redirect on a port picked for this sign-in (RFC 8252).
//! 4. **Open the browser** on the authorize URL — PKCE S256, a random `state`,
//!    the `resource` indicator — and wait on the loopback listener for the
//!    redirect.
//! 5. **Exchange the code** for tokens and keep them in the macOS Keychain,
//!    keyed by the server's URL, never in `connectors.json`.
//!
//! A connector that signs in this way carries `Authorization: Bearer
//! ${KLIDE_OAUTH}`; `connectors::resolve` swaps the reference for
//! [`access_token`], which refreshes a token that is about to expire. Nothing
//! here ever reaches the webview: the page learns only that sign-in worked.
//!
//! Everything blocks; callers come through `crate::blocking::run`.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The reference a connector's header uses for its signed-in token.
pub const OAUTH_REF: &str = "KLIDE_OAUTH";

/// Its own Keychain service, apart from provider keys (`com.klide.app`).
const KEYCHAIN_SERVICE: &str = "com.klide.app.connectors";

/// How long the browser half may take — reading, maybe a password manager,
/// maybe a two-factor code.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// Every metadata, registration and token request.
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// A token this close to expiry is refreshed before use, so a call never
/// starts with one that dies in flight.
const REFRESH_MARGIN_SECS: u64 = 60;

/// What a sign-in leaves behind for one server.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Grant {
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds. `None` when the server didn't say.
    expires_at: Option<u64>,
    client_id: String,
    client_secret: Option<String>,
    token_endpoint: String,
    resource: String,
}

/// Keychain reads, memoised for the process — each read is what can raise
/// macOS's "allow access" prompt, and `resolve` runs on every connect.
static CACHE: LazyLock<Mutex<HashMap<String, Option<Grant>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Bumped by each new sign-in and by cancel; a wait that sees another number
/// gives up, so only the latest sign-in holds a listener.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// One Keychain account per server: scheme, host, port and path, without a
/// trailing slash or query — `https://mcp.linear.app/mcp`.
fn account(server_url: &str) -> String {
    match reqwest::Url::parse(server_url.trim()) {
        Ok(url) => format!("{}{}", url.origin().ascii_serialization(), url.path().trim_end_matches('/')),
        Err(_) => server_url.trim().trim_end_matches('/').to_string(),
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load(server_url: &str) -> Option<Grant> {
    let key = account(server_url);
    if let Some(hit) = CACHE.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return hit.clone();
    }
    let grant = crate::secrets::get(KEYCHAIN_SERVICE, &key)
        .and_then(|raw| serde_json::from_str::<Grant>(&raw).ok());
    CACHE.lock().unwrap_or_else(|p| p.into_inner()).insert(key, grant.clone());
    grant
}

fn save(server_url: &str, grant: &Grant) -> Result<(), String> {
    let key = account(server_url);
    let raw = serde_json::to_string(grant).map_err(|e| e.to_string())?;
    crate::secrets::set(KEYCHAIN_SERVICE, &key, &raw)
        .map_err(|e| format!("Could not save the sign-in to the Keychain: {e}"))?;
    CACHE.lock().unwrap_or_else(|p| p.into_inner()).insert(key, Some(grant.clone()));
    Ok(())
}

/// Forget a server's sign-in. Forgetting one that was never there is fine.
pub fn sign_out(server_url: &str) {
    let key = account(server_url);
    let _ = crate::secrets::delete(KEYCHAIN_SERVICE, &key);
    CACHE.lock().unwrap_or_else(|p| p.into_inner()).insert(key, None);
}

/// The bearer for `server_url`, refreshed first when it is about to expire.
pub fn access_token(server_url: &str) -> Result<String, String> {
    let host = reqwest::Url::parse(server_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| server_url.to_string());
    let grant = load(server_url)
        .ok_or_else(|| format!("Not signed in to {host}. Sign in from Settings › Connectors."))?;
    let expiring = grant.expires_at.is_some_and(|at| at <= now() + REFRESH_MARGIN_SECS);
    if !expiring {
        return Ok(grant.access_token);
    }
    let Some(refresh) = grant.refresh_token.clone() else {
        return Err(format!("The sign-in to {host} expired. Sign in again from Settings › Connectors."));
    };
    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh.clone()),
        ("client_id", grant.client_id.clone()),
        ("resource", grant.resource.clone()),
    ];
    if let Some(secret) = &grant.client_secret {
        form.push(("client_secret", secret.clone()));
    }
    let answer = post_form(&grant.token_endpoint, &form)
        .map_err(|e| format!("The sign-in to {host} expired and could not be renewed ({e}). Sign in again."))?;
    let next = grant_from(&answer, &grant.client_id, grant.client_secret.clone(), &grant.token_endpoint, &grant.resource, Some(refresh))?;
    save(server_url, &next)?;
    Ok(next.access_token)
}

/// Abandon a sign-in waiting on the browser.
pub fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

/* ---------------------------------------------------------------- sign in --*/

/// Run the whole flow for `server_url`; `open` shows the authorize URL in the
/// person's browser. On success the tokens are in the Keychain.
pub fn sign_in(server_url: &str, open: impl Fn(&str) -> Result<(), String>) -> Result<(), String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let endpoints = discover(server_url)?;

    // The listener first: its port is part of the redirect we register.
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Could not listen for the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");

    let (client_id, client_secret) = register(&endpoints, &redirect)?;

    let verifier = random_token(32);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(16);

    let mut authorize = reqwest::Url::parse(&endpoints.authorization)
        .map_err(|e| format!("The server's sign-in address is not a URL: {e}"))?;
    {
        let mut query = authorize.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", &endpoints.resource);
        if let Some(scope) = &endpoints.scope {
            query.append_pair("scope", scope);
        }
    }
    open(authorize.as_str())?;

    let code = wait_for_code(&listener, &state, generation)?;

    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", client_id.clone()),
        ("code_verifier", verifier),
        ("resource", endpoints.resource.clone()),
    ];
    if let Some(secret) = &client_secret {
        form.push(("client_secret", secret.clone()));
    }
    let answer = post_form(&endpoints.token, &form)?;
    let grant = grant_from(&answer, &client_id, client_secret, &endpoints.token, &endpoints.resource, None)?;
    save(server_url, &grant)
}

/// Where a server's sign-in happens.
#[derive(Debug, PartialEq)]
struct Endpoints {
    authorization: String,
    token: String,
    registration: Option<String>,
    scope: Option<String>,
    /// The resource indicator tokens are bound to — the MCP server itself.
    resource: String,
}

fn discover(server_url: &str) -> Result<Endpoints, String> {
    let server = reqwest::Url::parse(server_url.trim()).map_err(|e| format!("{server_url}: {e}"))?;
    let origin = server.origin().ascii_serialization();
    let path = server.path().trim_end_matches('/').to_string();

    // RFC 9728: the server names its authorization server.
    let mut candidates = Vec::new();
    if let Some(url) = challenge_metadata_url(&server) {
        candidates.push(url);
    }
    candidates.push(format!("{origin}/.well-known/oauth-protected-resource{path}"));
    candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));
    let protected = candidates.iter().find_map(|url| get_json(url).ok());

    let (issuer, resource, scope) = match &protected {
        Some(doc) => (
            doc.get("authorization_servers")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| origin.clone()),
            doc.get("resource").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| server_url.trim().to_string()),
            scopes(doc.get("scopes_supported")),
        ),
        // The 2025-03-26 revision: the server's own origin is its issuer.
        None => (origin.clone(), server_url.trim().to_string(), None),
    };

    let metadata = authorization_metadata(&issuer);
    let issuer_origin = reqwest::Url::parse(&issuer)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|_| origin.clone());
    let field = |key: &str| metadata.as_ref().and_then(|m| m.get(key)).and_then(Value::as_str).map(str::to_string);
    Ok(Endpoints {
        authorization: field("authorization_endpoint").unwrap_or_else(|| format!("{issuer_origin}/authorize")),
        token: field("token_endpoint").unwrap_or_else(|| format!("{issuer_origin}/token")),
        registration: field("registration_endpoint").or_else(|| metadata.is_none().then(|| format!("{issuer_origin}/register"))),
        scope: scope.or_else(|| scopes(metadata.as_ref().and_then(|m| m.get("scopes_supported")))),
        resource,
    })
}

/// `scopes_supported` as the space-separated `scope` an authorize URL takes.
fn scopes(value: Option<&Value>) -> Option<String> {
    let list: Vec<&str> = value?.as_array()?.iter().filter_map(Value::as_str).collect();
    (!list.is_empty()).then(|| list.join(" "))
}

/// Ask the server with no credentials and read the `resource_metadata` its
/// `401` points at.
fn challenge_metadata_url(server: &reqwest::Url) -> Option<String> {
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "Klide", "version": env!("CARGO_PKG_VERSION") } },
    });
    let response = client()
        .ok()?
        .post(server.as_str())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(body.to_string())
        .send()
        .ok()?;
    if response.status().as_u16() != 401 {
        return None;
    }
    let header = response.headers().get("www-authenticate")?.to_str().ok()?;
    challenge_param(header, "resource_metadata")
}

/// One `name="value"` parameter of a `WWW-Authenticate` challenge.
fn challenge_param(header: &str, name: &str) -> Option<String> {
    let at = header.find(&format!("{name}="))? + name.len() + 1;
    let rest = &header[at..];
    let value = match rest.strip_prefix('"') {
        Some(quoted) => &quoted[..quoted.find('"')?],
        None => rest.split([',', ' ']).next()?,
    };
    (!value.is_empty()).then(|| value.to_string())
}

/// RFC 8414 metadata, then OpenID discovery — with the issuer's path inserted
/// after the well-known prefix, and appended, as servers do both.
fn authorization_metadata(issuer: &str) -> Option<Value> {
    let url = reqwest::Url::parse(issuer).ok()?;
    let origin = url.origin().ascii_serialization();
    let path = url.path().trim_end_matches('/');
    let mut candidates = vec![format!("{origin}/.well-known/oauth-authorization-server{path}")];
    candidates.push(format!("{origin}/.well-known/openid-configuration{path}"));
    if !path.is_empty() {
        candidates.push(format!("{origin}{path}/.well-known/openid-configuration"));
        candidates.push(format!("{origin}/.well-known/oauth-authorization-server"));
    }
    candidates
        .iter()
        .find_map(|c| get_json(c).ok().filter(|v| v.get("authorization_endpoint").is_some()))
}

/// RFC 7591: Klide registers itself, as a public client, for this sign-in.
fn register(endpoints: &Endpoints, redirect: &str) -> Result<(String, Option<String>), String> {
    let Some(registration) = &endpoints.registration else {
        return Err("This server doesn't let new apps register, so Klide can't sign in to it on its own yet.".to_string());
    };
    let body = json!({
        "client_name": "Klide",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let response = client()?
        .post(registration)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| format!("Could not register Klide with the server: {e}"))?;
    let status = response.status();
    let answer: Value = response.json().unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("The server refused to register Klide (HTTP {}): {}", status.as_u16(), oauth_error(&answer)));
    }
    let id = answer
        .get("client_id")
        .and_then(Value::as_str)
        .ok_or("The server registered Klide but sent no client id")?;
    Ok((id.to_string(), answer.get("client_secret").and_then(Value::as_str).map(str::to_string)))
}

/// Wait for the browser to come back to the loopback listener with a code.
fn wait_for_code(listener: &TcpListener, state: &str, generation: u64) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Err("Sign-in cancelled".to_string());
        }
        if Instant::now() >= deadline {
            return Err("The sign-in wasn't finished in the browser within five minutes".to_string());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(outcome) = handle_redirect(stream, state) {
                    return outcome;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(format!("The sign-in listener failed: {e}")),
        }
    }
}

/// Read one request. `None` for anything that isn't the callback (a favicon),
/// so the wait goes on.
fn handle_redirect(mut stream: TcpStream, state: &str) -> Option<Result<String, String>> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    let target = line.split_whitespace().nth(1)?.to_string();
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return None;
    }
    let param = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    let outcome = if let Some(error) = param("error") {
        Err(match param("error_description") {
            Some(why) => format!("The sign-in was refused: {why}"),
            None => format!("The sign-in was refused ({error})"),
        })
    } else if param("state").as_deref() != Some(state) {
        Err("The sign-in came back for a different request; try again".to_string())
    } else {
        param("code").ok_or_else(|| "The sign-in came back without a code".to_string())
    };
    let (title, note) = match &outcome {
        Ok(_) => ("Signed in", "You can close this tab and go back to Klide."),
        Err(_) => ("Sign-in didn't finish", "Go back to Klide to see why."),
    };
    let page = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title>\
         <body style=\"font:15px -apple-system,system-ui,sans-serif;background:#F5F6F7;color:#1c1c1c;\
         display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\">\
         <div style=\"font-weight:600;font-size:17px\">{title}</div>\
         <div style=\"margin-top:6px;color:#5f5f5d\">{note}</div></div>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    Some(outcome)
}

/* ------------------------------------------------------------------ wire --*/

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("Klide/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

fn get_json(url: &str) -> Result<Value, String> {
    let response = client()?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response.json().map_err(|e| e.to_string())
}

/// `application/x-www-form-urlencoded`, as a token endpoint requires.
fn post_form(url: &str, form: &[(&str, String)]) -> Result<Value, String> {
    // `Url`'s query serializer is the form encoder; borrow it for the body.
    let mut encoder = reqwest::Url::parse("http://form.invalid/").map_err(|e| e.to_string())?;
    encoder.query_pairs_mut().extend_pairs(form.iter().map(|(k, v)| (*k, v.as_str())));
    let body = encoder.query().unwrap_or_default().to_string();
    let response = client()?
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .map_err(|e| format!("Could not reach the sign-in server: {e}"))?;
    let status = response.status();
    let answer: Value = response.json().unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), oauth_error(&answer)));
    }
    Ok(answer)
}

/// An OAuth error body in words.
fn oauth_error(answer: &Value) -> String {
    answer
        .get("error_description")
        .or_else(|| answer.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("no reason given")
        .to_string()
}

fn grant_from(
    answer: &Value,
    client_id: &str,
    client_secret: Option<String>,
    token_endpoint: &str,
    resource: &str,
    previous_refresh: Option<String>,
) -> Result<Grant, String> {
    let access = answer
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or("The server sent no access token")?;
    Ok(Grant {
        access_token: access.to_string(),
        // A refresh that doesn't rotate the refresh token keeps the old one.
        refresh_token: answer.get("refresh_token").and_then(Value::as_str).map(str::to_string).or(previous_refresh),
        expires_at: answer.get("expires_in").and_then(Value::as_u64).map(|s| now() + s),
        client_id: client_id.to_string(),
        client_secret,
        token_endpoint: token_endpoint.to_string(),
        resource: resource.to_string(),
    })
}

/// URL-safe random text with `bytes` bytes of entropy.
fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random source is available");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_resource_metadata_from_a_challenge() {
        let header = r#"Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="read""#;
        assert_eq!(
            challenge_param(header, "resource_metadata").as_deref(),
            Some("https://mcp.example.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(challenge_param(header, "scope").as_deref(), Some("read"));
        assert_eq!(challenge_param("Bearer realm=x", "resource_metadata"), None);
    }

    #[test]
    fn one_account_per_server_whatever_the_trailing_slash() {
        assert_eq!(account("https://mcp.linear.app/mcp/"), "https://mcp.linear.app/mcp");
        assert_eq!(account("https://mcp.stripe.com"), "https://mcp.stripe.com");
        assert_eq!(account("https://mcp.stripe.com/?x=1"), "https://mcp.stripe.com");
    }

    #[test]
    fn a_refresh_without_a_new_refresh_token_keeps_the_old_one() {
        let answer = json!({ "access_token": "a2", "expires_in": 3600 });
        let grant = grant_from(&answer, "c", None, "https://t", "https://r", Some("r1".into())).unwrap();
        assert_eq!(grant.access_token, "a2");
        assert_eq!(grant.refresh_token.as_deref(), Some("r1"));
        assert!(grant.expires_at.unwrap() > now());
        assert!(grant_from(&json!({}), "c", None, "t", "r", None).is_err());
    }

    #[test]
    fn pkce_material_is_url_safe() {
        let token = random_token(32);
        assert_eq!(token.len(), 43);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    /// Discovery against a live server, when asked: `KLIDE_OAUTH_LIVE=1`.
    #[test]
    fn discovers_a_real_servers_endpoints() {
        // `KLIDE_OAUTH_LIVE=https://a/mcp,https://b/mcp` checks those instead.
        let Ok(asked) = std::env::var("KLIDE_OAUTH_LIVE") else { return };
        let urls: Vec<&str> = if asked.contains("://") {
            asked.split(',').collect()
        } else {
            vec!["https://mcp.linear.app/mcp", "https://mcp.notion.com/mcp", "https://mcp.sentry.dev/mcp"]
        };
        for url in urls {
            let found = discover(url).unwrap();
            eprintln!("{url} → {found:?}");
            assert!(found.registration.is_some(), "{url} has no registration endpoint");
        }
    }
}
