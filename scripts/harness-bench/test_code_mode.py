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
            (ws / ".klide/coordination").mkdir(parents=True)
            (ws / ".klide/coordination/events.jsonl").write_text("{}")
            self.assertTrue(bench.grade(task, ws, before, '{"n": 1}')["passed"], "Harness state is not an agent change")
            (ws / "a.txt").write_text("y")
            graded = bench.grade(task, ws, before, '{"n": 1}')
            self.assertTrue(graded["answerCorrect"])
            self.assertFalse(graded["passed"])


class Verdict(unittest.TestCase):
    def trial(self, task, arm, cost, seconds, passed=True, tokens=1000):
        return {"task": task, "arm": arm, "repeat": 0, "costUsd": cost, "elapsedSeconds": seconds, "passed": passed,
                "inputTokens": tokens, "cacheReadTokens": 0, "outputTokens": 5, "modelRequests": 2,
                "scriptCalls": 1 if arm == "script" else 0, "readManyCalls": 1 if arm == "batch" else 0}

    def tasks(self):
        return [{"id": "rollup-25"}, {"id": "rollup-100"}, {"id": "audit-40"}]

    def run_arms(self, spec):
        results = []
        for arm, kwargs in spec.items():
            for t in self.tasks():
                k = dict(kwargs)
                if callable(k.get("passed")):
                    k["passed"] = k["passed"](t["id"])
                results.append(self.trial(t["id"], arm, **k))
        return bench.summarize(results, self.tasks())

    def test_each_arm_is_judged_against_off(self):
        summary = self.run_arms({"off": {"cost": 1.0, "seconds": 10}, "batch": {"cost": 0.7, "seconds": 10.5},
                                 "script": {"cost": 0.5, "seconds": 12}})
        self.assertEqual(summary["verdicts"]["batch"]["verdict"], "keep")
        self.assertEqual(summary["verdicts"]["script"]["verdict"], "drop", "too slow")

    def test_a_lost_answer_drops_the_arm(self):
        summary = self.run_arms({"off": {"cost": 1.0, "seconds": 10},
                                 "batch": {"cost": 0.5, "seconds": 9, "passed": lambda t: t != "audit-40"}})
        self.assertEqual(summary["verdicts"]["batch"]["verdict"], "drop")

    def test_a_local_model_is_judged_on_uncached_input(self):
        summary = self.run_arms({"off": {"cost": None, "seconds": 10, "tokens": 10000},
                                 "batch": {"cost": None, "seconds": 9, "tokens": 2000}})
        self.assertEqual(summary["metric"], "medianUncachedInputTokens")
        self.assertEqual(summary["verdicts"]["batch"]["verdict"], "keep")

    def test_no_trials_is_incomplete(self):
        self.assertEqual(bench.summarize([], self.tasks())["verdicts"]["batch"]["verdict"], None)


if __name__ == "__main__":
    unittest.main()
