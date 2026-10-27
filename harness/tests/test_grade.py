import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
from evalgw import completeness, grade  # noqa: E402
from evalgw.otlp import Export  # noqa: E402

COMPLETE = {"status": "complete", "reasons": []}


class GradeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.rules = synthetic.scenario()["expect"]["rules"]

    def tearDown(self):
        self.directory.cleanup()

    def export(self, spans=None, logs=None):
        traces = self.root / "traces.jsonl"
        log_file = self.root / "logs.jsonl"
        synthetic.write_lines(traces, [synthetic.resource_spans("dekopon-gatewayd", spans or synthetic.message_one() + synthetic.message_two())])
        synthetic.write_lines(log_file, logs or [])
        return Export.load(traces, log_file)

    def test_matching_evidence_passes_every_rule(self):
        graded = grade.grade(self.export(), self.rules, COMPLETE)
        self.assertEqual((graded["status"], graded["score"]), ("passed", 1.0))
        self.assertEqual([item["result"] for item in graded["rules"]], ["pass"] * len(self.rules))

    def test_an_answer_without_the_fact_fails(self):
        spans = synthetic.message_one() + synthetic.message_two()
        spans[-1]["events"][1] = synthetic.answer(synthetic.BASE + 10_199, 1, "I do not remember.", [])
        graded = grade.grade(self.export(spans), self.rules, COMPLETE)
        self.assertEqual((graded["status"], graded["score"]), ("failed", 0.0))
        self.assertEqual([item["index"] for item in graded["rules"] if item["result"] == "fail"], [4])

    def test_a_read_after_the_answer_fails_read_order(self):
        spans = synthetic.message_one() + synthetic.message_two()
        spans[3]["endTimeUnixNano"] = str(synthetic.BASE + 800)  # gh ends after the turn-2 answer
        graded = grade.grade(self.export(spans), self.rules, COMPLETE)
        self.assertEqual(graded["status"], "failed")
        self.assertEqual([item["rule"] for item in graded["rules"] if item["result"] == "fail"], ["readOrder"])

    def test_an_incomplete_bundle_is_unscored(self):
        incomplete = {"status": "incomplete", "reasons": [{"code": "gateway_sessions_abandoned", "detail": "x"}]}
        graded = grade.grade(self.export(), self.rules, incomplete)
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))
        self.assertIn("gateway_sessions_abandoned", graded["reasons"])

    def test_absent_shell_output_is_a_gap_not_a_failure(self):
        spans = synthetic.message_one() + synthetic.message_two()
        spans[3]["attributes"] = [item for item in spans[3]["attributes"] if item["key"] != "shell.command.output"]
        graded = grade.grade(self.export(spans), self.rules, COMPLETE)
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))
        self.assertEqual([item["rule"] for item in graded["rules"] if item["result"] == "gap"], ["output"])

    def test_selection_rule_matches_a_selection_event(self):
        spans = synthetic.message_one() + synthetic.message_two()
        spans[-1]["events"].append(
            synthetic.event("gateway.memory.selection", synthetic.BASE + 10_015,
                            {"event": "gateway_memory_selection", "record_id": 1, "actual": "summary", "policy": "fixed"})
        )
        rules = [{"rule": "selection", "message": 2, "match": {"actual": "summary", "policy": "fixed"}}]
        self.assertEqual(grade.grade(self.export(spans), rules, COMPLETE)["status"], "passed")
        rules[0]["match"]["actual"] = "original"
        self.assertEqual(grade.grade(self.export(spans), rules, COMPLETE)["status"], "failed")

    def test_a_log_copy_of_a_span_event_is_counted_once(self):
        copy = synthetic.answer(synthetic.BASE + 10_200, 1, "I reported trunk-synthetic as the default branch.", [])
        record = {
            "timeUnixNano": copy["timeUnixNano"],
            "severityText": "INFO",
            "body": {"stringValue": "agent.model.answer"},
            "traceId": "b2" * 16,
            "spanId": "2000000000000003",
            "attributes": copy["attributes"] + synthetic.attributes({"target": "dekopon_agent::audit"}),
        }
        logs = [{"resourceLogs": [{"resource": {}, "scopeLogs": [{"logRecords": [record]}]}]}]
        export = self.export(logs=logs)
        answers = [event for event in export.events() if event.kind == "agent.model.answer" and event.trace_id == "b2" * 16]
        self.assertEqual(len(answers), 1)
        self.assertEqual(answers[0].source, "span")


class SocketReplyIsNotEvidenceTest(unittest.TestCase):
    def test_grade_reads_the_answer_event_not_the_reply_line(self):
        with tempfile.TemporaryDirectory() as directory:
            root = synthetic.write_bundle(Path(directory) / "attempt")
            driver = synthetic.driver()
            for message in driver["messages"]:
                message["reply"] = {"reply": "trunk-synthetic" if message["ordinal"] == 2 else "nothing"}
            spans = synthetic.message_one() + synthetic.message_two()
            spans[-1]["events"][1] = synthetic.answer(synthetic.BASE + 10_199, 1, "I do not remember.", [])
            synthetic.write_lines(root / "trace" / "traces.jsonl", [synthetic.resource_spans("dekopon-gatewayd", spans)])
            result = completeness.check(root, 2, driver)
            export = Export.load(root / "trace" / "traces.jsonl", root / "trace" / "logs.jsonl")
            graded = grade.grade(export, synthetic.scenario()["expect"]["rules"], result)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(graded["status"], "failed")


if __name__ == "__main__":
    unittest.main()
