import json
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

    def test_an_output_before_its_read_fails_read_order(self):
        spans = synthetic.message_one() + synthetic.message_two()
        rules = [rule for rule in self.rules if rule["rule"] == "readOrder"]
        self.assertEqual(grade.grade(self.export(spans), rules, COMPLETE)["status"], "passed")
        # An earlier script already printed the fact before any `repo view` ran.
        spans[5]["events"][:0] = synthetic.script_events(synthetic.BASE + 230, "evalgw-call-early", "cat notes", synthetic.FACT)
        graded = grade.grade(self.export(spans), rules, COMPLETE)
        self.assertEqual((graded["status"], graded["reasons"]), ("failed", [f"rule 0 (readOrder): order:repo view<{synthetic.FACT}"]))

    def test_script_needles_and_output_counts_follow_the_s4_judge(self):
        rules = [
            {"rule": "script", "message": 1, "noneOf": ["REPO VIEW"]},
            {"rule": "script", "message": 1, "countMax": {"view": 0}},
            {"rule": "output", "message": 1, "count": {synthetic.FACT: [2, 3]}},
            {"rule": "fact", "message": 1, "anyOf": [["main", synthetic.FACT.upper()]]},
        ]
        graded = grade.grade(self.export(), rules, COMPLETE)
        self.assertEqual([item["result"] for item in graded["rules"]], ["fail", "fail", "fail", "pass"])

    def test_a_provider_command_with_empty_span_output_still_grades_its_script_output(self):
        """Stock 0.62.0 leaves shell.command.output empty for a provider command whose stdout reached
        the script; the read is graded from agent.tool.output, not failed."""
        spans = synthetic.message_one() + synthetic.message_two()
        shell = synthetic.otlp.attributes(spans[3]["attributes"])
        self.assertEqual((shell["shell.command.output"], shell["shell.command.output.bytes"]), ("", 0))
        self.assertGreater(shell["shell.command.stdout.bytes"], 0)
        graded = grade.grade(self.export(spans), [r for r in self.rules if r["rule"] in ("output", "readOrder")], COMPLETE)
        self.assertEqual((graded["status"], graded["score"]), ("passed", 1.0))

    def test_an_incomplete_bundle_is_unscored(self):
        incomplete = {"status": "incomplete", "reasons": [{"code": "gateway_sessions_abandoned", "detail": "x"}]}
        graded = grade.grade(self.export(), self.rules, incomplete)
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))
        self.assertIn("gateway_sessions_abandoned", graded["reasons"])

    def test_a_script_without_its_output_is_a_gap_not_a_failure(self):
        spans = synthetic.message_one() + synthetic.message_two()
        spans[5]["events"] = [item for item in spans[5]["events"] if item["name"] != "agent.tool.output"]
        graded = grade.grade(self.export(spans), self.rules, COMPLETE)
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))
        self.assertEqual([item["rule"] for item in graded["rules"] if item["result"] == "gap"], ["output", "readOrder"])

    def test_truncated_arguments_are_a_gap_not_a_score(self):
        """dekopon cuts shell attributes at 4096 bytes and records the full length beside them."""
        full = json.dumps(["repo", "view", "synthetic-org/fixture-repo", "x" * 4500])
        spans = synthetic.message_one() + synthetic.message_two()
        spans[3]["attributes"] = [item for item in spans[3]["attributes"] if not item["key"].startswith("shell.command.arguments")]
        spans[3]["attributes"] += synthetic.attributes(
            {"shell.command.arguments": full[:4096] + "…[truncated]", "shell.command.arguments.bytes": len(full)}
        )
        graded = grade.grade(self.export(spans), self.rules, COMPLETE)
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))
        self.assertEqual([item["rule"] for item in graded["rules"] if item["result"] == "gap"], ["script"])
        self.assertIn(f"of {len(full)} bytes", graded["reasons"][0])

    def test_untyped_command_fields_are_gaps_not_failures(self):
        script = [rule for rule in self.rules if rule["rule"] == "script"]
        for key, value in (("shell.command.name", {"kvlistValue": {"values": []}}),
                           ("outcome", {"intValue": "1"}),
                           ("shell.command.exit_code", {"stringValue": "0"})):
            spans = synthetic.message_one() + synthetic.message_two()
            spans[3]["attributes"] = [item for item in spans[3]["attributes"] if item["key"] != key]
            spans[3]["attributes"].append({"key": key, "value": value})
            graded = grade.grade(self.export(spans), script, COMPLETE)
            self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None), key)
        spans = synthetic.message_one() + synthetic.message_two()
        spans[3]["attributes"] = [item for item in spans[3]["attributes"] if not item["key"].startswith("shell.command.arguments")]
        spans[3]["attributes"] += synthetic.attributes(synthetic.captured("shell.command.arguments", '["repo", 7]'))
        self.assertEqual(grade.grade(self.export(spans), script, COMPLETE)["status"], "infrastructure_error")

    def test_text_that_is_not_utf8_is_a_gap(self):
        spans = synthetic.message_one() + synthetic.message_two()
        spans[5]["events"][1]["attributes"] = synthetic.attributes(
            {"audit.event": "agent.tool.output", "gen_ai.tool.call.id": "evalgw-call-0", "output": "\ud800" + synthetic.FACT}
        )
        graded = grade.grade(self.export(spans), [r for r in self.rules if r["rule"] == "output"], COMPLETE)
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))

    def test_an_unsupported_predicate_never_grades(self):
        graded = grade.grade(self.export(), [{"rule": "fact", "message": 1, "all_of": ["NOT IN ANSWER"]}], COMPLETE)
        self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))

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
        copy = synthetic.answer(synthetic.BASE + 10_200, 1, f"I reported the description {synthetic.DESCRIPTION}.", [])
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
                message["reply"] = {"reply": synthetic.FACT if message["ordinal"] == 2 else "nothing"}
            spans = synthetic.message_one() + synthetic.message_two()
            spans[-1]["events"][1] = synthetic.answer(synthetic.BASE + 10_199, 1, "I do not remember.", [])
            synthetic.write_lines(root / "trace" / "traces.jsonl", [synthetic.resource_spans("dekopon-gatewayd", spans)])
            result, export = completeness.check(root, 2, driver)
            graded = grade.grade(export, synthetic.scenario()["expect"]["rules"], result)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(graded["status"], "failed")


if __name__ == "__main__":
    unittest.main()
