"""Property-style check: no value planted in any parsed OTLP field can stop finalization.

Every key the reader takes from an export is replaced, one at a time, by each adversarial value of a
different JSON type (or an out-of-range number for a numeric field). Finalization must still finish
the manifest and write grade.json with an infrastructure-error grade and a null score. Every text
field also receives hostile text of its own type (lone surrogates, non-ASCII digits, huge strings,
deeply nested JSON inside a string); that may grade either way, but must finish without the
last-resort guard.
"""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
from evalgw import driver  # noqa: E402
from evalgw.bundle import Bundle, write_json  # noqa: E402

# Keys the OTLP reader parses; a planted value anywhere else would not reach it.
PARSED = {
    "resourceSpans", "resourceLogs", "resource", "scopeSpans", "scopeLogs", "spans", "logRecords",
    "events", "attributes", "key", "value", "traceId", "spanId", "parentSpanId", "name", "status",
    "startTimeUnixNano", "endTimeUnixNano", "timeUnixNano", "observedTimeUnixNano", "severityText",
    "body", "stringValue", "intValue", "doubleValue", "boolValue", "bytesValue", "arrayValue", "kvlistValue",
    "values", "scope",
}
NUMERIC_TEXT = {"startTimeUnixNano", "endTimeUnixNano", "timeUnixNano", "observedTimeUnixNano", "intValue"}
DEEP = "[" * 50_000 + "]" * 50_000
# Raw JSON text, with the Python type json.loads gives it (None for text that cannot be decoded).
ADVERSARIAL = [
    ("9" * 400, int), ("-" + "9" * 400, int), ("9" * 5000, None), ("1e309", float), ("-1e309", float),
    ("NaN", float), ("Infinity", float), ("1.5", float), ("true", bool), ("null", type(None)),
    ("[]", list), ("{}", dict), ('"text"', str), (DEEP, None),
]
# Text no int64 or fixed64 field accepts; "-1" is out of range for the unsigned timestamps only.
OUT_OF_RANGE_TEXT = ['"' + "9" * 5000 + '"', '"18446744073709551616"', '"1e3"', '" 7"']
TIMESTAMPS = NUMERIC_TEXT - {"intValue"}
MARK = "__evalgw_adversarial__"
# Same-type text: valid JSON strings whose content is hostile to whatever reads them next.
HOSTILE_TEXT = [
    json.dumps("\ud800"), json.dumps("²"), json.dumps("٣"), json.dumps("9" * 5000), json.dumps("x" * 200_000),
    json.dumps("[" * 50_000 + "]" * 50_000), json.dumps('{"event": {}}'), json.dumps("…[truncated]"),
]


def paths(value, trail=()):
    """Every (container path, key) the reader parses in this synthetic export."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in PARSED:
                yield trail + (key,), item
            yield from paths(item, trail + (key,))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from paths(item, trail + (index,))


def planted(document, trail, raw):
    copy = json.loads(json.dumps(document))
    target = copy
    for step in trail[:-1]:
        target = target[step]
    target[trail[-1]] = MARK
    return json.dumps(copy).replace(json.dumps(MARK), raw)


def adversaries(original, key):
    for raw, kind in ADVERSARIAL:
        if kind is None or not isinstance(original, kind) or (kind is int and isinstance(original, bool)):
            yield raw
    if key in NUMERIC_TEXT:
        yield from OUT_OF_RANGE_TEXT
    if key in TIMESTAMPS:
        yield '"-1"'


class AdversarialExportTest(unittest.TestCase):
    def test_no_parsed_field_value_can_stop_finalization(self):
        spans = synthetic.message_one() + synthetic.message_two()
        exports = {
            "traces.jsonl": synthetic.resource_spans("dekopon-gatewayd", spans),
            "logs.jsonl": synthetic.broker_log(),
        }
        # A doubleValue and an arrayValue/kvlistValue so those decoders are exercised too.
        exports["traces.jsonl"]["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"] = [
            {"key": "ratio", "value": {"doubleValue": 0.5}},
            {"key": "list", "value": {"arrayValue": {"values": [{"stringValue": "a"}]}}},
            {"key": "map", "value": {"kvlistValue": {"values": [{"key": "k", "value": {"intValue": "1"}}]}}},
            {"key": "blob", "value": {"bytesValue": "AAEC"}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            staging = synthetic.write_bundle(Path(directory) / "staging")
            cases = 0
            for name, document in exports.items():
                for trail, original in list(paths(document)):
                    for raw in adversaries(original, trail[-1]):
                        cases += 1
                        root = Path(directory) / f"case-{cases}"
                        attempt = Bundle.create(root, "synthetic", "two-message-gh-recall")
                        for folder in ("trace", "config", "stdout"):
                            shutil.copytree(staging / folder, root / folder, dirs_exist_ok=True)
                        (root / "trace" / name).write_text(planted(document, trail, raw) + "\n")
                        record = synthetic.driver()
                        write_json(root / "driver.json", record)
                        label = f"{name} {'/'.join(map(str, trail))} = {raw[:40]}"
                        with self.subTest(label):
                            manifest, graded = driver.finish(attempt, synthetic.scenario(), record, {}, [], {}, None)
                            on_disk = json.loads((root / "grade.json").read_text())
                            self.assertEqual((on_disk["status"], on_disk["score"]), ("infrastructure_error", None))
                            self.assertEqual(on_disk, graded)
                            # Classified by the reader itself, not caught by finish()'s last-resort guard.
                            codes = [reason["code"] for reason in manifest["completeness"]["reasons"]]
                            self.assertNotIn("finalization_error", codes)
                            self.assertIsNotNone(json.loads((root / "manifest.json").read_text())["attempt"]["finishedAt"])
                        shutil.rmtree(root)
                    if isinstance(original, str):
                        for raw in HOSTILE_TEXT:
                            cases += 1
                            root = Path(directory) / f"case-{cases}"
                            attempt = Bundle.create(root, "synthetic", "two-message-gh-recall")
                            for folder in ("trace", "config", "stdout"):
                                shutil.copytree(staging / folder, root / folder, dirs_exist_ok=True)
                            (root / "trace" / name).write_text(planted(document, trail, raw) + "\n")
                            record = synthetic.driver()
                            write_json(root / "driver.json", record)
                            with self.subTest(f"{name} {'/'.join(map(str, trail))} = text {raw[:20]}"):
                                manifest, graded = driver.finish(attempt, synthetic.scenario(), record, {}, [], {}, None)
                                on_disk = json.loads((root / "grade.json").read_text())
                                self.assertEqual(on_disk, graded)
                                self.assertIn((on_disk["status"], on_disk["score"]),
                                              [("passed", 1.0), ("failed", 0.0), ("infrastructure_error", None)])
                                codes = [reason["code"] for reason in manifest["completeness"]["reasons"]]
                                self.assertNotIn("finalization_error", codes)
                                self.assertNotIn("finalization_error", " ".join(graded["reasons"]))
                            shutil.rmtree(root)
            self.assertGreater(cases, 1000)


if __name__ == "__main__":
    unittest.main()
