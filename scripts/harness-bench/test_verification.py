import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import run as bench
from verification_report import summarize, write_report


def manifest(repeats=2):
    return {"provider": "ollama", "model": "fixture", "harnesses": ["native"], "tasks": ["order-summary"], "repeats": repeats}


def row(repeat=0, **overrides):
    return {"task": "order-summary", "harness": "native", "repeat": repeat, "passed": True,
            "grading": {"passed": True}, "elapsedSeconds": 2, **overrides}


class ReportTests(unittest.TestCase):
    def test_missing_or_duplicate_trials_cannot_pass(self):
        for rows in ([], [row()], [row(), row()], [row(), row(repeat=8)]):
            self.assertEqual(summarize(manifest(), rows)["status"], "incomplete")

    def test_failed_trials_do_not_inflate_successful_speed_or_hide_failures(self):
        report = summarize(manifest(), [row(), row(1, passed=False, error="timeout", elapsedSeconds=.01)])
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["tasks"][0]["failed"], 1)
        self.assertEqual(report["tasks"][0]["successfulTrials"]["elapsedSeconds"], {"samples": 1, "median": 2})
        self.assertIsNone(report["tasks"][0]["successfulTrials"]["costUsd"]["median"])

    def test_agent_claims_do_not_override_grading_or_errors(self):
        for record in (row(grading={"passed": False}), row(error="request failed")):
            self.assertEqual(summarize(manifest(1), [record])["status"], "failed")

    def test_complete_success_has_an_exportable_report(self):
        with tempfile.TemporaryDirectory() as directory:
            report = write_report(directory, manifest(), [row(), row(1)])
            self.assertEqual(report["status"], "passed")
            self.assertTrue((Path(directory) / "REPORT.md").is_file())
            self.assertEqual(json.loads((Path(directory) / "report.json").read_text()), report)


class DriverTests(unittest.TestCase):
    def test_malformed_native_results_are_retained_as_failures(self):
        for content in ("{", "[]", '{"error": null}', '{"error": null, "elapsedSeconds": NaN}', '{"error": false, "elapsedSeconds": 1}'):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                (Path(directory) / "native-result.json").write_text(content)
                self.assertIsNotNone(bench.read_native_result(Path(directory), {"error": None})["error"])

    def test_existing_markdown_evidence_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bench.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "revision", "")), contextlib.redirect_stderr(io.StringIO()):
            report = Path(directory) / "REPORT.md"
            report.write_text("Earlier evidence")
            with self.assertRaises(SystemExit):
                bench.main(["--harness", "native", "--model", "fixture", "--run", "--output", directory])
            self.assertEqual(report.read_text(), "Earlier evidence")

    def test_preview_never_compiles_executes_or_creates_output(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bench.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "revision", "")), patch.object(bench, "execute") as execute, contextlib.redirect_stdout(io.StringIO()) as output:
            destination = Path(directory) / "preview"
            code = bench.main(["--harness", "native", "--model", "fixture", "--output", str(destination)])
            execute.assert_not_called()
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(output.getvalue())["preview"])
            self.assertFalse(destination.exists())

    def test_native_mode_uses_independent_grader_without_hermes(self):
        task = next(t for t in bench.TASKS if t["id"] == "order-summary")
        def execute(command, base, env, **kwargs):
            self.assertEqual(command[0], "cargo")
            self.assertNotIn("HERMES_HOME", {k: v for k, v in env.items() if v == str(base / "hermes-home")})
            (base / "workspace/summary.json").write_text(json.dumps(task["expected"]))
            (base / "native-result.json").write_text(json.dumps({"elapsedSeconds": 1, "error": None}))
            return {"elapsedSeconds": 1, "error": None}
        with tempfile.TemporaryDirectory() as directory, patch.object(bench.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "revision", "")), patch.object(bench, "execute", side_effect=execute), contextlib.redirect_stdout(io.StringIO()):
            code = bench.main(["--harness", "native", "--model", "fixture", "--task", "order-summary", "--repeats", "1", "--run", "--output", directory])
            self.assertEqual(code, 0)
            report = json.loads((Path(directory) / "report.json").read_text())
            self.assertEqual(report["status"], "passed")
            self.assertFalse((Path(directory) / "order-summary-0-native/hermes-home").exists())

    def test_missing_native_result_fails_and_retains_evidence(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bench.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "revision", "")), patch.object(bench, "execute", return_value={"error": None}), contextlib.redirect_stdout(io.StringIO()):
            code = bench.main(["--harness", "native", "--model", "fixture", "--task", "order-summary", "--repeats", "1", "--run", "--output", directory])
            self.assertEqual(code, 1)
            results = json.loads((Path(directory) / "results.json").read_text())
            self.assertIn("no result", results[0]["error"])
            self.assertEqual(json.loads((Path(directory) / "report.json").read_text())["status"], "failed")

    def test_process_failure_cannot_be_overwritten_by_a_success_result(self):
        task = next(t for t in bench.TASKS if t["id"] == "order-summary")
        def execute(command, base, env, **kwargs):
            (base / "workspace/summary.json").write_text(json.dumps(task["expected"]))
            (base / "native-result.json").write_text(json.dumps({"elapsedSeconds": 1, "error": None}))
            return {"elapsedSeconds": 1, "error": "Process exited 1"}
        with tempfile.TemporaryDirectory() as directory, patch.object(bench.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "revision", "")), patch.object(bench, "execute", side_effect=execute), contextlib.redirect_stdout(io.StringIO()):
            code = bench.main(["--harness", "native", "--model", "fixture", "--task", "order-summary", "--repeats", "1", "--run", "--output", directory])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads((Path(directory) / "report.json").read_text())["status"], "failed")
