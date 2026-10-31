import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("harness_bench", Path(__file__).with_name("run.py"))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)

QUALITY_SOLUTIONS = {
    "ttl-cache-contract": {
        "cache.py": '''import time
class Cache:
    def __init__(self, ttl, clock=time.monotonic):
        self.ttl, self.clock, self.values = ttl, clock, {}
    def set(self, key, value):
        self.values[key] = (self.clock() + self.ttl, value)
    def get(self, key, default=None):
        entry = self.values.get(key)
        if entry is None or entry[0] <= self.clock(): return default
        return entry[1]
''',
        "service.py": '''def fetch_or_load(cache, key, loader):
    missing = object()
    value = cache.get(key, missing)
    if value is missing:
        value = loader()
        cache.set(key, value)
    return value
''',
    },
    "atomic-inventory-order": {
        "inventory.py": '''class Inventory:
    def __init__(self, stock): self.stock = dict(stock)
    def reserve(self, request):
        for sku, qty in request.items():
            if type(qty) is not int or qty <= 0: raise ValueError('quantity')
            if sku not in self.stock: raise KeyError(sku)
            if self.stock[sku] < qty: raise ValueError('insufficient')
        for sku, qty in request.items(): self.stock[sku] -= qty
''',
        "orders.py": '''def fulfill(inventory, items):
    request = {}
    for item in items:
        sku, qty = item['sku'], item['qty']
        if type(qty) is not int or qty <= 0: raise ValueError('quantity')
        request[sku] = request.get(sku, 0) + qty
    inventory.reserve(request)
    return request
''',
    },
}


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
                elif task["id"] == "multi-file-export":
                    (root / "report.py").write_text('def total(rows):\n    return sum(r.get("amount", 0) for r in rows if r.get("status") == "paid")\n')
                    (root / "main.py").write_text('import json\nfrom report import total\ndef render(rows):\n    return json.dumps({"total": total(rows), "paid_count": sum(r.get("status") == "paid" for r in rows)})\n')
                else:
                    for name, source in QUALITY_SOLUTIONS[task["id"]].items():
                        (root / name).write_text(source)
                self.assertTrue(bench.grade(task, root)["passed"])

    def test_quality_graders_reject_plausible_partial_fixes(self):
        cases = [
            ("ttl-cache-contract", "cache.py", lambda source: source.replace("entry[0] <=", "entry[0] <")),
            ("ttl-cache-contract", "service.py", lambda source: next(t for t in bench.TASKS if t["id"] == "ttl-cache-contract")["files"]["service.py"]),
            ("ttl-cache-contract", "cache.py", lambda source: source.replace("self.values[key] = (self.clock() + self.ttl, value)", "self.values.setdefault(key, (self.clock() + self.ttl, value))")),
            ("atomic-inventory-order", "inventory.py", lambda source: source.replace("type(qty) is not int", "not isinstance(qty, int)")),
            ("atomic-inventory-order", "inventory.py", lambda source: next(t for t in bench.TASKS if t["id"] == "atomic-inventory-order")["files"]["inventory.py"]),
            ("atomic-inventory-order", "orders.py", lambda source: source.replace("request.get(sku, 0) + qty", "qty")),
        ]
        for task_id, changed, mutation in cases:
            task = next(task for task in bench.TASKS if task["id"] == task_id)
            with self.subTest(task=task_id, mutation=changed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name, source in {**task["files"], **QUALITY_SOLUTIONS[task_id]}.items():
                    (root / name).write_text(source)
                source = (root / changed).read_text()
                self.assertNotEqual(source, mutation(source), "a mutation must change the implementation")
                (root / changed).write_text(mutation(source))
                self.assertFalse(bench.grade(task, root)["passed"])

    def test_unknown_tasks_fail_instead_of_running_an_empty_grader(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(bench.grade({"id": "unregistered"}, Path(directory))["passed"])

    def test_agent_tests_do_not_replace_the_grader(self):
        task = bench.TASKS[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "slug.py").write_text('def slugify(text):\n    return "always wrong"\n')
            (root / "test_slug.py").write_text('assert True\n')
            self.assertFalse(bench.grade(task, root)["passed"])


if __name__ == "__main__":
    unittest.main()
