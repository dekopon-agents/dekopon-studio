import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
from evalgw import driver, verify  # noqa: E402
from evalgw.bundle import Bundle, write_json  # noqa: E402

SPEC = importlib.util.spec_from_file_location("reward", synthetic.HARNESS / "harbor" / "task" / "tests" / "reward.py")
reward = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reward)


class HarborRewardTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.grade = Path(self.directory.name) / "grade.json"

    def tearDown(self):
        self.directory.cleanup()

    def value(self, text):
        self.grade.write_text(text)
        return reward.reward(self.grade)

    def test_harbor_rewards_only_a_structured_model_grade(self):
        self.assertEqual(self.value(json.dumps({"gradeVersion": 1, "status": "passed", "score": 1.0})), 1)
        self.assertEqual(self.value(json.dumps({"gradeVersion": 1, "status": "failed", "score": 0.0})), 0)
        for text in ("", "{", "null", json.dumps({"gradeVersion": 1, "status": "infrastructure_error", "score": None}),
                     json.dumps({"gradeVersion": 1, "status": "failed", "score": 1.0}),
                     json.dumps({"status": "passed", "score": 1.0})):
            self.assertIsNone(self.value(text), text)

    def test_a_hash_matching_malformed_trace_reaches_harbor_as_no_reward(self):
        root = Path(self.directory.name) / "bundle"
        attempt = Bundle.create(root, "synthetic", "two-message-gh-recall")
        staging = synthetic.write_bundle(Path(self.directory.name) / "staging")
        for name in ("trace", "config", "stdout"):
            for item in (staging / name).iterdir():
                (root / name / item.name).write_bytes(item.read_bytes())
        (root / "trace" / "traces.jsonl").write_text('{"resourceSpans":[null]}\n')
        record = synthetic.driver()
        write_json(root / "driver.json", record)
        driver.finish(attempt, synthetic.scenario(), record, {}, [], {}, None)
        graded = verify.regrade(root)
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))
        self.assertIn("export_malformed", graded["reasons"])
        self.assertIsNone(self.value(json.dumps(graded)))

if __name__ == "__main__":
    unittest.main()
