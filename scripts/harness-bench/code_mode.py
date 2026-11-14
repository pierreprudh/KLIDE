#!/usr/bin/env python3
"""Code Mode on/off benchmark — the same read tasks with `run_script` offered
and not offered, on the real native Harness. Standard library only.

Default is a no-inference preview of the manifest. --run executes trials, which
makes paid provider calls. Every trial is kept, failures included.

Arms: `off` (KLIDE_CODE_MODE=0) and `on` (KLIDE_CODE_MODE=1). The Rust entry
point reads the arm back from the Harness gate and the trial is invalid if it
does not match. Both arms run in Plan mode: reads only, no shell, no edits.

Tasks: the three 2026-10-30 tasks verbatim from the archive (controls and
continuity with READ_SCRIPT_RESULTS.md), the same rollup at 25 and 100 files
(where batching should pay off, if anywhere), and an every-item audit where
one missed file fails the answer.
"""
import argparse
import hashlib
import json
import os
import platform
import random
import statistics
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from run import execute, read_native_result  # noqa: E402
REPO = HERE.parents[1]
ARCHIVE = HERE / "read-script-2026-10-30-data.json"
TEST = "agent::live_eval::code_mode_benchmark"
ARMS = ("off", "on")

# Written before any trial ran. The report evaluates it as stated.
DECISION_RULE = {
    "scope": "scaling tasks: rollup-25, rollup-100, audit-40",
    "keep_if": [
        "pooled median cost per trial with Code Mode on is at least 20% lower than off",
        "pass count with Code Mode on is not lower than off",
        "pooled median elapsed time with Code Mode on is at most 10% higher than off",
    ],
    "otherwise": "revert PR #524",
}

NOTE = "Synthetic irrelevant description " * 3


def archived_tasks():
    data = json.loads(ARCHIVE.read_text())
    tasks = []
    for fixture in data["fixtures"]:
        tasks.append({"id": fixture["id"], "files": fixture["files"], "prompt": fixture["prompt"],
                      "expected": fixture["expected"], "maxTurns": 12, "timeoutSeconds": 120,
                      "origin": "archive-2026-10-30"})
    return tasks


def rollup_task(files, seed):
    """The archived multi-read-rollup shape, at `files` batches."""
    rng = random.Random(seed)
    names = [f"batch-{i}.json" for i in range(files)]
    contents = {"index.json": json.dumps({"batches": names}, indent=2)}
    active_count = active_cents = 0
    for i, name in enumerate(names):
        rows = []
        for j in range(8):
            active = rng.random() < 0.6
            cents = rng.randint(-50, 100)
            rows.append({"id": f"record-{i}-{j}", "active": active, "cents": cents, "note": NOTE})
            if active:
                active_count += 1
                active_cents += cents
        contents[name] = json.dumps(rows, indent=2)
    # Decoys outside the index must be ignored.
    contents["batch-unlisted.json"] = json.dumps([{"id": "decoy", "active": True, "cents": 100000, "note": NOTE}], indent=2)
    return {"id": f"rollup-{files}", "files": contents,
            "prompt": ("Read index.json and every batch it lists. Return exactly {\"files\":N,\"active_count\":N,\"active_cents\":N}: "
                       "number of listed batches, count and sum cents for rows whose active is true across those batches. "
                       "Include zero and negative values. Ignore notes and any file index.json does not list. Inspect every listed file."),
            "expected": {"files": files, "active_count": active_count, "active_cents": active_cents},
            "maxTurns": 24, "timeoutSeconds": 300, "origin": "generated"}


def audit_task(services, seed):
    """Every item must be checked; missing one file fails the answer."""
    rng = random.Random(seed)
    flagged = []
    contents = {}
    for i in range(services):
        name = f"svc-{i:02d}"
        config = {"name": name, "enabled": rng.random() < 0.7, "timeout_ms": rng.choice([5000, 15000, 30000, 30001, 45000, 60000]),
                  "retries": rng.randint(0, 5), "notes": ["Unrelated fixture text"] * 6}
        if rng.random() < 0.6:
            config["owner"] = rng.choice(["payments", "search", "growth", "infra"])
        contents[f"services/{name}.json"] = json.dumps(config, indent=2)
        if config["enabled"] and config["timeout_ms"] > 30000 and "owner" not in config:
            flagged.append(name)
    return {"id": f"audit-{services}", "files": contents,
            "prompt": ("Check every file in services/. A service is flagged when enabled is true AND timeout_ms is greater than 30000 "
                       "AND it has no owner field. Return exactly {\"checked\":N,\"flagged\":[...]}: how many service files you checked, "
                       "and the flagged service names sorted alphabetically. Inspect every file; do not guess."),
            "expected": {"checked": services, "flagged": sorted(flagged)},
            "maxTurns": 24, "timeoutSeconds": 300, "origin": "generated"}


