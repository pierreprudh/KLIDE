//! Explicit, read-only connection test. Does not save config or start inference.
use crate::custom_providers::{normalize, CustomProvider};
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    models: Vec<String>,
    elapsed_ms: u128,
}

fn parse_models(body: &[u8]) -> Result<Vec<String>, String> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| "The server answered, but did not return an OpenAI-compatible model list.")?;
    let rows = value["data"].as_array().ok_or("The server answered, but /models did not contain a data array. Check the API base URL.")?;
    let mut models = Vec::new();
    for row in rows {
        let id = row["id"].as_str().filter(|id| !id.trim().is_empty())
            .ok_or("The model list contains an invalid model ID.")?;
        if matches!(crate::models::listed_task(row).as_deref(), Some("embedding" | "ocr")) {
            continue;
        }
        models.push(id.to_string());
    }
    models.sort(); models.dedup();
    Ok(models)
}

async fn probe(url: &str, key: Option<String>) -> Result<Connection, String> {
    let started = Instant::now();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Could not create the connection test")?;
    let mut request = client.get(url);
    if let Some(key) = key { request = request.bearer_auth(key); }
    let mut response = request.send().await.map_err(|e| {
        if e.is_timeout() { "Connection timed out. Check the server address, network or SSH tunnel." }
        else { "Could not reach this endpoint. Check that the model server is running and reachable from this computer." }
    })?;
    match response.status().as_u16() {
        200..=299 => {},
        401 | 403 => return Err("Authentication was refused. Check the token reference and the server's access settings.".into()),
        300..=399 => return Err("The endpoint redirected the request. Enter its final API base URL.".into()),
        404 => return Err("Model listing was not found. Use the API base URL, usually ending in /v1.".into()),
        status => return Err(format!("The model server returned HTTP {status}. Check its status and logs.")),
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "The model list download was interrupted.")? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("The server's model list exceeds the size limit.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Connection { models: parse_models(&bytes)?, elapsed_ms: started.elapsed().as_millis() })
}

#[tauri::command]
pub async fn custom_provider_probe(provider: CustomProvider) -> Result<Connection, String> {
    let provider = normalize(provider)?;
    let config = provider.clone();
    let key = tokio::task::spawn_blocking(move || crate::providers::custom_token_for_config(&config, None))
        .await.map_err(|_| "Could not resolve endpoint authentication")?;
    if provider.token_ref.is_some() && key.is_none() {
        return Err("The token reference did not resolve. Check your environment or .env file.".into());
    }
    probe(&provider.models_url(), key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn provider(url: &str) -> CustomProvider {
        CustomProvider { id: "custom:lab".into(), label: "Lab".into(), base_url: url.into(), default_model: "".into(), token_ref: None }
    }
    #[test]
    fn accepts_private_addresses_and_tunnels_without_rewriting_paths() {
        for url in ["http://127.0.0.1:8081/v1/", "http://100.64.1.2:8000/v1", "https://lab.example/api/v1"] {
            let p = normalize(provider(url)).unwrap();
            assert_eq!(p.models_url(), format!("{}/models", url.trim_end_matches('/')));
        }
    }
    #[test]
    fn rejects_credential_urls_and_wrong_api_paths() {
        for url in ["https://user:secret@lab/v1", "https://lab/v1?key=secret", "https://lab/v1#token", "file:///tmp/server", "https://lab/v1/models", "https://lab/v1/chat/completions"] {
            assert!(normalize(provider(url)).is_err(), "{url}");
        }
    }
    #[test]
    fn a_successful_http_response_must_be_a_valid_model_list() {
        assert!(parse_models(br#"{"status":"ok"}"#).is_err());
        assert!(parse_models(br#"{"data":[{}]}"#).is_err());
        assert_eq!(parse_models(br#"{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}"#).unwrap(), ["a", "b"]);
        assert!(parse_models(br#"{"data":[]}"#).unwrap().is_empty());
    }
    #[test]
    fn known_non_chat_models_cannot_be_selected_as_chat_defaults() {
        let models = parse_models(br#"{"data":[
            {"id":"chat","task":"chat"}, {"id":"unknown"},
            {"id":"embed","task":"EMBEDDING"}, {"id":"ocr","task":"ocr"},
            {"id":"embed-caps","capabilities":["embedding"]},
            {"id":"both","capabilities":["embedding","completion"]}
        ]}"#).unwrap();
        assert_eq!(models, ["both", "chat", "unknown"]);
    }
    #[tokio::test]
    async fn tests_auth_and_models_without_generating_text() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut buf = [0; 4096];
            let n = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_lowercase();
            assert!(request.starts_with("get /v1/models "));
            assert!(request.contains("authorization: bearer fixture-key"));
            let body = r#"{"data":[{"id":"fixture"}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let result = probe(&format!("http://{address}/v1/models"), Some("fixture-key".into())).await.unwrap();
        server.join().unwrap();
        assert_eq!(result.models, ["fixture"]);
    }
}
