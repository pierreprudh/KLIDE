import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("diagnostics", Path(__file__).with_name("report_diagnostics.py"))
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


def turn(seq, usage=None, diagnostic=None):
    return {"schemaVersion": 1, "runId": "fixture", "seq": seq, "event": {
        "type": "assistant_message", "content": [{"text": "PRIVATE_CONTENT"}],
        "timing": {"modelMs": 10, "diagnostics": diagnostic}, "usage": usage}}


class DiagnosticsReportTests(unittest.TestCase):
    def test_missing_usage_stays_unknown_and_content_is_not_exported(self):
        report = diagnostics.summarize([turn(1)])
        self.assertIsNone(report["metrics"]["cacheReadTokens"]["total"])
        self.assertIsNone(report["cache"]["tokenWeightedReadShare"])
        self.assertIsNone(report["turns"][0]["ttftMs"])
        self.assertEqual(report["diagnosedTurns"], 0)
        self.assertNotIn("PRIVATE_CONTENT", str(report))

    def test_weighted_cache_share_uses_only_complete_pairs(self):
        report = diagnostics.summarize([
            turn(1, {"promptTokens": 100, "cacheReadTokens": 0}),
            turn(2, {"promptTokens": 900, "cacheReadTokens": 900}),
            turn(3, {"promptTokens": 500}), turn(4, {"cacheReadTokens": 300}),
        ])
        self.assertEqual(report["cache"]["meanRequestReadShare"], .5)
        self.assertEqual(report["cache"]["tokenWeightedReadShare"], .9)
        self.assertEqual(report["cache"]["unknownReadShareTurns"], 2)
        self.assertEqual(report["metrics"]["cacheReadTokens"]["samples"], 3)

    def test_setup_counted_once_and_failures_not_discarded(self):
        diagnostic = {"setup": {"toolCatalogMs": 20}, "inputBuildMs": 1,
                      "inspectionMs": 2, "attempts": 2,
                      "prompt": {"change": "no_baseline"}}
        report = diagnostics.summarize([
            {"event": {"type": "run_started", "provider": "fixture", "model": "a"}},
            turn(1, diagnostic=diagnostic),
            {"event": {"type": "route_locked", "model": "b"}},
            turn(2, diagnostic={**diagnostic, "setup": None, "attempts": 1,
                                "prompt": {"change": "appended"}}),
            {"event": {"type": "run_error"}},
        ])
        self.assertEqual(report["preparation"]["setup"]["toolCatalogMs"]["total"], 20)
        self.assertEqual(report["preparation"]["attempts"]["total"], 3)
        self.assertEqual(report["runErrors"], 1)
        self.assertEqual(report["turns"][0]["model"], "a")
        self.assertEqual(report["turns"][1]["model"], "b")

    def test_newer_schema_is_rejected(self):
        with self.assertRaises(ValueError):
            diagnostics.summarize([{"schemaVersion": 2, "event": {}}])


if __name__ == "__main__":
    unittest.main()
