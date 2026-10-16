#!/usr/bin/env python3
"""Paired, live-model Hermes / KIDE harness benchmark. Standard library only.

Default is a no-inference preview. --run executes both harnesses on fresh copies.
Results preserve failures and unknown metrics; graders live outside workspaces.
"""
import argparse
import json
import os
from pathlib import Path
import random
import signal
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
TASKS = [
    {"id": "order-summary", "files": {"orders.json": json.dumps([
        {"customer": "Ada", "status": "paid", "cents": 1250},
        {"customer": "Lin", "status": "cancelled", "cents": 9000},
        {"customer": "Ada", "status": "refunded", "cents": 250},
        {"customer": "Lin", "status": "paid", "cents": 500},
        {"customer": "Ada", "status": "paid", "cents": 100},
        {"customer": "Zoe", "status": "paid", "cents": 0}])},
     "prompt": "Read orders.json and create summary.json as a JSON array sorted by customer. Each object must have exactly customer, net_cents, paid_count. Add paid cents, subtract refunded cents, ignore cancelled orders. Count only paid orders including zero values. Include customers with paid or refunded orders. Write the file and verify it.",
     "expected": [{"customer": "Ada", "net_cents": 1100, "paid_count": 2}, {"customer": "Lin", "net_cents": 500, "paid_count": 1}, {"customer": "Zoe", "net_cents": 0, "paid_count": 1}]},
    {"id": "slug-regression", "files": {"slug.py": 'def slugify(text):\n    return text.lower().replace(" ", "-")\n', "README.md": "Python standard library only. Public entry point: slug.slugify(text).\n"},
     "prompt": "Fix slug.py: slugify must lowercase, strip leading/trailing whitespace, replace each run of characters outside ASCII a-z and 0-9 with one hyphen, and strip leading/trailing hyphens. Empty or punctuation-only input returns an empty string. Preserve the public entry point. Verify the fix.",
     "cases": [[" Hello, WORLD! ", "hello-world"], ["a___b---c", "a-b-c"], ["...", ""], ["", ""], ["Version 2.0", "version-2-0"], ["café", "caf"], ["Already-ok", "already-ok"]]},
    {"id": "multi-file-export", "files": {"report.py": 'def total(rows):\n    return sum(row["amount"] for row in rows)\n', "main.py": 'import json\nfrom report import total\n\ndef render(rows):\n    return json.dumps({"total": total(rows)})\n'},
     "prompt": "Update report.total(rows) to sum only rows whose status is paid; missing status means pending, missing amount means zero. Do not mutate rows. Update main.render(rows) to return JSON with total and paid_count; paid_count counts all paid rows including missing or zero amounts. Preserve both public entry points and verify empty and mixed inputs.",
     "cases": [[[], {"total": 0, "paid_count": 0}], [[{"status": "paid", "amount": 4}, {"status": "pending", "amount": 99}, {"status": "paid"}, {"amount": 10}, {"status": "paid", "amount": -1}], {"total": 3, "paid_count": 3}]]},
]


def grade(task, workspace):
    """Run trusted assertions outside agent files, in a bounded child process."""
    if task["id"] == "order-summary":
        try:
            actual = json.loads((workspace / "summary.json").read_text())
            return {"passed": actual == task["expected"], "actual": actual}
        except (OSError, ValueError) as error:
            return {"passed": False, "error": str(error)}
    code = '''import copy, importlib.util, json, sys
from pathlib import Path
root = Path(sys.argv[1]); sys.path.insert(0, str(root))
def load(name):
    spec = importlib.util.spec_from_file_location(name, root / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
case = json.loads(sys.stdin.read())
if case['id'] == 'slug-regression':
    module = load('slug')
    for value, expected in case['cases']: assert module.slugify(value) == expected, repr(value)
else:
    report, main = load('report'), load('main')
    for rows, expected in case['cases']:
        before = copy.deepcopy(rows)
        assert report.total(rows) == expected['total']
        assert json.loads(main.render(rows)) == expected
        assert rows == before, 'Input mutated'
'''
    try:
        result = subprocess.run([sys.executable, "-I", "-c", code, str(workspace)], input=json.dumps(task), text=True, capture_output=True, timeout=10, cwd=tempfile.gettempdir())
        return {"passed": result.returncode == 0, "error": result.stderr[-4000:] or None}
    except subprocess.TimeoutExpired:
        return {"passed": False, "error": "Grader timed out"}


