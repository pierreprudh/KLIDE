import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("harness_bench", Path(__file__).with_name("run.py"))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class GraderTests(unittest.TestCase):
    def test_baselines_fail_and_correct_outputs_pass(self):
        for task in bench.TASKS:
            with self.subTest(task=task["id"]), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name, text in task["files"].items():
                    (root / name).write_text(text)
                self.assertFalse(bench.grade(task, root)["passed"])
                if task["id"] == "order-summary":
                    (root / "summary.json").write_text(json.dumps(task["expected"]))
                elif task["id"] == "slug-regression":
                    (root / "slug.py").write_text('import re\ndef slugify(text):\n    return re.sub("[^a-z0-9]+", "-", text.lower()).strip("-")\n')
                else:
                    (root / "report.py").write_text('def total(rows):\n    return sum(r.get("amount", 0) for r in rows if r.get("status") == "paid")\n')
                    (root / "main.py").write_text('import json\nfrom report import total\ndef render(rows):\n    return json.dumps({"total": total(rows), "paid_count": sum(r.get("status") == "paid" for r in rows)})\n')
                self.assertTrue(bench.grade(task, root)["passed"])

    def test_agent_tests_do_not_replace_the_grader(self):
        task = bench.TASKS[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "slug.py").write_text('def slugify(text):\n    return "always wrong"\n')
            (root / "test_slug.py").write_text('assert True\n')
            self.assertFalse(bench.grade(task, root)["passed"])


if __name__ == "__main__":
    unittest.main()