def all_tasks(seed):
    return archived_tasks() + [rollup_task(25, seed + 1), rollup_task(100, seed + 2), audit_task(40, seed + 3)]


def digest(workspace):
    h = hashlib.sha256()
    for path in sorted(p for p in workspace.rglob("*") if p.is_file()):
        h.update(str(path.relative_to(workspace)).encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def last_json_object(text):
    """The final JSON object in an answer, fences and prose around it ignored."""
    if not text:
        return None
    decoder = json.JSONDecoder()
    found = None
    for i, ch in enumerate(text):
        if ch == "{":
            try:
                value, _ = decoder.raw_decode(text[i:])
            except ValueError:
                continue
            if isinstance(value, dict):
                found = value
    return found


def grade(task, workspace, before, answer):
    actual = last_json_object(answer)
    unchanged = digest(workspace) == before
    correct = actual == task["expected"]
    return {"passed": correct and unchanged, "answerCorrect": correct, "workspaceUnchanged": unchanged,
            "actual": actual, "expected": task["expected"]}


def median(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return statistics.median(values) if values else None


def change(off, on):
    if off in (None, 0) or on is None:
        return None
    return (on - off) / off


def summarize(results, tasks):
    rows = []
    for task in tasks:
        row = {"task": task["id"]}
        for arm in ARMS:
            trials = [r for r in results if r["task"] == task["id"] and r["arm"] == arm]
            row[arm] = {
                "trials": len(trials),
                "passed": sum(1 for r in trials if r["passed"]),
                "medianCostUsd": median([r.get("costUsd") for r in trials]),
                "medianUncachedInputTokens": median([r["inputTokens"] - (r.get("cacheReadTokens") or 0)
                                                     for r in trials if isinstance(r.get("inputTokens"), int)]),
                "medianOutputTokens": median([r.get("outputTokens") for r in trials]),
                "medianModelRequests": median([r.get("modelRequests") for r in trials]),
                "medianElapsedSeconds": median([r.get("elapsedSeconds") for r in trials]),
                "trialsUsingScripts": sum(1 for r in trials if (r.get("scriptCalls") or 0) > 0),
            }
        row["costChange"] = change(row["off"]["medianCostUsd"], row["on"]["medianCostUsd"])
        row["elapsedChange"] = change(row["off"]["medianElapsedSeconds"], row["on"]["medianElapsedSeconds"])
        rows.append(row)
    scaling = {"rollup-25", "rollup-100", "audit-40"}
    pooled = {}
    for arm in ARMS:
        trials = [r for r in results if r["task"] in scaling and r["arm"] == arm]
        pooled[arm] = {"trials": len(trials), "passed": sum(1 for r in trials if r["passed"]),
                       "medianCostUsd": median([r.get("costUsd") for r in trials]),
                       "medianElapsedSeconds": median([r.get("elapsedSeconds") for r in trials])}
    cost = change(pooled["off"]["medianCostUsd"], pooled["on"]["medianCostUsd"])
    elapsed = change(pooled["off"]["medianElapsedSeconds"], pooled["on"]["medianElapsedSeconds"])
    complete = all(pooled[a]["trials"] > 0 for a in ARMS)
    checks = {"cost at least 20% lower": cost is not None and cost <= -0.20,
              "pass count not lower": pooled["on"]["passed"] >= pooled["off"]["passed"],
              "elapsed at most 10% higher": elapsed is not None and elapsed <= 0.10}
    verdict = None if not complete else ("keep" if all(checks.values()) else "revert")
    return {"tasks": rows, "scalingPooled": pooled, "scalingCostChange": cost,
            "scalingElapsedChange": elapsed, "ruleChecks": checks, "verdict": verdict}


def fmt(value, kind):
    if value is None:
        return "—"
    if kind == "usd":
        return f"${value:.6f}"
    if kind == "pct":
        return f"{value * 100:+.1f}%"
    if kind == "s":
        return f"{value:.2f} s"
    return f"{value:g}"


def write_report(output, manifest, results, tasks):
    summary = summarize(results, tasks)
    (output / "summary.json").write_text(json.dumps(summary, indent=2))
    lines = [f"# Code Mode on/off — {manifest['startedAt'][:10]}", "",
             f"Model `{manifest['model']}` on `{manifest['provider']}`, {manifest['repeats']} repeats, seed {manifest['seed']}, "
             f"source `{manifest['sourceRevision']}`{' (dirty)' if manifest['sourceDirty'] else ''}.", "",
             f"**Verdict by the pre-registered rule: {summary['verdict'] or 'incomplete'}**", ""]
    for name, ok in summary["ruleChecks"].items():
        lines.append(f"- {'✓' if ok else '✗'} {name}")
    lines += ["", f"Scaling tasks pooled: cost {fmt(summary['scalingCostChange'], 'pct')}, "
                  f"elapsed {fmt(summary['scalingElapsedChange'], 'pct')}, passed "
                  f"{summary['scalingPooled']['off']['passed']}/{summary['scalingPooled']['off']['trials']} off → "
                  f"{summary['scalingPooled']['on']['passed']}/{summary['scalingPooled']['on']['trials']} on.", "",
              "| Task | Passed off → on | Median cost off | on | Δ | Median time off | on | Δ | Requests off → on | Uncached input off → on | Used scripts |",
              "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for row in summary["tasks"]:
        off, on = row["off"], row["on"]
        lines.append(f"| {row['task']} | {off['passed']}/{off['trials']} → {on['passed']}/{on['trials']} | "
                     f"{fmt(off['medianCostUsd'], 'usd')} | {fmt(on['medianCostUsd'], 'usd')} | {fmt(row['costChange'], 'pct')} | "
                     f"{fmt(off['medianElapsedSeconds'], 's')} | {fmt(on['medianElapsedSeconds'], 's')} | {fmt(row['elapsedChange'], 'pct')} | "
                     f"{fmt(off['medianModelRequests'], 'n')} → {fmt(on['medianModelRequests'], 'n')} | "
                     f"{fmt(off['medianUncachedInputTokens'], 'n')} → {fmt(on['medianUncachedInputTokens'], 'n')} | "
                     f"{on['trialsUsingScripts']}/{on['trials']} |")
    lines += ["", "## Every trial", "", "| Task | Repeat | Arm | Pass | Requests | Scripts | Nested reads | Cost USD | Time s | Error |",
              "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |"]
    for r in results:
        lines.append(f"| {r['task']} | {r['repeat'] + 1} | {r['arm']} | {'yes' if r['passed'] else 'no'} | {fmt(r.get('modelRequests'), 'n')} | "
                     f"{fmt(r.get('scriptCalls'), 'n')} | {fmt(r.get('nestedToolCalls'), 'n')} | {fmt(r.get('costUsd'), 'usd')} | "
                     f"{fmt(r.get('elapsedSeconds'), 's')} | {(r.get('error') or '').replace('|', '/')[:80]} |")
    lines += ["", "## Limits", ""] + [f"- {item}" for item in manifest["limits"]]
    (output / "REPORT.md").write_text("\n".join(lines) + "\n")
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--provider", default="openrouter")
    parser.add_argument("--model", default="deepseek/deepseek-v4.1-flash-1017")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--task", action="append", help="Run only these task ids (repeatable)")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run", action="store_true", help="Execute trials (paid provider calls)")
    args = parser.parse_args(argv)
    if args.repeats < 1:
        parser.error("repeats must be positive")
    tasks = all_tasks(args.seed)
    if args.task:
        unknown = set(args.task) - {t["id"] for t in tasks}
        if unknown:
            parser.error(f"Unknown task ids: {', '.join(sorted(unknown))}")
        tasks = [t for t in tasks if t["id"] in args.task]
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True)
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True)
    manifest = {
        "benchmark": "klide-code-mode-v1", "provider": args.provider, "model": args.model,
        "repeats": args.repeats, "seed": args.seed, "arms": list(ARMS), "mode": "plan",
        "numCtx": 65536, "numPredict": 2048, "reflectionLevel": "off", "maxParallelTools": 4,
        "tasks": [{"id": t["id"], "files": len(t["files"]), "bytes": sum(len(v) for v in t["files"].values()),
                   "maxTurns": t["maxTurns"], "timeoutSeconds": t["timeoutSeconds"], "origin": t["origin"]} for t in tasks],
        "decisionRule": DECISION_RULE,
        "sourceRevision": revision.stdout.strip() if revision.returncode == 0 else None,
        "sourceDirty": bool(dirty.stdout.strip()) if dirty.returncode == 0 else None,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "machine": {"system": platform.system(), "architecture": platform.machine()},
        "limits": [
            "One hosted model (chosen for price); says nothing about stronger models or local ones",
            "Synthetic read-only tasks in Plan mode; not a coding-quality measure",
            "Code Mode is offered, not forced: the on arm may still choose direct reads",
            "Provider caches are not reset; cached input is reported separately, not controlled",
            "Arm order randomized per task and repeat with the stated seed; failures kept in every median",
            "Debug-build Harness timing; compilation and UI start excluded",
        ],
    }
    if not args.run:
        print(json.dumps({"preview": True, **manifest}, indent=2))
        return 0
    output = (args.output or Path(tempfile.mkdtemp(prefix="klide-code-mode-bench-"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any((output / n).exists() for n in ("manifest.json", "results.json")):
        parser.error("Output holds an earlier run; choose a fresh directory")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    cargo = ["cargo", "test", "--manifest-path", str(REPO / "src-tauri/Cargo.toml"), "--lib", "code_mode_benchmark"]
    try:
        subprocess.run(cargo + ["--no-run"], check=True, cwd=REPO)
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        return 1
    rng, results = random.Random(args.seed), []
    for repeat in range(args.repeats):
        for task in tasks:
            order = list(ARMS)
            rng.shuffle(order)
            for arm in order:
                base = output / f"{task['id']}-{repeat}-{arm}"
                workspace = base / "workspace"
                workspace.mkdir(parents=True, exist_ok=False)
                for name, contents in task["files"].items():
                    (workspace / name).parent.mkdir(parents=True, exist_ok=True)
                    (workspace / name).write_text(contents)
                before = digest(workspace)
                case = {"provider": args.provider, "model": args.model, "prompt": task["prompt"],
                        "timeoutSeconds": task["timeoutSeconds"], "maxTurns": task["maxTurns"],
                        "numCtx": manifest["numCtx"], "numPredict": manifest["numPredict"],
                        "reflectionLevel": manifest["reflectionLevel"], "maxParallelTools": manifest["maxParallelTools"]}
                (base / "case.json").write_text(json.dumps(case, indent=2))
                env = os.environ.copy()
                env["KLIDE_BENCH_CASE"] = str(base)
                env["KLIDE_CODE_MODE"] = "1" if arm == "on" else "0"
                measured = execute(cargo + ["--", "--ignored", "--exact", TEST, "--nocapture"], base, env,
                                   timeout=task["timeoutSeconds"] + 60)
                measured = read_native_result(base, measured)
                if measured.get("codeModeOffered") is not None and measured["codeModeOffered"] != (arm == "on"):
                    measured["error"] = measured.get("error") or f"Arm mismatch: gate offered Code Mode = {measured['codeModeOffered']}"
                record = {"task": task["id"], "repeat": repeat, "arm": arm, **measured,
                          "grading": grade(task, workspace, before, measured.get("finalAnswer"))}
                record["passed"] = not record.get("error") and record["grading"]["passed"]
                results.append(record)
                (output / "results.json").write_text(json.dumps(results, indent=2))
                write_report(output, manifest, results, tasks)
                print(f"{task['id']} repeat {repeat + 1} {arm}: {'PASS' if record['passed'] else 'FAIL'}"
                      f" cost={fmt(record.get('costUsd'), 'usd')} time={fmt(record.get('elapsedSeconds'), 's')}"
                      f" scripts={record.get('scriptCalls')}", flush=True)
    summary = write_report(output, manifest, results, tasks)
    print(f"Report: {output / 'REPORT.md'}  verdict: {summary['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
