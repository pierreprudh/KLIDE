import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import code_mode as bench  # noqa: E402


def recompute_rollup(task):
    """Independent of the generator: read the fixture files back."""
    names = json.loads(task["files"]["index.json"])["batches"]
    rows = [row for name in names for row in json.loads(task["files"][name])]
    active = [row for row in rows if row["active"] is True]
    return {"files": len(names), "active_count": len(active), "active_cents": sum(r["cents"] for r in active)}


def recompute_audit(task):
    configs = [json.loads(text) for name, text in task["files"].items() if name.startswith("services/")]
    flagged = sorted(c["name"] for c in configs if c["enabled"] is True and c["timeout_ms"] > 30000 and "owner" not in c)
    return {"checked": len(configs), "flagged": flagged}


class Fixtures(unittest.TestCase):
    def test_archived_tasks_are_the_published_ones(self):
        ids = [t["id"] for t in bench.archived_tasks()]
        self.assertEqual(ids, ["single-read", "multi-read-rollup", "dependent-chain"])
        rollup = bench.archived_tasks()[1]
        self.assertEqual(recompute_rollup(rollup), rollup["expected"])

    def test_generated_expectations_match_the_files(self):
        for task in bench.all_tasks(42):
            if task["id"].startswith("rollup-"):
                self.assertEqual(recompute_rollup(task), task["expected"], task["id"])
            if task["id"].startswith("audit-"):
                self.assertEqual(recompute_audit(task), task["expected"])
                self.assertTrue(task["expected"]["flagged"], "the audit must flag at least one service")

    def test_generation_is_deterministic_and_the_decoy_is_outside_the_index(self):
        a, b = bench.rollup_task(25, 7), bench.rollup_task(25, 7)
        self.assertEqual(a, b)
        self.assertNotIn("batch-unlisted.json", json.loads(a["files"]["index.json"])["batches"])


class Grading(unittest.TestCase):
    def test_last_json_object_wins_over_prose_and_fences(self):
        text = 'I read {"files": 1}. Final:\n```json\n{"a": 1, "b": [1, 2]}\n```'
        self.assertEqual(bench.last_json_object(text), {"a": 1, "b": [1, 2]})
        self.assertIsNone(bench.last_json_object("no json here"))
        self.assertIsNone(bench.last_json_object(None))

    def test_a_correct_answer_fails_when_the_workspace_changed(self):
        task = {"expected": {"n": 1}}
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "a.txt").write_text("x")
            before = bench.digest(ws)
            self.assertTrue(bench.grade(task, ws, before, '{"n": 1}')["passed"])
            self.assertFalse(bench.grade(task, ws, before, '{"n": 2}')["passed"])
            (ws / "a.txt").write_text("y")
            graded = bench.grade(task, ws, before, '{"n": 1}')
            self.assertTrue(graded["answerCorrect"])
            self.assertFalse(graded["passed"])


class Verdict(unittest.TestCase):
    def trial(self, task, arm, cost, seconds, passed=True):
        return {"task": task, "arm": arm, "repeat": 0, "costUsd": cost, "elapsedSeconds": seconds, "passed": passed,
                "inputTokens": 100, "cacheReadTokens": 10, "outputTokens": 5, "modelRequests": 2, "scriptCalls": 1 if arm == "on" else 0}

    def tasks(self):
        return [{"id": "rollup-25"}, {"id": "rollup-100"}, {"id": "audit-40"}]

    def test_keep_needs_all_three_checks(self):
        results = [self.trial(t["id"], "off", 1.0, 10) for t in self.tasks()] + \
                  [self.trial(t["id"], "on", 0.7, 10.5) for t in self.tasks()]
        self.assertEqual(bench.summarize(results, self.tasks())["verdict"], "keep")

    def test_slower_or_less_correct_reverts(self):
        slow = [self.trial(t["id"], "off", 1.0, 10) for t in self.tasks()] + \
               [self.trial(t["id"], "on", 0.5, 12) for t in self.tasks()]
        self.assertEqual(bench.summarize(slow, self.tasks())["verdict"], "revert")
        wrong = [self.trial(t["id"], "off", 1.0, 10) for t in self.tasks()] + \
                [self.trial(t["id"], "on", 0.5, 9, passed=t["id"] != "audit-40") for t in self.tasks()]
        self.assertEqual(bench.summarize(wrong, self.tasks())["verdict"], "revert")

    def test_missing_cost_is_not_a_saving(self):
        results = [self.trial(t["id"], "off", None, 10) for t in self.tasks()] + \
                  [self.trial(t["id"], "on", 0.1, 9) for t in self.tasks()]
        self.assertEqual(bench.summarize(results, self.tasks())["verdict"], "revert")

    def test_no_trials_is_incomplete(self):
        self.assertIsNone(bench.summarize([], self.tasks())["verdict"])


if __name__ == "__main__":
    unittest.main()
