"""Summarize repeated Harness trials without turning absent evidence into a pass."""
import json
import math
from pathlib import Path
import statistics


def metric(rows, key):
    values = [r.get(key) for r in rows]
    known = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0]
    return {"samples": len(known), "median": statistics.median(known) if known else None}


def summarize(manifest, results, setup_error=None):
    groups = []
    expected = len(manifest["tasks"]) * len(manifest["harnesses"]) * manifest["repeats"]
    valid = {(task, harness, repeat) for task in manifest["tasks"] for harness in manifest["harnesses"] for repeat in range(manifest["repeats"])}
    seen = [(r.get("task"), r.get("harness"), r.get("repeat")) for r in results]
    complete = len(seen) == expected and len(set(seen)) == expected and set(seen) == valid
    for task in manifest["tasks"]:
        for harness in manifest["harnesses"]:
            rows = [r for r in results if r.get("task") == task and r.get("harness") == harness]
            passed = [r for r in rows if r.get("passed") is True and not r.get("error") and r.get("grading", {}).get("passed") is True]
            groups.append({"task": task, "harness": harness, "expected": manifest["repeats"], "completed": len(rows),
                           "passed": len(passed), "failed": len(rows) - len(passed),
                           "successfulTrials": {key: metric(passed, key) for key in
                                                ("elapsedSeconds", "inputTokens", "outputTokens", "costUsd", "enginePromptMs", "engineGenerationMs")}})
    all_passed = complete and all(g["passed"] == g["expected"] for g in groups) and not setup_error
    return {"schema": "klide/model-verification/1", "status": "passed" if all_passed else "failed" if complete else "incomplete",
            "expectedTrials": expected, "recordedTrials": len(results), "setupError": setup_error,
            "configuration": {key: manifest.get(key) for key in ("benchmark", "provider", "model", "sourceRevision", "sourceDirty", "engineVersion", "modelRevision", "recipeUrl", "cacheCondition", "machine")},
            "tasks": groups,
            "limits": ["Passing this synthetic suite does not establish general coding quality or full desktop acceptance.",
                       "Timings summarize successful trials only; failures remain in results.json.",
                       "Engine prompt/generation durations are reported only when the provider supplies every turn's measurement.",
                       "Cache state is uncontrolled. Do not compare these timings as a cold/warm engine ranking."]}


def write_report(output, manifest, results, setup_error=None):
    report = summarize(manifest, results, setup_error)
    output = Path(output)
    temporary = output / "report.json.tmp"
    temporary.write_text(json.dumps(report, indent=2))
    temporary.replace(output / "report.json")
    lines = ["# Klide model verification", "", f"Status: **{report['status']}** · {len(results)}/{report['expectedTrials']} trials recorded", "",
             f"Provider: `{manifest['provider']}` · Model: `{manifest['model']}`", "",
             "| Task | Harness | Passed / expected | Failed | Median successful time |", "| --- | --- | --- | --- | --- |"]
    for group in report["tasks"]:
        duration = group["successfulTrials"]["elapsedSeconds"]["median"]
        lines.append(f"| {group['task']} | {group['harness']} | {group['passed']} / {group['expected']} | {group['failed']} | {'—' if duration is None else f'{duration:.2f} s'} |")
    lines.extend(["", *report["limits"], "", "Inspect manifest.json, results.json and each native transcript for configuration and evidence."])
    (output / "REPORT.md").write_text("\n".join(lines) + "\n")
    return report
