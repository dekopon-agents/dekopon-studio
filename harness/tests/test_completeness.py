import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
from evalgw import completeness, evidence, grade  # noqa: E402
from evalgw.otlp import Export  # noqa: E402


class CompletenessTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = synthetic.write_bundle(Path(self.directory.name) / "attempt")
        self.driver = synthetic.driver()

    def tearDown(self):
        self.directory.cleanup()

    def check(self):
        return completeness.check(self.root, 2, self.driver)[0]

    def codes(self):
        return [reason["code"] for reason in self.check()["reasons"]]

    def test_synthetic_trial_is_complete(self):
        self.assertEqual(self.check(), {"status": "complete", "reasons": []})

    def test_opentelemetry_warning_on_the_console_is_a_loss(self):
        synthetic.append_console(
            self.root, "gateway", {"level": "WARN", "target": "opentelemetry_sdk", "message": "BatchSpanProcessor.ExportError"}
        )
        self.assertEqual(self.codes(), ["opentelemetry_diagnostic"])

    def test_opentelemetry_error_on_stderr_is_a_loss(self):
        synthetic.append_console(self.root, "broker", "dekopon-brokerd: telemetry disabled: OTLP endpoint must not be empty", "stderr")
        self.assertEqual(self.codes(), ["opentelemetry_diagnostic"])

    def test_console_dropped_lines_are_a_loss(self):
        synthetic.append_console(
            self.root, "broker",
            {"level": "WARN", "target": "dekopon_telemetry::install", "audit.event": "telemetry.console.dropped", "console.dropped.lines": 7},
        )
        self.assertEqual(self.codes(), ["telemetry_console_dropped"])

    def test_telemetry_shutdown_failure_is_a_loss(self):
        synthetic.append_console(
            self.root, "gateway",
            {"level": "ERROR", "target": "dekopon_gatewayd", "event": "gateway_telemetry_shutdown_failed", "message": "gateway.telemetry.shutdown.failed"},
        )
        self.assertEqual(self.codes(), ["gateway_telemetry_shutdown_failed"])

    def test_abandoned_sessions_are_a_loss(self):
        synthetic.append_console(
            self.root, "gateway",
            {"level": "WARN", "target": "dekopon_gatewayd::gateway", "event": "gateway_sessions_abandoned", "message": "gateway.sessions.abandoned"},
        )
        self.assertEqual(self.codes(), ["gateway_sessions_abandoned"])

    def test_discontinuous_message_count_is_a_loss(self):
        spans = synthetic.message_one() + synthetic.message_two()
        # Turn 2 is a delta of two messages on a transcript of two, so its declared length must be 4.
        spans[4]["events"][0] = synthetic.prompt(synthetic.BASE + 501, 2, "delta", 5, [{"role": "tool", "content": "x"}] * 2)
        synthetic.write_lines(self.root / "trace" / "traces.jsonl", [synthetic.resource_spans("dekopon-gatewayd", spans)])
        self.assertEqual(self.codes(), ["message_count_discontinuity"])

    def test_missing_final_answer_is_missing_evidence(self):
        spans = synthetic.message_one() + synthetic.message_two()
        spans[-1]["events"].pop()
        synthetic.write_lines(self.root / "trace" / "traces.jsonl", [synthetic.resource_spans("dekopon-gatewayd", spans)])
        self.assertEqual(self.codes(), ["message_evidence_missing"])

    def test_missing_trace_export_is_incomplete(self):
        (self.root / "trace" / "traces.jsonl").unlink()
        self.assertEqual(self.codes(), ["export_missing"])

    def test_malformed_log_export_is_incomplete(self):
        (self.root / "trace" / "logs.jsonl").write_text('{"resourceLogs": [\n')
        self.assertEqual(self.codes(), ["export_malformed"])

    def test_a_malformed_otlp_container_is_an_infrastructure_error(self):
        for shape in ('{"resourceSpans": [null]}', '{"resourceSpans": [{"scopeSpans": {}}]}',
                      '{"resourceSpans": [{"scopeSpans": [{"spans": [{"attributes": [{"value": {}}]}]}]}]}',
                      '{"resourceSpans": [{"scopeSpans": [{"spans": [{"startTimeUnixNano": ' + "9" * 4301 + '}]}]}]}',
                      '{"resourceSpans": [{"scopeSpans": [{"spans": [{"attributes": [{"key": "k", "value": {"doubleValue": '
                      + "9" * 309 + '}}]}]}]}]}'):
            (self.root / "trace" / "traces.jsonl").write_text(shape + "\n")
            result, export = completeness.check(self.root, 2, self.driver)
            self.assertEqual([reason["code"] for reason in result["reasons"]], ["export_malformed"], shape)
            graded = grade.grade(export, synthetic.scenario()["expect"]["rules"], result)
            self.assertEqual((graded["status"], graded["score"]), ("infrastructure_error", None))

    def test_forced_kill_is_a_process_failure(self):
        self.driver["processes"]["gateway"] = {"signal": "SIGTERM", "forcedKill": True, "exitCode": -9}
        self.assertEqual(self.codes(), ["process_failure"])

    def test_scripted_model_deviation_is_a_fixture_violation(self):
        self.driver["fixtures"]["model"]["violations"] = ["request 3: beyond the 3 scripted completions"]
        self.assertEqual(self.codes(), ["fixture_violation"])

    def test_collector_export_error_is_a_receiver_failure(self):
        with (self.root / "stdout" / "collector.log").open("a") as handle:
            handle.write("2026-10-27T00:00:00.000Z\terror\tfileexporter\tfailed to write\n")
        self.assertEqual(self.codes(), ["receiver_failure"])

    def test_unreplied_message_is_incomplete(self):
        self.driver["messages"][1]["reply"] = None
        self.assertEqual(self.codes(), ["reply_missing"])