def execute(command, base, env, prompt=None, timeout=180):
    started = time.monotonic()
    try:
        with (base / "stdout.txt").open("w") as out, (base / "stderr.txt").open("w") as err:
            process = subprocess.Popen(command, stdin=subprocess.PIPE if prompt is not None else subprocess.DEVNULL,
                                       text=True, stdout=out, stderr=err, cwd=base / "workspace", env=env,
                                       start_new_session=True)
            try:
                process.communicate(input=prompt, timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                raise
            result = process
        return {"elapsedSeconds": time.monotonic() - started, "error": None if result.returncode == 0 else f"Process exited {result.returncode}"}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"elapsedSeconds": time.monotonic() - started, "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", default="openrouter", help="KIDE provider ID")
    parser.add_argument("--hermes-provider", help="Hermes backend ID, defaults to --provider (openai becomes openai-api)")
    parser.add_argument("--model", required=True, help="Identical model ID for both harnesses")
    parser.add_argument("--hermes", default="hermes")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run", action="store_true", help="Execute model calls (may incur provider charges)")
    args = parser.parse_args()
    if args.repeats < 1 or args.timeout < 1:
        parser.error("repeats and timeout must be positive")
    backend = args.hermes_provider or {"openai": "openai-api"}.get(args.provider, args.provider)
    manifest = {"benchmark": "kide-hermes-synthetic-v1", "provider": args.provider, "hermesProvider": backend, "model": args.model, "repeats": args.repeats, "timeoutSeconds": args.timeout, "seed": args.seed, "tasks": [t["id"] for t in TASKS], "limits": ["Synthetic tasks, not a coding quality leaderboard", "Each harness keeps its native tools and prompt", "Hermes CLI metrics unavailable to this runner remain null", "Full-auto native execution; fresh Hermes home per trial; no human answers", "Hermes uses CLI oneshot here; ACP transport is tested separately"]}
    if not args.run:
        print(json.dumps({"preview": True, **manifest}, indent=2)); return
    output = (args.output or Path(tempfile.mkdtemp(prefix="kide-hermes-bench-"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    # Compile before timing trials. This test drives KIDE's real Rust loop.
    subprocess.run(["cargo", "test", "--manifest-path", str(REPO / "src-tauri/Cargo.toml"), "--lib", "paired_harness_benchmark", "--no-run"], check=True, cwd=REPO)
    rng, results = random.Random(args.seed), []
    for repeat in range(args.repeats):
        for task in TASKS:
            order = ["native", "hermes"]; rng.shuffle(order)
            for harness in order:
                base = output / f"{task['id']}-{repeat}-{harness}"
                workspace = base / "workspace"; workspace.mkdir(parents=True, exist_ok=False)
                for name, contents in task["files"].items(): (workspace / name).write_text(contents)
                case = {"provider": args.provider, "model": args.model, "prompt": task["prompt"], "timeoutSeconds": args.timeout}
                (base / "case.json").write_text(json.dumps(case, indent=2))
                env = os.environ.copy()
                # Keep Hermes memories, sessions, skills and config out of
                # repeated trials and out of the user's ordinary Hermes home.
                home = base / "hermes-home"; home.mkdir()
                env["HERMES_HOME"] = str(home)
                env.pop("HERMES_PROFILE", None)
                env.pop("HERMES_CONFIG_PATH", None)
                env.pop("HERMES_ENV_PATH", None)
                env.pop("HERMES_CONFIG", None)
                env.pop("HERMES_ENV", None)
                (home / "config.yaml").write_text(json.dumps({"model": {"provider": backend, "default": args.model}, "terminal": {"backend": "local"}, "memory": {"memory_enabled": False, "user_profile_enabled": False}}))
                if harness == "native":
                    env["KLIDE_BENCH_CASE"] = str(base)
                    measured = execute(["cargo", "test", "--manifest-path", str(REPO / "src-tauri/Cargo.toml"), "--lib", "paired_harness_benchmark", "--", "--ignored", "--exact", "agent::live_eval::paired_harness_benchmark", "--nocapture"], base, env, timeout=args.timeout + 60)
                    if (base / "native-result.json").exists(): measured.update(json.loads((base / "native-result.json").read_text()))
                    elif not measured["error"]: measured["error"] = "Native benchmark produced no result"
                else:
                    # A new HERMES_HOME may bootstrap dependencies. Perform
                    # that setup outside timing, just as native compilation is.
                    try:
                        ready = subprocess.run([args.hermes, "acp", "--check"], env=env, cwd=workspace,
                                               capture_output=True, text=True, timeout=180)
                        if ready.returncode:
                            (base / "setup-stderr.txt").write_text(ready.stderr)
                            measured = {"elapsedSeconds": None, "error": "Hermes setup failed; see setup-stderr.txt"}
                        else:
                            measured = execute([args.hermes, "chat", "--quiet", "--oneshot", "--provider", backend, "--model", args.model, "--query-file", "-"], base, env, task["prompt"], args.timeout)
                    except (OSError, subprocess.TimeoutExpired) as error:
                        measured = {"elapsedSeconds": None, "error": f"Hermes setup failed: {error}"}
                record = {"task": task["id"], "repeat": repeat, "harness": harness, "inputTokens": None, "outputTokens": None, "costUsd": None, "toolCalls": None, "humanInterventions": 0, **measured, "grading": grade(task, workspace)}
                record["passed"] = not record["error"] and record["grading"]["passed"]
                results.append(record)
                (output / "results.json").write_text(json.dumps(results, indent=2))
                print(f"{harness}: {task['id']} repeat {repeat + 1}: {'PASS' if record['passed'] else 'FAIL'}", flush=True)
    print(f"Results: {output / 'results.json'}")


if __name__ == "__main__":
    main()
