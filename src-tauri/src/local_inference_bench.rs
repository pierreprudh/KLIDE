//! Opt-in live benchmark through Klide's real streaming adapters.
//! No workspace tools are executed; tool calls are checked against a fixture.
use super::*;
use std::sync::{Arc, Mutex};
use std::time::Instant;

struct Controlled<P>(P);
impl<P: StreamingProvider> StreamingProvider for Controlled<P> {
    type ToolAccumulator = P::ToolAccumulator;
    fn name(&self) -> &str { self.0.name() }
    fn build_request(&self, client: &reqwest::Client) -> Result<reqwest::RequestBuilder, String> {
        let request = self.0.build_request(client)?.build().map_err(|e| e.to_string())?;
        let mut body: serde_json::Value = serde_json::from_slice(request.body().and_then(|b| b.as_bytes()).ok_or("Missing JSON body")?).map_err(|e| e.to_string())?;
        if self.name() == "Ollama" {
            body["options"]["temperature"] = serde_json::json!(0);
            body["options"]["seed"] = serde_json::json!(42);
            body["options"]["num_predict"] = serde_json::json!(256);
            body["think"] = serde_json::json!(false);
        } else {
            body["temperature"] = serde_json::json!(0);
            body["seed"] = serde_json::json!(42);
            body["max_tokens"] = serde_json::json!(256);
            body["chat_template_kwargs"] = serde_json::json!({"enable_thinking":false});
        }
        Ok(client.post(request.url().clone()).headers(request.headers().clone()).json(&body))
    }
    fn parse_line(&mut self, line: &str, content: &mut String, thinking: &mut String, tools: &mut Self::ToolAccumulator, on_chunk: &dyn Fn(StreamChunk)) -> Result<(), String> {
        self.0.parse_line(line, content, thinking, tools, on_chunk)
    }
    fn finalize_response(self, content: String, thinking: String, tools: Self::ToolAccumulator) -> AiChatResponse {
        self.0.finalize_response(content, thinking, tools)
    }
}

#[tokio::test]
#[ignore = "live local model benchmark; see scripts/local-inference/README.md"]
async fn compare_klide_model_live() {
    let provider = std::env::var("KLIDE_BENCH_PROVIDER").expect("Set KLIDE_BENCH_PROVIDER");
    assert!(matches!(provider.as_str(), "ollama" | "llamacpp" | "mlx"));
    let long = "Fixture project: TypeScript editor. Files: src/app.ts, src/utils.ts. Tests: npm test. No files may be changed.\n".repeat(100);
    let tools = vec![serde_json::json!({"type":"function","function":{"name":"read_file","description":"Read a workspace file","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}})];
    let scenarios = [
        ("warmup", "Reply with exactly: ready".to_string(), None),
        ("short", "Explain why a missing map entry can cause a TypeScript application to crash, in about 100 words. No tools.".to_string(), None),
        ("long", format!("{long}\nSummarize this project's rules in about 100 words. No tools."), None),
        ("tool", "Use read_file to read src/utils.ts. Do not guess its contents.".to_string(), Some(tools)),
    ];
    let mut rows = vec![];
    for (scenario, prompt, tools) in scenarios {
        for repeat in 0..if scenario == "warmup" { 1 } else { 3 } {
            let messages = vec![serde_json::json!({"role":"system","content":"You are Kit, Klide's coding assistant. Follow instructions. Use the supplied tools when requested. Keep responses concise. Do not think aloud."}), serde_json::json!({"role":"user","content":prompt})];
            let started = Instant::now();
            let first: Arc<Mutex<Option<f64>>> = Arc::default();
            let record = first.clone();
            let channel = Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                    if let Ok(chunk) = serde_json::from_str::<StreamChunk>(&json) {
                        if !chunk.content.is_empty() || !chunk.thinking.is_empty() {
                            record.lock().unwrap().get_or_insert(started.elapsed().as_secs_f64());
                        }
                    }
                }
                Ok(())
            });
            let response = if provider == "ollama" {
                stream_provider(Controlled(OllamaAdapter { model: "pierreprudh/klide-8b:latest".into(), messages, tools: tools.clone(), num_ctx: Some(8192), num_predict: Some(256), think: Some(false), usage: AiUsage::default(), stop_reason: None }), &channel).await
            } else {
                stream_provider(Controlled(OpenAiAdapter { provider: provider.clone(), chat_url: if provider == "mlx" { "http://127.0.0.1:8080/v1/chat/completions".into() } else { "http://127.0.0.1:8081/v1/chat/completions".into() }, include_tools: true, include_usage_in_stream: true, include_cost_accounting: false, send_attribution: false, model: if provider == "mlx" { std::env::var("KLIDE_BENCH_MODEL").expect("Set KLIDE_BENCH_MODEL for MLX") } else { "pierreprudh/klide-8b".into() }, messages, tools: tools.clone(), key: None, reasoning_effort: None, usage: AiUsage::default() }), &channel).await
            };
            let seconds = started.elapsed().as_secs_f64();
            let ttft = *first.lock().unwrap();
            let row = match response {
                Ok(response) => {
                    let tokens = response.usage.as_ref().and_then(|u| u.completion_tokens);
                    let tool_ok = response.tool_calls.iter().any(|t| {
                        let f = &t["function"];
                        let args = if f["arguments"].is_string() { serde_json::from_str::<serde_json::Value>(f["arguments"].as_str().unwrap()).unwrap_or_default() } else { f["arguments"].clone() };
                        f["name"] == "read_file" && args["path"] == "src/utils.ts"
                    });
                    serde_json::json!({"scenario":scenario,"repeat":repeat,"seconds":seconds,"ttftSeconds":ttft,"completionTokens":tokens,"streamTokensPerSecond":ttft.and_then(|t| tokens.map(|n| n as f64 / (seconds-t).max(0.001))),"toolCorrect":tool_ok,"response":response})
                }
                Err(error) => serde_json::json!({"scenario":scenario,"repeat":repeat,"seconds":seconds,"error":error}),
            };
            eprintln!("BENCH {}", serde_json::to_string(&row).unwrap());
            rows.push(row);
        }
    }
    let path = std::env::var("KLIDE_BENCH_OUTPUT").expect("Set KLIDE_BENCH_OUTPUT");
    std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({"provider":provider,"context":8192,"maxTokens":256,"temperature":0,"seed":42,"rows":rows})).unwrap()).unwrap();
    assert!(rows.iter().all(|r| r.get("error").is_none()), "Benchmark included request errors");
}
