#!/usr/bin/env python3
"""A/B the `spawn_subagent` tool description: origin/main vs working tree.

Sends the same user requests to one model with each version of the schema and
checks the first turn's tool calls against what the user asked for: background,
the named agent/model, and one call per requested worker.

Usage (from repo root):
  DEEPSEEK_API_KEY=... python3 scripts/prompt-ab/spawn_subagent_ab.py
  OPENROUTER_API_KEY=... python3 scripts/prompt-ab/spawn_subagent_ab.py \
      --url https://openrouter.ai/api/v1/chat/completions --model deepseek/deepseek-v4.1-flash --key-env OPENROUTER_API_KEY

Only the descriptions are read from tools.rs; the parameter shape is mirrored
here (enums included), so a new parameter needs adding below.
"""
import argparse, json, os, re, subprocess, sys, urllib.request

ROLES = ["explorer", "reviewer", "implementer", "tester"]
WORKERS = ["claude-code", "codex", "opencode", "omp", "anthropic", "openai", "openrouter", "deepseek", "mistral"]

SCENARIOS = [
    ("background", "Run codex in the background to add input validation to src/utils.ts, and meanwhile tell me what the file does.",
     lambda calls: len(calls) >= 1 and all(c.get("background") is True and c.get("worker") == "codex" for c in calls)),
    ("named model", "Use claude-code with opus to review src/api.ts for bugs.",
     lambda calls: len(calls) == 1 and calls[0].get("worker") == "claude-code" and "opus" in str(calls[0].get("model", "")).lower()),
    ("five at once", "Spin up 5 codex workers in parallel, one per file: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts. Each one adds unit tests for its file.",
     lambda calls: len(calls) == 5 and all(c.get("worker") == "codex" and c.get("background") is True for c in calls)),
    ("no worker named", "Have a subagent map how authentication works in this project.",
     lambda calls: len(calls) >= 1 and all("worker" not in c and "model" not in c for c in calls)),
]

SYSTEM = ("You are Kit, a coding agent in the Klide editor, working in the project at /Users/me/demo-app "
          "(TypeScript, git repository). Use tools to act. Be brief.")


def rust_str(src: str, start: int) -> str:
    """The Rust string literal beginning at src[start] == '"'."""
    out, i = [], start + 1
    while src[i] != '"':
        if src[i] == "\\":
            out.append({"n": "\n", '"': '"', "\\": "\\", "'": "'"}.get(src[i + 1], src[i + 1]))
            i += 2
        else:
            out.append(src[i]); i += 1
    return "".join(out)


def schema_from(src: str) -> dict:
    at = src.index('schema("spawn_subagent", ')
    block = src[at: src.index("&[\"subagent\", \"task\"]", at)]
    desc = rust_str(block, block.index('"', len('schema("spawn_subagent", ')))
    def param(name):
        m = re.search(r'"%s": \{[^\n]*?"description": ' % name, block)
        return rust_str(block, m.end())
    props = {
        "subagent": {"type": "string", "enum": ROLES, "description": param("subagent")},
        "task": {"type": "string", "description": param("task")},
        "worker": {"type": "string", "enum": WORKERS, "description": param("worker")},
        "model": {"type": "string", "description": param("model")},
        "source_ref": {"type": "string", "description": param("source_ref")},
        "background": {"type": "boolean", "description": param("background")},
    }
    return {"type": "function", "function": {"name": "spawn_subagent", "description": desc,
            "parameters": {"type": "object", "properties": props, "required": ["subagent", "task"]}}}


OTHER_TOOLS = [
    {"type": "function", "function": {"name": "read_file", "description": "Read a workspace file.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "list_files", "description": "List files under a workspace directory.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
]


def ask(url, key, model, tool, prompt):
    body = {"model": model, "temperature": 0, "tools": [tool] + OTHER_TOOLS,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        msg = json.load(r)["choices"][0]["message"]
    calls = []
    for c in msg.get("tool_calls") or []:
        if c["function"]["name"] == "spawn_subagent":
            try:
                calls.append(json.loads(c["function"]["arguments"] or "{}"))
            except json.JSONDecodeError:
                calls.append({"_unparsed": c["function"]["arguments"]})
    return calls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://api.deepseek.com/v1/chat/completions")
    ap.add_argument("--model", default="deepseek-flash")
    ap.add_argument("--key-env", default="DEEPSEEK_API_KEY")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--base", default="origin/main")
    a = ap.parse_args()
    key = os.environ.get(a.key_env)
    if not key:
        sys.exit(f"Set {a.key_env}.")
    old = subprocess.run(["git", "show", f"{a.base}:src-tauri/src/agent/tools.rs"], capture_output=True, text=True, check=True).stdout
    new = open("src-tauri/src/agent/tools.rs").read()
    versions = {"old": schema_from(old), "new": schema_from(new)}
    totals = {"old": 0, "new": 0}
    for name, prompt, ok in SCENARIOS:
        for label, tool in versions.items():
            marks = []
            for _ in range(a.repeat):
                calls = ask(a.url, key, a.model, tool, prompt)
                passed = ok(calls)
                totals[label] += passed
                marks.append("✓" if passed else "✕")
                if not passed:
                    print(f"    {label} {name}: {json.dumps(calls)[:300]}")
            print(f"{name:16} {label}: {' '.join(marks)}")
    n = len(SCENARIOS) * a.repeat
    print(f"\n{a.model}: old {totals['old']}/{n}, new {totals['new']}/{n}")


if __name__ == "__main__":
    main()
