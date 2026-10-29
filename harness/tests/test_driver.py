import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
from evalgw import artifacts, driver, otlp  # noqa: E402
from evalgw.bundle import Bundle  # noqa: E402


class StartupFailureTest(unittest.TestCase):
    def test_a_failure_before_fixtures_start_still_finalizes_the_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "attempt"
            outcome = {}

            def attempt():
                with mock.patch.object(artifacts, "daemons", side_effect=artifacts.ArtifactError("download refused")):
                    outcome["result"] = driver.run(synthetic.SCENARIO, output, Path(directory) / "cache")

            runner = threading.Thread(target=attempt, daemon=True)
            runner.start()
            runner.join(timeout=30)
            self.assertFalse(runner.is_alive(), "driver.run hung on a startup failure")
            manifest, graded = outcome["result"]
            on_disk = json.loads((output / "manifest.json").read_text())
            self.assertEqual(on_disk, manifest)
            self.assertIn("driver_failure", [reason["code"] for reason in manifest["completeness"]["reasons"]])
            self.assertIn("download refused", json.loads((output / "driver.json").read_text())["failure"])
            self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))


class JournalCopyTest(unittest.TestCase):
    def test_only_conversation_journals_enter_the_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            journal = runtime / "journal" / "evalgw-agent"
            journal.mkdir(parents=True)
            original = b'{"synthetic":true}\n'
            (journal / "conversation.jsonl").write_bytes(original)
            (journal.parent / "prompt-cache-key.secret").write_text("synthetic non-journal state")
            (journal / "conversation.sealed").write_text("synthetic marker")
            attempt = Bundle.create(root / "attempt", "synthetic", "two-message-gh-recall")
            driver.copy_journal(runtime, attempt)
            copied = attempt.path("journal/evalgw-agent/conversation.jsonl")
            self.assertEqual(copied.read_bytes(), original)
            self.assertEqual(copied.stat().st_mode & 0o777, 0o600)
            self.assertEqual(copied.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual([p.relative_to(attempt.path("journal")).as_posix()
                              for p in attempt.path("journal").rglob("*") if p.is_file()],
                             ["evalgw-agent/conversation.jsonl"])
            attempt.path("journal/non-journal-state").write_text("synthetic unrelated state")
            self.assertEqual([ref["path"] for ref in attempt.journal_files()],
                             ["journal/evalgw-agent/conversation.jsonl"])


class EvidenceReuseTest(unittest.TestCase):
    def test_finalization_parses_the_exports_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "attempt"
            attempt = Bundle.create(root, "synthetic", "two-message-gh-recall")
            staging = synthetic.write_bundle(Path(directory) / "staging")
            for name in ("trace", "config", "stdout"):
                for item in (staging / name).iterdir():
                    (root / name / item.name).write_bytes(item.read_bytes())
            record = synthetic.driver()
            with mock.patch.object(otlp.Export, "load", wraps=otlp.Export.load) as load:
                _, graded = driver.finish(attempt, synthetic.scenario(), record, {}, [], {}, None)
            self.assertEqual(load.call_count, 1)
            self.assertEqual(graded["status"], "passed")


if __name__ == "__main__":
    unittest.main()
