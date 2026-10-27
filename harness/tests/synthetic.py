"""Synthetic trial evidence in the shapes the Collector file exporter and the daemons write.

`write_bundle` lays down a complete two-message attempt for the acceptance scenario; tests then
change one thing and assert the contract outcome. Nothing here comes from a real run.
"""

from __future__ import annotations

import copy
import json
import shutil
import sys
from pathlib import Path
from typing import Any

HARNESS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HARNESS))

from evalgw import otlp  # noqa: E402

SCENARIO = HARNESS / "scenarios" / "two-message.json"
BASE = 1_800_000_000_000_000_000


def value(item: Any) -> dict[str, Any]:
    """Like dekopon 0.62.0's export: numeric span and event fields arrive as stringValue text."""
    if isinstance(item, bool):
        return {"boolValue": item}
    if isinstance(item, int):
        return {"stringValue": str(item)}
    return {"stringValue": item}


def attributes(values: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"key": key, "value": value(item)} for key, item in values.items()]


def span(trace: str, span_id: str, parent: str, name: str, start: int, end: int, attrs=None, events=None) -> dict[str, Any]:
    return {
        "traceId": trace,
        "spanId": span_id,
        "parentSpanId": parent,
        "name": name,
        "startTimeUnixNano": str(start),
        "endTimeUnixNano": str(end),
        "attributes": attributes(attrs or {}),
        "events": events or [],
        "status": {},
    }


def event(name: str, time: int, attrs: dict[str, Any]) -> dict[str, Any]:
    return {"timeUnixNano": str(time), "name": name, "attributes": attributes(attrs)}


def prompt(time: int, turn: int, scope: str, count: int, messages: list[dict[str, Any]]) -> dict[str, Any]:
    return event(
        "agent.model.prompt",
        time,
        {
            "audit.event": "agent.model.prompt",
            "model.turn": turn,
            "transcript.scope": scope,
            "message.count": count,
            "messages": json.dumps(messages),
        },
    )


def answer(time: int, turn: int, text: str, tool_calls: list[Any]) -> dict[str, Any]:
    return event(
        "agent.model.answer",
        time,
        {"audit.event": "agent.model.answer", "model.turn": turn, "answer": text, "tool_calls": json.dumps(tool_calls)},
    )


def captured(key: str, text: str) -> dict[str, Any]:
    """A bounded shell attribute exported whole: its recorded length equals what was captured."""
    return {key: text, f"{key}.bytes": len(text.encode("utf-8"))}


def user(text: str) -> dict[str, Any]:
    return {"role": "user", "content": text}


def resource_spans(service: str, spans: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": attributes({"service.name": service})},
                "scopeSpans": [{"scope": {"name": service}, "spans": spans}],
            }
        ]
    }


FACT = "ledger-of-tides"
DESCRIPTION = f"Synthetic evalgw fixture: {FACT}"
# gh 0.10.0 `repo view` prints `full_name<TAB>description` and a newline.
REPO_VIEW = f"synthetic-org/fixture-repo\t{DESCRIPTION}\n"
FIRST_ANSWER = f"The description of synthetic-org/fixture-repo is: {DESCRIPTION}."
MEMORY_REPLAY = (
    '[memory: {"turns":1}]\nperson: What is the description of synthetic-org/fixture-repo?\n'
    f"you: {FIRST_ANSWER}\n[/memory]\n"
)


def script_events(time: int, call_id: str, script: str, output: str) -> list[dict[str, Any]]:
    return [
        event("agent.tool.script", time, {"audit.event": "agent.tool.script", "gen_ai.tool.call.id": call_id, "script": script}),
        event("agent.tool.output", time + 50, {"audit.event": "agent.tool.output", "gen_ai.tool.call.id": call_id, "output": output}),
    ]


def message_one() -> list[dict[str, Any]]:
    """Two model turns in one session: a bash call to gh, then the answer from its output.

    As on stock 0.62.0, the provider command's `shell.command.output` is empty while its stdout
    reached the script: the text is in `agent.tool.output`.
    """
    t = BASE
    trace = "a1" * 16
    call = [{"id": "evalgw-call-0", "type": "function", "function": {"name": "bash", "arguments": "{}"}}]
    return [
        span(trace, "1000000000000001", "", "gateway.message", t, t + 900),
        span(trace, "1000000000000002", "1000000000000001", "prompt.session", t + 10, t + 800),
        span(
            trace, "1000000000000003", "1000000000000002", "prompt.model_turn", t + 20, t + 200,
            events=[
                prompt(t + 21, 1, "full", 2, [{"role": "system", "content": "s"}, user("What is the description?")]),
                answer(t + 199, 1, "", call),
            ],
        ),
        span(
            trace, "1000000000000004", "1000000000000006", "shell.command", t + 300, t + 400,
            attrs={
                "shell.command.name": "gh",
                "shell.command.kind": "provider",
                **captured("shell.command.arguments", json.dumps(["repo", "view", "synthetic-org/fixture-repo"])),
                **captured("shell.command.output", ""),
                "shell.command.stdout.bytes": len(REPO_VIEW.encode()),
                "shell.command.exit_code": 0,
                "outcome": "succeeded",
            },
        ),
        span(
            trace, "1000000000000005", "1000000000000002", "prompt.model_turn", t + 500, t + 700,
            events=[
                prompt(
                    t + 501, 2, "delta", 4,
                    [{"role": "assistant", "content": None}, {"role": "tool", "content": REPO_VIEW}],
                ),
                answer(t + 699, 2, FIRST_ANSWER, []),
            ],
        ),
        span(
            trace, "1000000000000006", "1000000000000002", "prompt.script", t + 250, t + 450,
            events=script_events(t + 260, "evalgw-call-0", "gh repo view synthetic-org/fixture-repo", REPO_VIEW),
        ),
    ]


