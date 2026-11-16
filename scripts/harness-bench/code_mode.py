#!/usr/bin/env python3
"""Context-saving rungs benchmark — the same read tasks with plain reads only,
with `read_many` (a batch-read form) and with `run_script` (Code Mode), on the
real native Harness. Standard library only.

Default is a no-inference preview of the manifest. --run executes trials, which
makes paid provider calls. Every trial is kept, failures included.

Arms: `off` (plain reads), `batch` (+ read_many, KLIDE_READ_MANY=1) and
`script` (+ run_script, KLIDE_CODE_MODE=force so local models get it too). The
Rust entry point reads each arm back from the Harness gate and the trial is
invalid if it does not match. Every arm runs in Plan mode: reads only, no
shell, no edits.

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
ARMS = ("off", "batch", "script")
ARM_ENV = {"off": {"KLIDE_CODE_MODE": "0", "KLIDE_READ_MANY": "0"},
           "batch": {"KLIDE_CODE_MODE": "0", "KLIDE_READ_MANY": "1"},
           "script": {"KLIDE_CODE_MODE": "force", "KLIDE_READ_MANY": "0"}}
ARM_GATE = {"off": (False, False), "batch": (False, True), "script": (True, False)}

# Written before any trial ran. The report evaluates it as stated.
DECISION_RULE = {
    "scope": "scaling tasks: rollup-25, rollup-100, audit-40; each arm judged against off",
    "keep_if": [
        "pooled median cost per trial is at least 20% lower than off (uncached input tokens when the provider reports no cost, e.g. a local model)",
        "pass count is not lower than off",
        "pooled median elapsed time is at most 10% higher than off",
    ],
    "otherwise": "script: revert PR #524; batch: drop the read_many prototype",
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
    """The task's files. `.klide/` is the Harness's own state (the
    coordination journal registers every Run), not something the agent did."""
    h = hashlib.sha256()
    for path in sorted(p for p in workspace.rglob("*") if p.is_file() and ".klide" not in p.relative_to(workspace).parts):
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


def uncached(r):
    return r["inputTokens"] - (r.get("cacheReadTokens") or 0) if isinstance(r.get("inputTokens"), int) else None


def arm_stats(trials):
    return {
        "trials": len(trials),
        "passed": sum(1 for r in trials if r["passed"]),
        "medianCostUsd": median([r.get("costUsd") for r in trials]),
        "medianUncachedInputTokens": median([uncached(r) for r in trials]),
        "medianOutputTokens": median([r.get("outputTokens") for r in trials]),
        "medianModelRequests": median([r.get("modelRequests") for r in trials]),
        "medianElapsedSeconds": median([r.get("elapsedSeconds") for r in trials]),
        "trialsUsingTool": sum(1 for r in trials if (r.get("scriptCalls") or 0) + (r.get("readManyCalls") or 0) > 0),
    }


SCALING = {"rollup-25", "rollup-100", "audit-40"}


def summarize(results, tasks):
    arms = [a for a in ARMS if any(r["arm"] == a for r in results)] or list(ARMS)
    rows = []
    for task in tasks:
        row = {"task": task["id"]}
        for arm in arms:
            row[arm] = arm_stats([r for r in results if r["task"] == task["id"] and r["arm"] == arm])
        rows.append(row)
    pooled = {arm: arm_stats([r for r in results if r["task"] in SCALING and r["arm"] == arm]) for arm in arms}
    scaling = [r for r in results if r["task"] in SCALING]
    # Cost when every scaling trial has one; otherwise (a local model) uncached input.
    metric = "medianCostUsd" if scaling and all(isinstance(r.get("costUsd"), (int, float)) for r in scaling) else "medianUncachedInputTokens"
    verdicts = {}
    for arm in arms:
        if arm == "off":
            continue
        base, test = pooled.get("off"), pooled[arm]
        if not base or not base["trials"] or not test["trials"]:
            verdicts[arm] = {"verdict": None}
            continue
        saving = change(base[metric], test[metric])
        elapsed = change(base["medianElapsedSeconds"], test["medianElapsedSeconds"])
        checks = {"20% saving": saving is not None and saving <= -0.20,
                  "pass count not lower": test["passed"] >= base["passed"],
                  "elapsed at most 10% higher": elapsed is not None and elapsed <= 0.10}
        verdicts[arm] = {"verdict": "keep" if all(checks.values()) else "drop", "saving": saving,
                         "elapsedChange": elapsed, "checks": checks}
    return {"arms": arms, "metric": metric, "tasks": rows, "scalingPooled": pooled, "verdicts": verdicts}


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
    arms, metric = summary["arms"], summary["metric"]
    unit = "usd" if metric == "medianCostUsd" else "n"
    lines = [f"# Context-saving rungs — {manifest['startedAt'][:10]}", "",
             f"Model `{manifest['model']}` on `{manifest['provider']}`, {manifest['repeats']} repeats, seed {manifest['seed']}, "
             f"context {manifest['numCtx']}, source `{manifest['sourceRevision']}`{' (dirty)' if manifest['sourceDirty'] else ''}.", "",
             f"Saving measured as {'cost' if unit == 'usd' else 'uncached input tokens'}.", ""]
    for arm, v in summary["verdicts"].items():
        if v["verdict"] is None:
            lines.append(f"- **{arm}: incomplete**")
            continue
        marks = ", ".join(f"{'✓' if ok else '✗'} {name}" for name, ok in v["checks"].items())
        lines.append(f"- **{arm}: {v['verdict']}** — saving {fmt(v['saving'], 'pct')}, time {fmt(v['elapsedChange'], 'pct')} ({marks})")
    pooled = summary["scalingPooled"]
    lines += ["", "Scaling tasks pooled, passed: " + ", ".join(f"{a} {pooled[a]['passed']}/{pooled[a]['trials']}" for a in arms) + ".", ""]
    header = "| Task | " + " | ".join(f"{a} pass | {a} {'cost' if unit == 'usd' else 'uncached in'} | {a} time | {a} req" for a in arms) + " |"
    lines += [header, "| --- |" + " ---: | ---: | ---: | ---: |" * len(arms)]
    for row in summary["tasks"]:
        cells = []
        for a in arms:
            st = row[a]
            cells.append(f"{st['passed']}/{st['trials']} | {fmt(st[metric], unit)} | {fmt(st['medianElapsedSeconds'], 's')} | {fmt(st['medianModelRequests'], 'n')}")
        lines.append(f"| {row['task']} | " + " | ".join(cells) + " |")
    lines += ["", "## Every trial", "", "| Task | Repeat | Arm | Pass | Requests | Batch calls | Scripts | Nested reads | Cost USD | Uncached input | Time s | Error |",
              "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"]
    for r in results:
        lines.append(f"| {r['task']} | {r['repeat'] + 1} | {r['arm']} | {'yes' if r['passed'] else 'no'} | {fmt(r.get('modelRequests'), 'n')} | "
                     f"{fmt(r.get('readManyCalls'), 'n')} | {fmt(r.get('scriptCalls'), 'n')} | {fmt(r.get('nestedToolCalls'), 'n')} | "
                     f"{fmt(r.get('costUsd'), 'usd')} | {fmt(uncached(r), 'n')} | {fmt(r.get('elapsedSeconds'), 's')} | "
                     f"{(r.get('error') or '').replace('|', '/')[:80]} |")
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
    parser.add_argument("--arm", action="append", choices=ARMS, help="Run only these arms (repeatable; off is always kept as the baseline)")
    parser.add_argument("--num-ctx", type=int, default=65536)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run", action="store_true", help="Execute trials (paid provider calls)")
    args = parser.parse_args(argv)
    if args.repeats < 1:
        parser.error("repeats must be positive")
    arms = list(ARMS) if not args.arm else ["off"] + [a for a in ARMS if a in args.arm and a != "off"]
    tasks = all_tasks(args.seed)
    if args.task:
        unknown = set(args.task) - {t["id"] for t in tasks}
        if unknown:
            parser.error(f"Unknown task ids: {', '.join(sorted(unknown))}")
        tasks = [t for t in tasks if t["id"] in args.task]
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True)
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True)
    manifest = {
        "benchmark": "klide-context-rungs-v1", "provider": args.provider, "model": args.model,
        "repeats": args.repeats, "seed": args.seed, "arms": arms, "mode": "plan",
        "numCtx": args.num_ctx, "numPredict": 2048, "reflectionLevel": "off", "maxParallelTools": 4,
        "tasks": [{"id": t["id"], "files": len(t["files"]), "bytes": sum(len(v) for v in t["files"].values()),
                   "maxTurns": t["maxTurns"], "timeoutSeconds": t["timeoutSeconds"], "origin": t["origin"]} for t in tasks],
        "decisionRule": DECISION_RULE,
        "sourceRevision": revision.stdout.strip() if revision.returncode == 0 else None,
        "sourceDirty": bool(dirty.stdout.strip()) if dirty.returncode == 0 else None,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "machine": {"system": platform.system(), "architecture": platform.machine()},
        "limits": [
            "One model per run; a result says nothing about other models",
            "Synthetic read-only tasks in Plan mode; not a coding-quality measure",
            "The batch and script Tools are offered, not forced: those arms may still choose plain reads",
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
            order = list(arms)
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
                env.update(ARM_ENV[arm])
                measured = execute(cargo + ["--", "--ignored", "--exact", TEST, "--nocapture"], base, env,
                                   timeout=task["timeoutSeconds"] + 60)
                measured = read_native_result(base, measured)
                gate = (measured.get("codeModeOffered"), measured.get("readManyOffered"))
                if None not in gate and gate != ARM_GATE[arm]:
                    measured["error"] = measured.get("error") or f"Arm mismatch: gate offered (run_script, read_many) = {gate}"
                record = {"task": task["id"], "repeat": repeat, "arm": arm, **measured,
                          "grading": grade(task, workspace, before, measured.get("finalAnswer"))}
                record["passed"] = not record.get("error") and record["grading"]["passed"]
                results.append(record)
                (output / "results.json").write_text(json.dumps(results, indent=2))
                write_report(output, manifest, results, tasks)
                print(f"{task['id']} repeat {repeat + 1} {arm}: {'PASS' if record['passed'] else 'FAIL'}"
                      f" cost={fmt(record.get('costUsd'), 'usd')} time={fmt(record.get('elapsedSeconds'), 's')}"
                      f" batch={record.get('readManyCalls')} scripts={record.get('scriptCalls')}", flush=True)
    summary = write_report(output, manifest, results, tasks)
    print(f"Report: {output / 'REPORT.md'}  verdicts: " + ", ".join(f"{a}={v['verdict']}" for a, v in summary['verdicts'].items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
