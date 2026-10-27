"""Grade a complete trial from structured evidence, never from socket reply lines.

Rules are scenario data (`expect.rules`), each bound to one message ordinal:

- `fact`: the message's final `agent.model.answer` contains every `contains` string and none of
  `excludes`.
- `script`: a `shell.command` ran `command` with every `argumentsContain` token, optionally with
  the given `outcome` and `exitCode`.
- `output`: a `shell.command` (optionally only `command`) produced output containing every
  `contains` string.
- `readOrder`: the `commands` ran in that order and all ended before the final answer.
- `selection`: a `gateway_memory_selection` event carries every `match` attribute.

A rule whose required evidence field is absent is a gap: the grade is `infrastructure_error`
with a null score, never a model failure. An incomplete bundle is graded the same way.
"""

from __future__ import annotations

import json
from typing import Any

from . import evidence
from .otlp import Export, Span

GRADE_VERSION = 1


class Gap(Exception):
    """Required evidence is absent; the trial cannot be scored."""


def _message(messages: list[evidence.Message], ordinal: int) -> evidence.Message:
    for message in messages:
        if message.ordinal == ordinal:
            return message
    raise Gap(f"message {ordinal} has no evidence")


def _answer(message: evidence.Message) -> tuple[str, int]:
    event = message.final_answer()
    if event is None:
        raise Gap(f"message {message.ordinal} has no final {evidence.ANSWER_EVENT}")
    answer = event.attributes.get("answer")
    if not isinstance(answer, str):
        raise Gap(f"message {message.ordinal} final answer has no answer attribute")
    return answer, event.time


def _field(span: Span, key: str) -> Any:
    if key not in span.attributes:
        raise Gap(f"{evidence.SHELL_SPAN} {span.span_id} lacks {key}")
    return span.attributes[key]


def _arguments(span: Span) -> list[str]:
    raw = _field(span, "shell.command.arguments")
    try:
        decoded = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        raise Gap(f"{evidence.SHELL_SPAN} {span.span_id} arguments are bounded or malformed") from None
    if not isinstance(decoded, list):
        raise Gap(f"{evidence.SHELL_SPAN} {span.span_id} arguments are not a list")
    return [str(item) for item in decoded]


def _commands(message: evidence.Message, command: str | None) -> list[Span]:
    return [span for span in message.shell if command is None or _field(span, "shell.command.name") == command]


def _script(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    for span in _commands(message, rule["command"]):
        arguments = _arguments(span)
        if not all(token in arguments for token in rule.get("argumentsContain", [])):
            continue
        if "outcome" in rule and _field(span, "outcome") != rule["outcome"]:
            continue
        # Exported as an OTLP intValue, which some exporters stringify; compare the number.
        if "exitCode" in rule and str(_field(span, "shell.command.exit_code")) != str(rule["exitCode"]):
            continue
        return True, f"{rule['command']} {' '.join(arguments)}"
    return False, f"no {rule['command']} command matched"


def _output(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    spans = _commands(message, rule.get("command"))
    for span in spans:
        output = _field(span, "shell.command.output")
        if all(text in str(output) for text in rule["contains"]):
            return True, f"output of {span.attributes.get('shell.command.name')} matched"
    return False, f"no output among {len(spans)} commands contained {rule['contains']}"


def _fact(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    answer, _ = _answer(message)
    missing = [text for text in rule.get("contains", []) if text not in answer]
    present = [text for text in rule.get("excludes", []) if text in answer]
    if missing or present:
        return False, f"answer missing {missing} or containing {present}"
    return True, "answer carries the fact"


def _read_order(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    _, answered = _answer(message)
    position = 0
    last_end = 0
    for span in message.shell:
        if position < len(rule["commands"]) and _field(span, "shell.command.name") == rule["commands"][position]:
            if span.start < last_end:
                return False, f"{rule['commands'][position]} started before the previous read ended"
            last_end = span.end
            position += 1
    if position < len(rule["commands"]):
        return False, f"only {position} of {rule['commands']} ran in order"
    if last_end > answered:
        return False, "the final answer was given before the last read ended"
    return True, "reads ran in order before the answer"


def _selection(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    for event in message.selections:
        if all(event.attributes.get(key) == value for key, value in rule["match"].items()):
            return True, f"selection record {event.attributes.get('record_id')} matched"
    return False, f"no {evidence.SELECTION_EVENT} among {len(message.selections)} matched {rule['match']}"


RULES = {
    "fact": _fact,
    "script": _script,
    "output": _output,
    "readOrder": _read_order,
    "selection": _selection,
}


def grade(export: Export | None, rules: list[dict[str, Any]], completeness: dict[str, Any]) -> dict[str, Any]:
    if completeness["status"] != "complete" or export is None:
        return {
            "gradeVersion": GRADE_VERSION,
            "status": "infrastructure_error",
            "score": None,
            "reasons": ["bundle is incomplete; no model score"] + [r["code"] for r in completeness["reasons"]],
            "rules": [],
        }
    messages = evidence.messages(export)
    results = []
    gaps = []
    for index, rule in enumerate(rules):
        try:
            passed, detail = RULES[rule["rule"]](_message(messages, rule["message"]), rule)
        except Gap as gap:
            gaps.append(f"rule {index} ({rule['rule']}): {gap}")
            results.append({"index": index, "rule": rule["rule"], "message": rule["message"], "result": "gap", "detail": str(gap)})
            continue
        results.append(
            {"index": index, "rule": rule["rule"], "message": rule["message"], "result": "pass" if passed else "fail", "detail": detail}
        )
    if gaps:
        return {"gradeVersion": GRADE_VERSION, "status": "infrastructure_error", "score": None, "reasons": gaps, "rules": results}
    failed = [item for item in results if item["result"] == "fail"]
    return {
        "gradeVersion": GRADE_VERSION,
        "status": "failed" if failed else "passed",
        "score": 0.0 if failed else 1.0,
        "reasons": [f"rule {item['index']} ({item['rule']}): {item['detail']}" for item in failed],
        "rules": results,
    }