def message_two() -> list[dict[str, Any]]:
    """Recall from history; like the real run, the trace holds a second, later gateway.message span."""
    t = BASE + 10_000
    trace = "b2" * 16
    # As a journal-backed route replays it on 0.62.0: the earlier turn rides in an earlier user message.
    history = [
        {"role": "system", "content": "s"},
        user(MEMORY_REPLAY),
        user("Which description did you report a moment ago?"),
    ]
    return [
        span(trace, "2000000000000001", "", "gateway.message", t, t + 900),
        span(trace, "2000000000000002", "2000000000000001", "prompt.session", t + 10, t + 800),
        span(trace, "2000000000000004", "", "gateway.message", t + 850, t + 950),
        span(
            trace, "2000000000000003", "2000000000000002", "prompt.model_turn", t + 20, t + 200,
            events=[
                prompt(t + 21, 1, "full", 3, history),
                answer(t + 199, 1, f"I reported the description {DESCRIPTION}.", []),
            ],
        ),
    ]


def broker_log() -> dict[str, Any]:
    record = {
        "timeUnixNano": str(BASE + 350),
        "severityText": "INFO",
        "body": {"stringValue": "broker.execution"},
        "traceId": "a1" * 16,
        "spanId": "1000000000000004",
        "attributes": attributes({"audit.event": "broker.execution", "capability.id": "gh.repo.read", "outcome": "Succeeded"}),
    }
    return {
        "resourceLogs": [
            {
                "resource": {"attributes": attributes({"service.name": "dekopon-brokerd"})},
                "scopeLogs": [{"scope": {"name": "dekopon-brokerd"}, "logRecords": [record]}],
            }
        ]
    }


def write_lines(path: Path, requests: list[dict[str, Any]]) -> None:
    path.write_text("".join(json.dumps(request) + "\n" for request in requests))


def driver() -> dict[str, Any]:
    return {
        "attempt": "synthetic",
        "failure": None,
        "messages": [
            {"ordinal": 1, "text": "What is the default branch of synthetic-org/fixture-repo?", "reply": {"reply": "socket text"}},
            {"ordinal": 2, "text": "Which default branch did you report a moment ago?", "reply": {"reply": "socket text"}},
        ],
        "processes": {
            "gateway": {"signal": "SIGTERM", "forcedKill": False, "exitCode": 0},
            "broker": {"signal": "SIGTERM", "forcedKill": False, "exitCode": 0},
            "collector": {"forcedKill": False, "exitCode": 0},
        },
        "fixtures": {"model": {"requests": [], "violations": []}, "service": {"requests": [], "violations": []}},
    }


def write_bundle(root: Path, spans: list[dict[str, Any]] | None = None) -> Path:
    """A complete synthetic attempt at `root` (which must not exist), before completeness/grade."""
    for directory in ("trace", "journal", "config", "stdout"):
        (root / directory).mkdir(parents=True)
    write_lines(root / "trace" / "traces.jsonl", [resource_spans("dekopon-gatewayd", spans or message_one() + message_two())])
    write_lines(root / "trace" / "logs.jsonl", [broker_log()])
    shutil.copyfile(SCENARIO, root / "config" / "scenario.json")
    for daemon in ("gateway", "broker"):
        # A benign warn line: the console is at RUST_LOG=warn and only R6 signals matter.
        (root / "stdout" / f"{daemon}.jsonl").write_text(
            json.dumps({"timestamp": "t", "level": "WARN", "target": f"dekopon_{daemon}d", "message": "benign"}) + "\n"
        )
        (root / "stdout" / f"{daemon}.stderr").write_text("")
    (root / "stdout" / "collector.log").write_text("collector started\n")
    (root / "driver.json").write_text(json.dumps(driver()))
    return root


def scenario() -> dict[str, Any]:
    return copy.deepcopy(json.loads(SCENARIO.read_text()))


def append_console(root: Path, daemon: str, line: dict[str, Any] | str, stream: str = "jsonl") -> None:
    text = line if isinstance(line, str) else json.dumps(line)
    with (root / "stdout" / f"{daemon}.{stream}").open("a") as handle:
        handle.write(text + "\n")
