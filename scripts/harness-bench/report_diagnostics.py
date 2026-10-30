#!/usr/bin/env python3
"""Summarize native Harness transcripts without printing conversation content."""
import argparse
from collections import Counter
import json
from pathlib import Path
import statistics


def measured(values):
    known = [value for value in values if value is not None]
    return {"samples": len(known), "total": sum(known) if known else None,
            "median": statistics.median(known) if known else None}


def summarize(lines):
    turns, failures = [], 0
    provider = model = None
    for line in lines:
        if line.get("schemaVersion", 1) != 1:
            raise ValueError("Unsupported transcript schema version")
        event = line["event"]
        kind = event.get("type")
        if kind == "run_started":
            provider, model = event.get("provider"), event.get("model")
        elif kind == "route_locked":
            model = event.get("model")
        elif kind == "run_error":
            failures += 1
        elif kind == "assistant_message" and event.get("timing") is not None:
            timing, usage = event["timing"], event.get("usage") or {}
            diagnostic = timing.get("diagnostics")
            prompt, read = usage.get("promptTokens"), usage.get("cacheReadTokens")
            turns.append({"runId": line.get("runId"), "seq": line.get("seq"),
                          "provider": provider, "model": model,
                          "modelMs": timing.get("modelMs"), "ttftMs": timing.get("ttftMs"),
                          "promptTokens": prompt, "completionTokens": usage.get("completionTokens"),
                          "cacheReadTokens": read, "cacheWriteTokens": usage.get("cacheWriteTokens"),
                          "costUsd": usage.get("costUsd"),
                          "cacheReadShare": read / prompt if prompt and read is not None else None,
                          "diagnostics": diagnostic})
    pairs = [turn for turn in turns if turn["cacheReadShare"] is not None]
    diagnostics = [turn["diagnostics"] for turn in turns if turn["diagnostics"] is not None]
    setups = [item["setup"] for item in diagnostics if item.get("setup") is not None]
    return {
        "providerTurns": len(turns), "runErrors": failures,
        "diagnosedTurns": len(diagnostics),
        "cache": {
            "knownReadShareTurns": len(pairs),
            "unknownReadShareTurns": len(turns) - len(pairs),
            "meanRequestReadShare": statistics.mean(t["cacheReadShare"] for t in pairs) if pairs else None,
            "tokenWeightedReadShare": (sum(t["cacheReadTokens"] for t in pairs) /
                                       sum(t["promptTokens"] for t in pairs)) if pairs else None,
        },
        "metrics": {key: measured(turn[key] for turn in turns) for key in
                    ("modelMs", "ttftMs", "promptTokens", "completionTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd")},
        "preparation": {
            "setup": {key: measured(item.get(key) for item in setups) for key in
                      ("contextGatherMs", "toolCatalogMs", "historyReplayMs", "capabilitiesMs")},
            "inputBuildMs": measured(item.get("inputBuildMs") for item in diagnostics),
            "inspectionMs": measured(item.get("inspectionMs") for item in diagnostics),
            "attempts": measured(item.get("attempts") for item in diagnostics),
        },
        "promptChanges": dict(Counter(item["prompt"]["change"] for item in diagnostics)),
        "turns": turns,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcripts", type=Path, nargs="+")
    args = parser.parse_args()
    # Summarize each file separately so Provider identity never leaks between files.
    reports = []
    for path in args.transcripts:
        try:
            with path.open() as source:
                report = summarize(json.loads(line) for line in source if line.strip())
        except (OSError, ValueError, KeyError, TypeError) as error:
            parser.exit(1, f"Cannot read transcript {path}: {type(error).__name__}\n")
        reports.append({"transcript": str(path), **report})
    print(json.dumps({"reports": reports}, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
