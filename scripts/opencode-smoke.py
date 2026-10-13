#!/usr/bin/env python3
"""Exercise Klide's Rust delegate transport using an isolated OpenCode CLI.

Usage: python3 scripts/opencode-smoke.py --binary /path/to/opencode
No provider credentials, paid inference, or installed-CLI upgrades are needed.
"""
import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Model(BaseHTTPRequestHandler):
    variants = []
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        self.variants.append(body.get("klide_variant"))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
        self.end_headers()
        if not body.get("stream"):
            self.wfile.write(json.dumps({
                "id": "mock", "object": "chat.completion", "created": 1, "model": "mock",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from V2."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 7, "total_tokens": 17},
            }).encode())
            return
        try:
            reasoning = {
                "id": "mock", "object": "chat.completion.chunk", "created": 1, "model": "mock",
                "choices": [{"index": 0, "delta": {"reasoning_content": "Thinking about the answer."}, "finish_reason": None}],
            }
            self.wfile.write(("data: " + json.dumps(reasoning) + "\n\n").encode())
            self.wfile.flush()
            time.sleep(0.4)
            for text in ["Hello ", "from ", "V2."]:
                message = {
                    "id": "mock", "object": "chat.completion.chunk", "created": 1, "model": "mock",
                    "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                }
                self.wfile.write(("data: " + json.dumps(message) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(0.4)
            self.wfile.write(("data: " + json.dumps({
                "id": "mock", "object": "chat.completion.chunk", "created": 1, "model": "mock",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 7, "total_tokens": 17, "prompt_tokens_details": {"cached_tokens": 4}, "completion_tokens_details": {"reasoning_tokens": 2}},
            }) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.expanduser().resolve()
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="klide-opencode-smoke-") as temporary:
        root = Path(temporary).resolve()
        env = dict(os.environ)
        # An isolated CLI must not inherit a user's provider key/config path.
        env = {k: v for k, v in env.items() if not k.startswith("OPENCODE_") and not k.endswith("_API_KEY")}
        for name, folder in [("XDG_DATA_HOME", "data"), ("XDG_CONFIG_HOME", "config"), ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache")]:
            env[name] = str(root / folder)
        env["PWD"] = str(root)
        version = subprocess.check_output([str(binary), "--version"], env=env, cwd=root, text=True, timeout=10).strip()
        match = re.search(r"(?:^|\s)v?([12])\.", version)
        if match is None:
            raise SystemExit(f"Unsupported OpenCode version: {version}")
        major = match.group(1)
        model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        model.daemon_threads = True
        threading.Thread(target=model.serve_forever, daemon=True).start()
        try:
            config = root / "config" / "opencode"
            config.mkdir(parents=True, exist_ok=True)
            url = f"http://127.0.0.1:{model.server_port}/v1"
            if major == "2":
                settings = {"providers": {"mock": {"package": "@opencode/ai/providers/openai-compatible", "settings": {"baseURL": url, "apiKey": "mock"}, "models": {"mock": {"name": "Mock"}}}}, "commands": {"review": {"template": "Review the current changes. $ARGUMENTS"}}}
            else:
                settings = {"provider": {"mock": {"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": url, "apiKey": "mock"}, "models": {"mock": {"name": "Mock"}}}}, "command": {"review": {"template": "Review the current changes. $ARGUMENTS"}}}
            settings["model"] = "mock/mock"
            if major == "2":
                settings["providers"]["mock"]["models"]["mock"]["limit"] = {"context": 1000000, "output": 131072}
                settings["providers"]["mock"]["models"]["mock"]["variants"] = [{"id": "high", "settings": {"reasoningEffort": "high"}, "body": {"klide_variant": "high"}}]
            (config / "opencode.json").write_text(json.dumps(settings))
            env["KLIDE_OPENCODE_TEST_BINARY"] = str(binary)
            env["KLIDE_OPENCODE_TEST_ROOT"] = str(root)
            print(f"Testing OpenCode {version} in {root}", flush=True)
            subprocess.run([
                "cargo", "test", "--manifest-path", str(repo / "src-tauri" / "Cargo.toml"), "--lib",
                f"v{major}_mock_streams_resumes_and_runs_a_native_command", "--", "--ignored", "--nocapture",
            ], cwd=repo, env=env, check=True, timeout=180)
            if major == "2":
                # OpenCode may also generate a session title with the model.
                assert len(Model.variants) >= 3 and set(Model.variants) == {"high"}, f"Effort variant lost on new/resumed/command turn: {Model.variants}"
        finally:
            model.shutdown()
            model.server_close()


if __name__ == "__main__":
    main()
