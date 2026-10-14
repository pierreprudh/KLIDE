//! Stateless Responses API ↔ chat completions for Codex's agent loop.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufRead, Read};

#[derive(Clone, Debug)]
pub struct ToolSpec {
    name: String,
    namespace: Option<String>,
    custom: bool,
}
pub type ToolMap = HashMap<String, ToolSpec>;
fn wire_name(name: &str, namespace: Option<&str>) -> String {
    let original = namespace
        .map(|ns| format!("{ns}__{name}"))
        .unwrap_or_else(|| name.into());
    if original.len() <= 64
        && original
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return original;
    }
    let hash = Sha256::digest(original.as_bytes());
    let suffix: String = hash[..6].iter().map(|b| format!("{b:02x}")).collect();
    let prefix: String = original
        .chars()
        .take(50)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{prefix}_{suffix}")
}
fn flatten_tools(
    tools: &[Value],
    namespace: Option<&str>,
    out: &mut Vec<Value>,
) -> Result<(), String> {
    for tool in tools {
        if tool["type"] == "namespace" {
            if namespace.is_some() {
                return Err("Nested tool namespaces are not supported.".into());
            }
            flatten_tools(
                tool["tools"].as_array().ok_or("Missing namespace tools.")?,
                Some(tool["name"].as_str().ok_or("Missing namespace name.")?),
                out,
            )?;
        } else {
            let mut tool = tool.clone();
            if let Some(namespace) = namespace {
                tool["namespace"] = json!(namespace);
            }
            out.push(tool);
        }
    }
    Ok(())
}
fn text_content(value: &Value) -> Result<Value, String> {
    if value.is_string() {
        return Ok(value.clone());
    }
    let mut parts = Vec::new();
    for block in value.as_array().ok_or("Invalid message content.")? {
        match block["type"].as_str() {
            Some("input_text" | "output_text" | "text") => {
                parts.push(json!({"type":"text","text":block["text"]}))
            }
            Some("input_image") => {
                parts.push(json!({"type":"image_url","image_url":{"url":block["image_url"]}}))
            }
            _ => {
                return Err(
                    "This Responses content block is not supported by the source adapter.".into(),
                )
            }
        }
    }
    Ok(json!(parts))
}
fn add_call(messages: &mut Vec<Value>, call: Value) {
    if messages.last().is_none_or(|m| m["role"] != "assistant") {
        messages.push(json!({"role":"assistant","content":null,"tool_calls":[]}));
    }
    let last = messages.last_mut().unwrap();
    if last.get("tool_calls").is_none() {
        last["tool_calls"] = json!([]);
    }
    last["tool_calls"].as_array_mut().unwrap().push(call);
}
pub fn request(input: &Value) -> Result<(Value, ToolMap), String> {
    if input
        .get("previous_response_id")
        .is_some_and(|v| !v.is_null())
    {
        return Err("This intelligence source requires full conversation input; stored Responses IDs are not supported.".into());
    }
    let mut flat = Vec::new();
    flatten_tools(
        input["tools"].as_array().map(Vec::as_slice).unwrap_or(&[]),
        None,
        &mut flat,
    )?;
    let mut messages = Vec::new();
    if let Some(instructions) = input["instructions"].as_str().filter(|s| !s.is_empty()) {
        messages.push(json!({"role":"system","content":instructions}));
    }
    if let Some(text) = input["input"].as_str() {
        messages.push(json!({"role":"user","content":text}));
    } else {
        for item in input["input"]
            .as_array()
            .ok_or("Missing Responses input.")?
        {
            match item["type"].as_str().unwrap_or("message") {
                "message" => {
                    let role = item["role"].as_str().ok_or("Missing message role.")?;
                    messages.push(json!({"role":if role == "developer" {"system"} else {role},"content":text_content(&item["content"])?}));
                }
                "function_call" => add_call(&mut messages, json!({"id":item["call_id"],"type":"function","function":{"name":wire_name(item["name"].as_str().unwrap_or(""), item["namespace"].as_str()),"arguments":item["arguments"]}})),
                "custom_tool_call" => add_call(&mut messages, json!({"id":item["call_id"],"type":"function","function":{"name":wire_name(item["name"].as_str().unwrap_or(""), item["namespace"].as_str()),"arguments":json!({"input":item["input"]}).to_string()}})),
                "function_call_output" | "custom_tool_call_output" => messages.push(json!({"role":"tool","tool_call_id":item["call_id"],"content":text_content(&item["output"])?})),
                // These bridge responses never carry opaque native reasoning.
                "reasoning" => {},
                _ => return Err(format!("Unsupported Responses item: {}.", item["type"])),
            }
        }
    }
    let mut custom = ToolMap::new();
    let mut tools = Vec::new();
    for tool in &flat {
        let original_name = tool["name"].as_str().ok_or("Missing tool name.")?;
        let namespace = tool["namespace"].as_str();
        let name = wire_name(original_name, namespace);
        if custom
            .insert(
                name.clone(),
                ToolSpec {
                    name: original_name.into(),
                    namespace: namespace.map(str::to_owned),
                    custom: tool["type"] == "custom",
                },
            )
            .is_some()
        {
            return Err("Tool names collide after translating namespaces.".into());
        }
        match tool["type"].as_str() {
            Some("function") => tools.push(json!({"type":"function","function":{"name":name,"description":tool.get("description").cloned().unwrap_or(json!("")),"parameters":tool["parameters"]}})),
            Some("custom") => {
                tools.push(json!({"type":"function","function":{"name":name,"description":format!("{}\nReturn the tool's raw input as the input string. Required format: {}", tool["description"].as_str().unwrap_or(""), tool.get("format").cloned().unwrap_or(Value::Null)),"parameters":{"type":"object","properties":{"input":{"type":"string"}},"required":["input"],"additionalProperties":false}}}));
            }
            _ => return Err(format!("Unsupported Responses tool: {}. Disable hosted tools for this intelligence source.", tool["type"])),
        }
    }
    let mut out = json!({"model":input["model"],"messages":messages,"stream":input["stream"].as_bool().unwrap_or(true)});
    for key in ["temperature", "top_p", "parallel_tool_calls"] {
        if let Some(value) = input.get(key) {
            out[key] = value.clone();
        }
    }
    if let Some(value) = input.get("max_output_tokens") {
        out["max_tokens"] = value.clone();
    }
    if !tools.is_empty() {
        out["tools"] = json!(tools);
    }
    if let Some(choice) = input.get("tool_choice") {
        if choice.is_string() {
            out["tool_choice"] = choice.clone();
        } else if matches!(choice["type"].as_str(), Some("function" | "custom")) {
            out["tool_choice"] = json!({"type":"function","function":{"name":wire_name(choice["name"].as_str().unwrap_or(""), choice["namespace"].as_str())}});
        } else {
            return Err("Unsupported Responses tool selection.".into());
        }
    }
    Ok((out, custom))
}
fn usage(value: &Value) -> Value {
    let input = value["prompt_tokens"].as_u64().unwrap_or(0);
    let output = value["completion_tokens"].as_u64().unwrap_or(0);
    json!({"input_tokens":input,"output_tokens":output,"total_tokens":input+output,"input_tokens_details":{"cached_tokens":value["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)},"output_tokens_details":{"reasoning_tokens":value["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0)}})
}
#[derive(Default)]
struct Tool {
    index: usize,
    id: String,
    name: String,
    arguments: String,
    started: bool,
    custom: bool,
}
struct State {
    id: String,
    model: String,
    sequence: u64,
    next: usize,
    text: String,
    text_index: Option<usize>,
    tools: BTreeMap<u64, Tool>,
    custom: ToolMap,
    stop: String,
    usage: Value,
}
impl State {
    fn event(&mut self, kind: &str, mut value: Value) -> Vec<u8> {
        value["type"] = json!(kind);
        value["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        format!("event: {kind}\ndata: {value}\n\n").into_bytes()
    }
    fn item(&self, tool: &Tool, done: bool) -> Result<Value, String> {
        let spec = self.custom.get(&tool.name);
        let name = spec.map(|s| s.name.as_str()).unwrap_or(&tool.name);
        let mut item = if tool.custom {
            let input = if done {
                serde_json::from_str::<Value>(&tool.arguments)
                    .map_err(|_| "Invalid custom tool arguments.")?["input"]
                    .as_str()
                    .ok_or("Missing custom tool input.")?
                    .to_owned()
            } else {
                String::new()
            };
            json!({"type":"custom_tool_call","id":format!("item_{}", tool.id),"call_id":tool.id,"name":name,"input":input,"status":if done {"completed"} else {"in_progress"}})
        } else {
            json!({"type":"function_call","id":format!("item_{}", tool.id),"call_id":tool.id,"name":name,"arguments":if done {&tool.arguments} else {""},"status":if done {"completed"} else {"in_progress"}})
        };
        if let Some(namespace) = spec.and_then(|s| s.namespace.as_ref()) {
            item["namespace"] = json!(namespace);
        }
        Ok(item)
    }
    fn message(&self, done: bool) -> Value {
        json!({"type":"message","id":format!("msg_{}",self.id),"role":"assistant","status":if done {"completed"} else {"in_progress"},"content":if done {json!([{"type":"output_text","text":self.text,"annotations":[]}])} else {json!([])}})
    }
    fn response(&self, status: &str, output: Vec<Value>) -> Value {
        json!({"id":self.id,"object":"response","created_at":0,"status":status,"model":self.model,"output":output,"usage":usage(&self.usage),"error":null,"incomplete_details":if status=="incomplete" {json!({"reason":"max_output_tokens"})} else {Value::Null}})
    }
    fn chunk(&mut self, value: &Value) -> Result<Vec<u8>, String> {
        if value.get("error").is_some_and(|v| !v.is_null()) {
            return Err("The intelligence source returned an inference error.".into());
        }
        if value.get("usage").is_some_and(|v| !v.is_null()) {
            self.usage = value["usage"].clone();
        }
        let Some(choice) = value["choices"].as_array().and_then(|v| v.first()) else {
            return Ok(Vec::new());
        };
        if let Some(stop) = choice["finish_reason"].as_str() {
            self.stop = stop.into();
        }
        let mut output = Vec::new();
        if let Some(text) = choice["delta"]["content"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            if self.text_index.is_none() {
                let index = self.next;
                self.next += 1;
                self.text_index = Some(index);
                output.extend(self.event(
                    "response.output_item.added",
                    json!({"output_index":index,"item":self.message(false)}),
                ));
                output.extend(self.event("response.content_part.added", json!({"item_id":format!("msg_{}",self.id),"output_index":index,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}})));
            }
            self.text.push_str(text);
            output.extend(self.event("response.output_text.delta", json!({"item_id":format!("msg_{}",self.id),"output_index":self.text_index,"content_index":0,"delta":text})));
        }
        for call in choice["delta"]["tool_calls"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let key = call["index"]
                .as_u64()
                .ok_or("Missing streamed tool index.")?;
            let tool = self.tools.entry(key).or_insert_with(|| {
                let index = self.next;
                self.next += 1;
                Tool {
                    index,
                    ..Default::default()
                }
            });
            if let Some(id) = call["id"].as_str() {
                tool.id.push_str(id);
            }
            if let Some(name) = call["function"]["name"].as_str() {
                tool.name.push_str(name);
            }
            if let Some(args) = call["function"]["arguments"].as_str() {
                tool.arguments.push_str(args);
            }
            tool.custom = self.custom.get(&tool.name).is_some_and(|spec| spec.custom);
            let starts = !tool.started && !tool.id.is_empty() && !tool.name.is_empty();
            if starts {
                tool.started = true;
            }
            let index = tool.index;
            let id = format!("item_{}", tool.id);
            let custom = tool.custom;
            if starts {
                let item = self.item(&self.tools[&key], false)?;
                output.extend(self.event(
                    "response.output_item.added",
                    json!({"output_index":index,"item":item}),
                ));
            }
            if !custom {
                if let Some(args) = call["function"]["arguments"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                {
                    output.extend(self.event(
                        "response.function_call_arguments.delta",
                        json!({"item_id":id,"output_index":index,"delta":args}),
                    ));
                }
            }
        }
        Ok(output)
    }
    fn finish(&mut self) -> Result<Vec<u8>, String> {
        if self.stop.is_empty() {
            return Err("Inference stream omitted its completion reason.".into());
        }
        let mut out = Vec::new();
        let mut items = BTreeMap::new();
        if let Some(index) = self.text_index {
            let part = json!({"type":"output_text","text":self.text,"annotations":[]});
            let item = self.message(true);
            out.extend(self.event("response.output_text.done", json!({"item_id":item["id"],"output_index":index,"content_index":0,"text":self.text})));
            out.extend(self.event(
                "response.content_part.done",
                json!({"item_id":item["id"],"output_index":index,"content_index":0,"part":part}),
            ));
            out.extend(self.event(
                "response.output_item.done",
                json!({"output_index":index,"item":item}),
            ));
            items.insert(index, item);
        }
        let completed = self
            .tools
            .values()
            .map(|tool| {
                if !tool.started {
                    return Err("Inference stream returned an incomplete tool call.".into());
                }
                self.item(tool, true)
                    .map(|item| (tool.index, tool.custom, item))
            })
            .collect::<Result<Vec<_>, String>>()?;
        for (index, custom, item) in completed {
            let kind = if custom {
                "response.custom_tool_call_input.done"
            } else {
                "response.function_call_arguments.done"
            };
            let mut payload =
                json!({"item_id":item["id"],"output_index":index,"name":item["name"]});
            payload[if custom { "input" } else { "arguments" }] =
                item[if custom { "input" } else { "arguments" }].clone();
            out.extend(self.event(kind, payload));
            out.extend(self.event(
                "response.output_item.done",
                json!({"output_index":index,"item":item}),
            ));
            items.insert(index, item);
        }
        let status = if self.stop == "length" {
            "incomplete"
        } else {
            "completed"
        };
        out.extend(self.event(
            if status == "incomplete" {
                "response.incomplete"
            } else {
                "response.completed"
            },
            json!({"response":self.response(status,items.into_values().collect())}),
        ));
        Ok(out)
    }
}
pub struct StreamReader<R: BufRead> {
    reader: R,
    pending: io::Cursor<Vec<u8>>,
    state: State,
    done: bool,
}
impl<R: BufRead> StreamReader<R> {
    pub fn new(reader: R, model: &str, custom: ToolMap) -> Self {
        let mut state = State {
            id: format!(
                "resp_klide_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            model: model.into(),
            sequence: 0,
            next: 0,
            text: String::new(),
            text_index: None,
            tools: BTreeMap::new(),
            custom,
            stop: String::new(),
            usage: Value::Null,
        };
        let mut initial = state.event(
            "response.created",
            json!({"response":state.response("in_progress",vec![])}),
        );
        initial.extend(state.event(
            "response.in_progress",
            json!({"response":state.response("in_progress",vec![])}),
        ));
        Self {
            reader,
            pending: io::Cursor::new(initial),
            state,
            done: false,
        }
    }
    fn next(&mut self) -> Result<Vec<u8>, String> {
        let mut data = String::new();
        loop {
            let mut line = String::new();
            if self
                .reader
                .read_line(&mut line)
                .map_err(|_| "Intelligence stream was interrupted.")?
                == 0
            {
                return Err("Intelligence stream ended before completion.".into());
            }
            if line.trim().is_empty() {
                if data.is_empty() {
                    continue;
                } else {
                    break;
                }
            }
            if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.trim());
            }
            if data.len() > 16 * 1024 * 1024 {
                return Err("Inference event is too large.".into());
            }
        }
        if data == "[DONE]" {
            let result = self.state.finish()?;
            self.done = true;
            return Ok(result);
        }
        let value: Value =
            serde_json::from_str(&data).map_err(|_| "Invalid intelligence event.")?;
        self.state.chunk(&value)
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
                Ok(bytes) => bytes,
                Err(message) => {
                    self.done = true;
                    self.state
                        .event("error", json!({"code":"source_error","message":message}))
                }
            };
            self.pending = io::Cursor::new(data);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn namespaces_survive_translation_and_history() {
        let (value, specs) = request(&json!({"model":"coder","input":[{"type":"function_call","name":"read","namespace":"files","call_id":"c1","arguments":"{}"}],"tools":[{"type":"namespace","name":"files","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]}]})).unwrap();
        assert_eq!(value["tools"][0]["function"]["name"], "files__read");
        assert_eq!(
            value["messages"][0]["tool_calls"][0]["function"]["name"],
            "files__read"
        );
        let wire = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c2","function":{"name":"files__read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]})
        );
        let mut reader = StreamReader::new(io::Cursor::new(wire), "coder", specs);
        let mut output = String::new();
        reader.read_to_string(&mut output).unwrap();
        assert!(output.contains("\"namespace\":\"files\""));
        assert!(output.contains("\"name\":\"read\""));
    }
    #[test]
    fn custom_tools_and_history_roundtrip() {
        let (request,custom) = request(&json!({"model":"coder","input":[{"type":"custom_tool_call","call_id":"c1","name":"apply_patch","input":"patch"},{"type":"custom_tool_call_output","call_id":"c1","output":"done"}],"tools":[{"type":"custom","name":"apply_patch","format":{"type":"text"}}]})).unwrap();
        assert_eq!(
            request["messages"][0]["tool_calls"][0]["function"]["arguments"],
            r#"{"input":"patch"}"#
        );
        assert_eq!(request["messages"][1]["tool_call_id"], "c1");
        let chunks = [
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c2","function":{"name":"apply_patch","arguments":"{\"input\":\"new patch\"}"}}]},"finish_reason":"tool_calls"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}),
        ];
        let mut input = chunks
            .iter()
            .map(|c| format!("data: {c}\n\n"))
            .collect::<String>();
        input.push_str("data: [DONE]\n\n");
        let mut reader = StreamReader::new(io::Cursor::new(input), "coder", custom);
        let mut out = String::new();
        reader.read_to_string(&mut out).unwrap();
        assert!(out.contains("custom_tool_call"));
        assert!(out.contains("new patch"));
        assert!(out.contains("response.completed"));
        assert!(out.contains("\"total_tokens\":8"));
    }
}
