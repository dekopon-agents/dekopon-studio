"""Grade a complete trial from structured evidence, never from socket reply lines.

Rules are scenario data (`expect.rules`), each bound to one message ordinal. They follow the S4
p5 judge (answer facts, script needles, output counts, read order) over native evidence:

- `fact`: the final `agent.model.answer` holds every `allOf` fact and one of each `anyOf` group,
  case-insensitively.
- `script`: over the message's `shell.command` lines (word and arguments), case-insensitively:
  every `allOf` needle, no `noneOf` needle, `countMax` per needle, at most `max` commands; and, when
  `command` is set, one such command with every `argumentsContain` token and the given `outcome`
  and `exitCode`.
- `output`: across `shell.command` outputs (optionally only `command`), each `count` needle appears
  between its bounds, inclusive.
- `readOrder`: for each `pairs` entry `[script needle, output needle]`, once an output shows the
  output needle, a command holding the script needle ran at or before it.
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


def _answer(message: evidence.Message) -> str:
    event = message.final_answer()
    if event is None:
        raise Gap(f"message {message.ordinal} has no final {evidence.ANSWER_EVENT}")
    answer = event.attributes.get("answer")
    if not isinstance(answer, str):
        raise Gap(f"message {message.ordinal} final answer has no answer attribute")
    return answer


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


def _line(span: Span) -> str:
    """One command as the model wrote it: its word and arguments."""
    return " ".join([str(_field(span, "shell.command.name")), *_arguments(span)])


def _script(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    lines = [_line(span) for span in message.shell]
    lowered = "\n".join(lines).lower()
    problems = [f"script-missing:{n}" for n in rule.get("allOf", []) if n.lower() not in lowered]
    problems += [f"script-forbidden:{n}" for n in rule.get("noneOf", []) if n.lower() in lowered]
    problems += [f"script-count:{n}>{most}" for n, most in rule.get("countMax", {}).items() if lowered.count(n.lower()) > most]
    if "max" in rule and len(lines) > rule["max"]:
        problems.append(f"scripts>{rule['max']}")
    if "command" in rule:
        matched = False
        for span in _commands(message, rule["command"]):
            if not all(token in _arguments(span) for token in rule.get("argumentsContain", [])):
                continue
            if "outcome" in rule and _field(span, "outcome") != rule["outcome"]:
                continue
            # Exported as an OTLP intValue, which some exporters stringify; compare the number.
            if "exitCode" in rule and str(_field(span, "shell.command.exit_code")) != str(rule["exitCode"]):
                continue
            matched = True
            break
        if not matched:
            problems.append(f"no {rule['command']} command matched")
    return (not problems), "; ".join(problems) or f"{len(lines)} commands matched"


def _output(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    outputs = [str(_field(span, "shell.command.output")) for span in _commands(message, rule.get("command"))]
    problems = []
    for needle, (least, most) in rule["count"].items():
        seen = sum(output.count(needle) for output in outputs)
        if not least <= seen <= most:
            problems.append(f"output-count:{needle}={seen}")
    return (not problems), "; ".join(problems) or "output counts in range"


def _fact(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    answer = _answer(message)
    lowered = answer.lower()
    problems = [f"answer-missing:{fact}" for fact in rule.get("allOf", []) if fact.lower() not in lowered]
    problems += [f"answer-any-of-missing:{'|'.join(group)}" for group in rule.get("anyOf", [])
                 if not any(fact.lower() in lowered for fact in group)]
    return (not problems), "; ".join(problems) or "answer carries the facts"


def _read_order(message: evidence.Message, rule: dict[str, Any]) -> tuple[bool, str]:
    """For each [script needle, output needle]: once an output shows the needle, a command whose
    line holds the script needle ran at or before it."""
    lines = [_line(span).lower() for span in message.shell]
    outputs = [str(_field(span, "shell.command.output")) for span in message.shell]
    problems = []
    for script_needle, output_needle in rule["pairs"]:
        read = next((i for i, line in enumerate(lines) if script_needle.lower() in line), None)
        wrote = next((i for i, output in enumerate(outputs) if output_needle in output), None)
        if wrote is not None and (read is None or read > wrote):
            problems.append(f"order:{script_needle}<{output_needle}")
    return (not problems), "; ".join(problems) or "reads ran before their outputs"


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