class ContinuityTest(unittest.TestCase):
    def prompts(self, spans):
        export = Export([], [])
        with tempfile.TemporaryDirectory() as directory:
            traces = Path(directory) / "traces.jsonl"
            logs = Path(directory) / "logs.jsonl"
            synthetic.write_lines(traces, [synthetic.resource_spans("dekopon-gatewayd", spans)])
            logs.write_text("")
            export = Export.load(traces, logs)
        return [prompt for message in evidence.messages(export) for prompt in message.prompts]

    def turn(self, span_id, events):
        return synthetic.span("c3" * 16, span_id, "3000000000000002", "prompt.model_turn", 0, 1, events=events)

    def anchor(self):
        return [
            synthetic.span("c3" * 16, "3000000000000001", "", "gateway.message", 0, 10),
            synthetic.span("c3" * 16, "3000000000000002", "3000000000000001", "prompt.session", 0, 10),
        ]

    def test_full_then_deltas_is_continuous(self):
        message = {"role": "user", "content": "m"}
        spans = self.anchor() + [
            self.turn("3000000000000003", [synthetic.prompt(1, 1, "full", 3, [message] * 3)]),
            self.turn("3000000000000004", [synthetic.prompt(2, 2, "delta", 5, [message] * 2)]),
            self.turn("3000000000000005", [synthetic.prompt(3, 3, "delta", 6, [message])]),
        ]
        self.assertEqual(evidence.continuity_gaps(self.prompts(spans)), [])

    def test_delta_without_an_earlier_prompt_is_a_gap(self):
        spans = self.anchor() + [self.turn("3000000000000003", [synthetic.prompt(1, 2, "delta", 2, [{"role": "user"}] * 2)])]
        gaps = evidence.continuity_gaps(self.prompts(spans))
        self.assertEqual(len(gaps), 1)
        self.assertIn("no earlier prompt", gaps[0])

    def test_sessions_are_checked_separately(self):
        """A second session restarts with a full transcript; it is not a continuation of the first."""
        message = {"role": "user", "content": "m"}
        other = synthetic.span("c3" * 16, "3000000000000009", "3000000000000001", "prompt.session", 5, 10)
        spans = self.anchor() + [other] + [
            self.turn("3000000000000003", [synthetic.prompt(1, 1, "full", 3, [message] * 3)]),
            synthetic.span(
                "c3" * 16, "3000000000000004", "3000000000000009", "prompt.model_turn", 6, 7,
                events=[synthetic.prompt(6, 1, "full", 2, [message] * 2)],
            ),
        ]
        self.assertEqual(evidence.continuity_gaps(self.prompts(spans)), [])


if __name__ == "__main__":
    unittest.main()
