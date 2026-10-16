#!/usr/bin/env python3
"""Exercise KIDE's production ACP host against installed Hermes and a mock model.
No real provider calls or credentials. Uses a fresh Hermes home in a temp folder.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Model(BaseHTTPRequestHandler):
    calls = []

    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"object": "list", "data": [{"id": "mock-acp", "object": "model"}]}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Model.calls.append(body)
        messages = body.get("messages", body.get("input", []))
        has_tool = any(m.get("role") == "tool" or m.get("type") == "function_call_output" for m in messages)
        resumed = any("Continue the same conversation" in str(m.get("content", "")) for m in messages if m.get("role") == "user")
        if resumed:
            message = {"role": "assistant", "content": "acp-resume-ok"}; reason = "stop"
        elif has_tool:
            message = {"role": "assistant", "content": "acp-smoke-ok"}; reason = "stop"
        else:
            message = {"role": "assistant", "content": None, "tool_calls": [{"id": "read-note", "type": "function", "function": {"name": "read_file", "arguments": json.dumps({"path": "note.txt"})}}]}; reason = "tool_calls"
        usage = {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}
        self.send_response(200)
        streaming = body.get("stream")
        self.send_header("Content-Type", "text/event-stream" if streaming else "application/json"); self.end_headers()
        if self.path.endswith("/responses"):
            if "tool_calls" in message:
                call = message["tool_calls"][0]
                item = {"type": "function_call", "id": "fc-read-note", "call_id": call["id"], **call["function"], "status": "completed"}
            else:
                item = {"type": "message", "id": "msg-mock", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": message["content"], "annotations": []}]}
            response = {"id": f"resp-mock-{len(Model.calls)}", "object": "response", "status": "completed", "model": "mock-acp", "output": [item], "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}}
            if streaming:
                events = [{"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                          {"type": "response.output_item.added", "output_index": 0, "item": item}]
                if item["type"] == "message":
                    events.append({"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": message["content"]})
                events.extend([{"type": "response.output_item.done", "output_index": 0, "item": item}, {"type": "response.completed", "response": response}])
                for event in events:
                    self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
            else:
                self.wfile.write(json.dumps(response).encode())
            self.wfile.flush()
            return
        if streaming:
            delta = {k: v for k, v in message.items() if k != "role"}
            if "tool_calls" in delta:
                for index, call in enumerate(delta["tool_calls"]): call["index"] = index
            payload = {"id": "mock", "object": "chat.completion.chunk", "created": 1, "model": "mock-acp", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
            self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode())
            payload["choices"] = [{"index": 0, "delta": {}, "finish_reason": reason}]; payload["usage"] = usage
            self.wfile.write(("data: " + json.dumps(payload) + "\n\ndata: [DONE]\n\n").encode())
        else:
            self.wfile.write(json.dumps({"id": "mock", "object": "chat.completion", "created": 1, "model": "mock-acp", "choices": [{"index": 0, "message": message, "finish_reason": reason}], "usage": usage}).encode())
        self.wfile.flush()

    def log_message(self, *_):
        pass


def main():
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="kide-hermes-acp-") as directory:
        root = Path(directory); home = root / "home"; home.mkdir()
        workspace = root / "workspace"; workspace.mkdir(); (workspace / "note.txt").write_text("fixture-note\n")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/v1"
        env = os.environ.copy()
        for name in ["HERMES_PROFILE", "HERMES_CONFIG", "HERMES_ENV", "HERMES_CONFIG_PATH", "HERMES_ENV_PATH"]: env.pop(name, None)
        env.update(HERMES_HOME=str(home), OPENAI_API_KEY="mock", OPENAI_BASE_URL=url, KLIDE_HERMES_SMOKE_ROOT=str(workspace), HERMES_ACP_SKIP_CONFIGURED_MCP="1")
        (home / "config.yaml").write_text(json.dumps({"model": {"provider": "openai-api", "default": "mock-acp", "base_url": url, "context_length": 65536}, "terminal": {"backend": "local"}, "memory": {"memory_enabled": False, "user_profile_enabled": False}}))
        try:
            subprocess.run(["hermes", "acp", "--check"], env=env, check=True, timeout=180)
            subprocess.run(["cargo", "test", "--manifest-path", str(repo / "src-tauri/Cargo.toml"), "--lib", "installed_hermes_acp_streams_tools_and_resumes", "--", "--ignored", "--nocapture"], env=env, cwd=repo, check=True, timeout=180)
            messages = lambda call: call.get("messages", call.get("input", []))
            is_tool = lambda m: m.get("role") == "tool" or m.get("type") == "function_call_output"
            assert any(any(is_tool(m) for m in messages(call)) for call in Model.calls), "No tool result reached model"
            resumed = [c for c in Model.calls if any("Continue the same conversation" in str(m.get("content", "")) for m in messages(c) if m.get("role") == "user")]
            # Responses may carry history by previous_response_id, and
            # auxiliary title requests need not include the tool transcript.
            previous_ids = {f"resp-mock-{i}" for i in range(1, len(Model.calls))}
            assert resumed and any(any(is_tool(m) for m in messages(c)) or c.get("previous_response_id") in previous_ids for c in resumed), f"Resumed session lost tool history: {Model.calls}"
            print(f"Installed Hermes ACP smoke passed ({len(Model.calls)} mock model requests).")
        finally:
            server.shutdown(); server.server_close()


if __name__ == "__main__":
    main()
