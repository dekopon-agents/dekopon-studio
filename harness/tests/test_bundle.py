import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
from evalgw import bundle, driver, verify  # noqa: E402
from evalgw.bundle import Bundle, sha256  # noqa: E402

DEKOPON = {"version": "0.62.0", "source": {"repository": "dekopon-agents/dekopon"}, "binaries": {}}


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def references(value):
    if isinstance(value, dict):
        if "path" in value and "sha256" in value:
            yield value
        for item in value.values():
            yield from references(item)
    elif isinstance(value, list):
        for item in value:
            yield from references(item)


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "attempt"

    def tearDown(self):
        self.directory.cleanup()

    def finalize(self, driver_record, journal=True):
        attempt = Bundle.create(self.root, "synthetic", "two-message-gh-recall")
        staging = Path(self.directory.name) / "staging"
        synthetic.write_bundle(staging)
        for item in staging.iterdir():
            if item.is_dir():
                shutil.copytree(item, self.root / item.name, dirs_exist_ok=True)
        if journal:
            (self.root / "journal" / "evalgw-agent").mkdir()
            (self.root / "journal" / "evalgw-agent" / "conversation.jsonl").write_text('{"synthetic":true}\n')
        line = driver_record.pop("consoleLine", None)
        if line is not None:
            synthetic.append_console(self.root, "gateway", line)
        bundle.write_json(self.root / "driver.json", driver_record)
        freeze = {"lastRepliedMessage": 2, "journalStems": ["evalgw-agent/conversation"]} if journal else None
        return driver.finish(attempt, synthetic.scenario(), driver_record, DEKOPON, [], {}, freeze)

    def test_creation_is_exclusive_and_starts_incomplete(self):
        Bundle.create(self.root, "synthetic", "two-message-gh-recall")
        manifest = json.loads((self.root / "manifest.json").read_text())
        self.assertEqual(manifest["bundleVersion"], 1)
        self.assertEqual(manifest["completeness"]["status"], "incomplete")
        self.assertEqual(manifest["completeness"]["reasons"][0]["code"], "not_finalized")
        with self.assertRaises(FileExistsError):
            Bundle.create(self.root, "again", "two-message-gh-recall")

    def test_finalized_references_are_relative_and_hashed(self):
        manifest, graded = self.finalize(synthetic.driver())
        self.assertEqual(manifest["completeness"]["status"], "complete")
        self.assertEqual((graded["status"], graded["score"]), ("passed", 1.0))
        found = list(references(manifest))
        self.assertGreaterEqual(len(found), 12)
        for reference in found:
            self.assertFalse(reference["path"].startswith("/"), reference)
            self.assertEqual(sha256(self.root / reference["path"]), reference["sha256"], reference)
        for text in strings(manifest):
            self.assertFalse(text.startswith("/") or "://" in text, text)
        self.assertEqual(manifest["journal"]["files"][0]["path"], "journal/evalgw-agent/conversation.jsonl")
        self.assertEqual(manifest["trace"]["format"], "otlp-jsonl")
        self.assertIsNone(manifest["seedDigest"])

    def test_projection_failure_is_incomplete_and_unscored(self):
        record = synthetic.driver()
        record["seed"] = {"digest": "a" * 64, "armId": "live-policy"}
        record["firstProjection"] = {"status": "mismatch", "reason": "frozen input differs"}
        manifest, graded = self.finalize(record)
        self.assertEqual(manifest["completeness"]["status"], "incomplete")
        self.assertIn("first_projection_mismatch", [r["code"] for r in manifest["completeness"]["reasons"]])
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))

    def test_missing_sigterm_freeze_is_incomplete_in_initial_and_offline_grading(self):
        record = synthetic.driver()
        record['processes']['gateway']['signal'] = None
        manifest, graded = self.finalize(record, journal=False)
        self.assertIsNone(manifest['freeze'])
        self.assertEqual(manifest['completeness']['status'], 'incomplete')
        self.assertIn('process_failure', [r['code'] for r in manifest['completeness']['reasons']])
        self.assertEqual((graded['status'], graded['score']), ('infrastructure_error', None))
        self.assertEqual(verify.regrade(self.root), graded)

    def test_seeded_placeholder_and_final_manifest_use_version_two(self):
        attempt = Bundle.create(self.root, "synthetic", "two-message-gh-recall",
                                seed_digest="a" * 64, arm_id="summaries-preferred")
        initial = json.loads((self.root / "manifest.json").read_text())
        self.assertEqual((initial["bundleVersion"], initial["seedDigest"], initial["armId"]),
                         (2, "a" * 64, "summaries-preferred"))
        final = attempt.finalize(scenario_id="two-message-gh-recall", dekopon=DEKOPON, providers=[],
                                 collector={}, freeze=None, loss_signals=[],
                                 completeness=initial["completeness"], gaps=[])
        self.assertEqual((final["bundleVersion"], final["seedDigest"], final["armId"]),
                         (2, "a" * 64, "summaries-preferred"))

    def test_failed_attempt_is_kept_incomplete_and_unscored(self):
        record = synthetic.driver()
        record["failure"] = "TimeoutError: local.sock readiness deadline"
        manifest, graded = self.finalize(record, journal=False)
        self.assertTrue(self.root.is_dir())
        self.assertEqual(manifest["completeness"]["status"], "incomplete")
        self.assertIn("driver_failure", [reason["code"] for reason in manifest["completeness"]["reasons"]])
        self.assertIsNone(manifest["journal"])
        self.assertIsNone(manifest["freeze"])
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))
        self.assertEqual(json.loads((self.root / "grade.json").read_text())["score"], None)

    def test_console_loss_is_listed_as_a_loss_signal(self):
        record = synthetic.driver()
        record["consoleLine"] = {"level": "WARN", "event": "gateway_sessions_abandoned"}
        manifest, graded = self.finalize(record)
        self.assertEqual([signal["code"] for signal in manifest["stdout"]["lossSignals"]], ["gateway_sessions_abandoned"])
        self.assertEqual(graded["score"], None)

    def test_offline_regrade_matches_and_detects_tampering(self):
        _, graded = self.finalize(synthetic.driver())
        self.assertEqual(verify.regrade(self.root), graded)
        with (self.root / "trace" / "traces.jsonl").open("a") as handle:
            handle.write("\n")
        tampered = verify.regrade(self.root)
        self.assertEqual((tampered["status"], tampered["score"]), ("infrastructure_error", None))
        self.assertIn("trace/traces.jsonl", tampered["reasons"][0])

    def test_offline_regrade_refuses_an_unsupported_predicate(self):
        self.finalize(synthetic.driver())
        scenario = json.loads((self.root / "config" / "scenario.json").read_text())
        scenario["expect"]["rules"] = [{"rule": "fact", "message": 1, "all_of": ["NOT IN ANSWER"]}]
        (self.root / "config" / "scenario.json").write_text(json.dumps(scenario))
        manifest = json.loads((self.root / "manifest.json").read_text())
        digest = sha256(self.root / "config" / "scenario.json")
        manifest["scenario"]["config"]["sha256"] = manifest["config"]["scenario"]["sha256"] = digest
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        regraded = verify.regrade(self.root)
        self.assertEqual((regraded["status"], regraded["score"]), ("infrastructure_error", None))
        self.assertIn("all_of", regraded["reasons"][0])

    def test_an_oversized_export_number_still_finalizes_as_infrastructure_error(self):
        record = synthetic.driver()
        attempt = Bundle.create(self.root, "synthetic", "two-message-gh-recall")
        staging = synthetic.write_bundle(self.root.with_name("staging"))
        for item in staging.iterdir():
            if item.is_dir():
                shutil.copytree(item, self.root / item.name, dirs_exist_ok=True)
        (self.root / "trace" / "traces.jsonl").write_text(
            '{"resourceSpans": [{"scopeSpans": [{"spans": [{"startTimeUnixNano": ' + "9" * 4301 + '}]}]}]}\n'
        )
        bundle.write_json(self.root / "driver.json", record)
        manifest, graded = driver.finish(attempt, synthetic.scenario(), record, DEKOPON, [], {}, None)
        self.assertIsNotNone(json.loads((self.root / "manifest.json").read_text())["attempt"]["finishedAt"])
        self.assertIn("export_malformed", [reason["code"] for reason in manifest["completeness"]["reasons"]])
        self.assertEqual(json.loads((self.root / "grade.json").read_text())["status"], "infrastructure_error")
        self.assertEqual(graded["score"], None)

    def test_paths_cannot_escape_the_bundle(self):
        attempt = Bundle.create(self.root, "synthetic", "two-message-gh-recall")
        with self.assertRaises(ValueError):
            attempt.path("../outside")
        with self.assertRaises(ValueError):
            attempt.path("/etc/passwd")


if __name__ == "__main__":
    unittest.main()
