//! Chat-completions shape → Anthropic, and Anthropic SSE → chat SSE.
use serde_json::{json, Value};
use std::io::{self, BufRead, Read};
fn content(value: &Value) -> Result<Vec<Value>, String> {
    if let Some(text) = value.as_str() {
        return Ok(vec![json!({"type":"text","text":text})]);
    }
    if value.is_null() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for part in value.as_array().ok_or("Invalid chat content.")? {
        match part["type"].as_str() {
            Some("text") => out.push(json!({"type":"text","text":part["text"]})),
            Some("image_url") => {
                let url = part["image_url"]["url"]
                    .as_str()
                    .ok_or("Missing image URL.")?;
                let source = if let Some(data) = url.strip_prefix("data:") {
                    let (media, bytes) = data
                        .split_once(";base64,")
                        .ok_or("Unsupported data image.")?;
                    json!({"type":"base64","media_type":media,"data":bytes})
                } else {
                    json!({"type":"url","url":url})
                };
                out.push(json!({"type":"image","source":source}));
            }
            _ => return Err("Unsupported chat content block.".into()),
        }
    }
    Ok(out)
}
pub fn request(input: &Value) -> Result<Value, String> {
    let mut system = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    for message in input["messages"]
        .as_array()
        .ok_or("Missing chat messages.")?
    {
        let role = message["role"].as_str().ok_or("Missing chat role.")?;
        if matches!(role, "system" | "developer") {
            system.extend(content(&message["content"])?);
            continue;
        }
        let (role, mut blocks) = if role == "tool" {
            (
                "user",
                vec![
                    json!({"type":"tool_result","tool_use_id":message["tool_call_id"],"content":content(&message["content"])?}),
                ],
            )
        } else {
            (role, content(&message["content"])?)
        };
        if !matches!(role, "user" | "assistant") {
            return Err("Unsupported chat role.".into());
        }
        for tool in message["tool_calls"].as_array().into_iter().flatten() {
            blocks.push(json!({"type":"tool_use","id":tool["id"],"name":tool["function"]["name"],"input":serde_json::from_str::<Value>(tool["function"]["arguments"].as_str().ok_or("Missing tool arguments.")?).map_err(|_|"Invalid tool arguments.")?}));
        }
        if messages.last().is_some_and(|m| m["role"] == role) {
            messages.last_mut().unwrap()["content"]
                .as_array_mut()
                .unwrap()
                .extend(blocks)
        } else if !blocks.is_empty() {
            messages.push(json!({"role":role,"content":blocks}));
        }
    }
    let mut out = json!({"model":input["model"],"max_tokens":input.get("max_tokens").cloned().unwrap_or(json!(8192)),"messages":messages,"stream":true});
    if !system.is_empty() {
        out["system"] = json!(system)
    }
    for key in ["temperature", "top_p"] {
        if let Some(value) = input.get(key) {
            out[key] = value.clone()
        }
    }
    let tools:Vec<_>=input["tools"].as_array().into_iter().flatten().map(|tool|json!({"name":tool["function"]["name"],"description":tool["function"]["description"],"input_schema":tool["function"]["parameters"]})).collect();
    if !tools.is_empty() {
        out["tools"] = json!(tools)
    }
    if let Some(choice) = input.get("tool_choice") {
        out["tool_choice"] = match choice.as_str() {
            Some("auto") => json!({"type":"auto"}),
            Some("required") => json!({"type":"any"}),
            Some("none") => json!({"type":"none"}),
            _ => json!({"type":"tool","name":choice["function"]["name"]}),
        };
    }
    Ok(out)
}
fn event(value: Value) -> Vec<u8> {
    format!("data: {value}\n\n").into_bytes()
}
pub struct StreamReader<R: BufRead> {
    reader: R,
    pending: io::Cursor<Vec<u8>>,
    done: bool,
    input: u64,
    cached: u64,
    output: u64,
}
impl<R: BufRead> StreamReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            pending: io::Cursor::new(vec![]),
            done: false,
            input: 0,
            cached: 0,
            output: 0,
        }
    }
    fn next(&mut self) -> Result<Vec<u8>, String> {
        let mut data = String::new();
        loop {
            let mut line = String::new();
            if self
                .reader
                .read_line(&mut line)
                .map_err(|_| "Anthropic stream was interrupted.")?
                == 0
            {
                return Err("Anthropic stream ended before completion.".into());
            }
            if line.trim().is_empty() {
                if data.is_empty() {
                    continue;
                } else {
                    break;
                }
            }
            if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.trim())
            }
            if data.len() > 16 * 1024 * 1024 {
                return Err("Anthropic event is too large.".into());
            }
        }
        let value: Value = serde_json::from_str(&data).map_err(|_| "Invalid Anthropic event.")?;
        let delta = match value["type"].as_str() {
            Some("message_start") => {
                let u = &value["message"]["usage"];
                self.cached = u["cache_read_input_tokens"].as_u64().unwrap_or(0);
                self.input = u["input_tokens"].as_u64().unwrap_or(0)
                    + self.cached
                    + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                self.output = u["output_tokens"].as_u64().unwrap_or(0);
                return Ok(vec![]);
            }
            Some("content_block_start") if value["content_block"]["type"] == "tool_use" => {
                let b = &value["content_block"];
                json!({"tool_calls":[{"index":value["index"],"id":b["id"],"type":"function","function":{"name":b["name"],"arguments":""}}]})
            }
            Some("content_block_delta") => match value["delta"]["type"].as_str() {
                Some("text_delta") => json!({"content":value["delta"]["text"]}),
                Some("input_json_delta") => {
                    json!({"tool_calls":[{"index":value["index"],"function":{"arguments":value["delta"]["partial_json"]}}]})
                }
                Some("thinking_delta") => json!({"reasoning_content":value["delta"]["thinking"]}),
                _ => return Ok(vec![]),
            },
            Some("message_delta") => {
                self.output = value["usage"]["output_tokens"]
                    .as_u64()
                    .unwrap_or(self.output);
                let reason = match value["delta"]["stop_reason"].as_str() {
                    Some("tool_use") => "tool_calls",
                    Some("max_tokens") => "length",
                    _ => "stop",
                };
                return Ok(event(
                    json!({"choices":[{"delta":{},"finish_reason":reason}]}),
                ));
            }
            Some("message_stop") => {
                self.done = true;
                let mut out = event(
                    json!({"choices":[],"usage":{"prompt_tokens":self.input,"completion_tokens":self.output,"prompt_tokens_details":{"cached_tokens":self.cached}}}),
                );
                out.extend_from_slice(b"data: [DONE]\n\n");
                return Ok(out);
            }
            Some("error") => {
                return Err(
                    "Anthropic inference failed. Check model availability and API allowance."
                        .into(),
                )
            }
            _ => return Ok(vec![]),
        };
        Ok(event(
            json!({"choices":[{"delta":delta,"finish_reason":null}]}),
        ))
    }
}
impl<R: BufRead> Read for StreamReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            let n = self.pending.read(buf)?;
            if n > 0 || self.done {
                return Ok(n);
            }
            let data = match self.next() {
                Ok(data) => data,
                Err(message) => {
                    self.done = true;
                    event(json!({"error":{"message":message}}))
                }
            };
            self.pending = io::Cursor::new(data)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_results_and_usage_are_preserved() {
        let out=request(&json!({"model":"claude-test","messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"t1","function":{"name":"Read","arguments":"{}"}}]},{"role":"tool","tool_call_id":"t1","content":"contents"}]})).unwrap();
        assert_eq!(out["messages"][1]["content"][0]["type"], "tool_result");
        assert_eq!(out["messages"][1]["content"][0]["tool_use_id"], "t1");
    }
}
