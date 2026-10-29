"""Per-message evidence reconstructed from one trial's OTLP export.

A message is anchored by the earliest `gateway.message` span in its trace (a queued message can
open a second one in the same trace); the driver sends strictly one message at a time, so ordering
anchors by start time gives message ordinals. Everything in an anchor's trace belongs to that
message. Each bash call the model made is one script: its `agent.tool.script` text and its
`agent.tool.output` result, paired by `gen_ai.tool.call.id`. Model sessions are `prompt.session` spans: each `agent.model.prompt`
event sits on a `prompt.model_turn` span whose parent is its session.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .otlp import Event, Export, Span, embedded_json

ANCHOR_SPAN = "gateway.message"
TURN_SPAN = "prompt.model_turn"
SHELL_SPAN = "shell.command"
PROMPT_EVENT = "agent.model.prompt"
ANSWER_EVENT = "agent.model.answer"
SELECTION_EVENT = "gateway_memory_selection"
SCRIPT_EVENT = "agent.tool.script"
OUTPUT_EVENT = "agent.tool.output"
CALL_ID = "gen_ai.tool.call.id"


@dataclass
class Prompt:
    session: str
    turn: int | None
    scope: str | None
    count: int | None
    messages: list[Any] | None
    event: Event


@dataclass
class Script:
    """One bash call: what the model ran and everything it got back, unbounded by dekopon."""

    call_id: Any
    time: int
    script: Any = None
    output: Any = None
    has_output: bool = False


@dataclass
class Message:
    ordinal: int
    anchor: Span
    prompts: list[Prompt] = field(default_factory=list)
    answers: list[Event] = field(default_factory=list)
    shell: list[Span] = field(default_factory=list)
    selections: list[Event] = field(default_factory=list)
    scripts: list[Script] = field(default_factory=list)

    def final_answer(self) -> Event | None:
        """The last completed answer that proposed no tool call; it is what the person was sent."""
        for event in reversed(self.answers):
            if event.attributes.get("stream.interrupted") is True:
                continue
            calls = event.attributes.get("tool_calls")
            if isinstance(calls, str):
                calls = embedded_json(calls)
            if calls == []:
                return event
        return None


def decimal(value: Any) -> int | None:
    """A count, length or code as dekopon 0.62.0 exports it: span and event attributes arrive as
    stringValue decimal text ("44"), so text and integers are both accepted; nothing else is."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    # isdigit() admits "²", which int() refuses; only bounded ASCII decimal text is a number here.
    if isinstance(value, str) and value.isascii() and value.isdecimal() and len(value) <= 20:
        return int(value)
    return None


def _session(event: Event, spans: dict[tuple[str, str], Span]) -> str:
    span = spans.get((event.trace_id, event.span_id))
    if span is not None and span.name == TURN_SPAN and span.parent_span_id:
        return f"{event.trace_id}/{span.parent_span_id}"
    return f"{event.trace_id}/{event.span_id}"


def _prompt(events: list[Event], spans: dict[tuple[str, str], Span]) -> Prompt:
    first = events[0]
    scope = first.attributes.get("transcript.scope")
    count = decimal(first.attributes.get("message.count"))
    turn = decimal(first.attributes.get("model.turn"))
    segmented = any("transcript.segment" in e.attributes or "transcript.segments" in e.attributes for e in events)
    total = decimal(first.attributes.get("transcript.segments")) if segmented else 1
    pieces = sorted(events, key=lambda e: decimal(e.attributes.get("transcript.segment")) or 0)
    valid = total == len(pieces) and all(
        (not segmented or decimal(e.attributes.get("transcript.segment")) == index + 1 and
         decimal(e.attributes.get("transcript.segments")) == total) and
        e.attributes.get("transcript.scope") == scope and decimal(e.attributes.get("message.count")) == count and
        decimal(e.attributes.get("model.turn")) == turn and isinstance(e.attributes.get("messages"), str)
        for index, e in enumerate(pieces))
    candidate = embedded_json("".join(e.attributes["messages"] for e in pieces)) if valid else None
    return Prompt(session=_session(first, spans), turn=turn, scope=scope if isinstance(scope, str) else None,
                  count=count, messages=candidate if isinstance(candidate, list) else None, event=first)


def messages(export: Export) -> list[Message]:
    spans = export.span_index()
    earliest: dict[str, Span] = {}
    for span in export.spans:
        if span.name == ANCHOR_SPAN and (span.trace_id not in earliest or span.start < earliest[span.trace_id].start):
            earliest[span.trace_id] = span
    by_trace: dict[str, Message] = {}
    ordered = []
    for ordinal, anchor in enumerate(sorted(earliest.values(), key=lambda span: span.start), 1):
        message = Message(ordinal=ordinal, anchor=anchor)
        ordered.append(message)
        by_trace[anchor.trace_id] = message
    prompts: dict[tuple[str, str], list[Event]] = {}
    for event in export.events():
        message = by_trace.get(event.trace_id)
        if message is None:
            continue
        if event.kind == PROMPT_EVENT:
            prompts.setdefault((event.trace_id, event.span_id), []).append(event)
        elif event.kind == ANSWER_EVENT:
            message.answers.append(event)
        elif event.kind == SELECTION_EVENT:
            message.selections.append(event)
        elif event.kind == SCRIPT_EVENT:
            message.scripts.append(Script(event.attributes.get(CALL_ID), event.time, event.attributes.get("script")))
        elif event.kind == OUTPUT_EVENT:
            call = event.attributes.get(CALL_ID)
            script = next((item for item in message.scripts if item.call_id == call and not item.has_output), None)
            if script is None:  # An output with no script before it: keep it, so grading sees the gap.
                script = Script(call, event.time)
                message.scripts.append(script)
            script.output, script.has_output = event.attributes.get("output"), True
    for (trace_id, _), events in prompts.items():
        by_trace[trace_id].prompts.append(_prompt(events, spans))
    for span in sorted(export.spans, key=lambda span: span.start):
        message = by_trace.get(span.trace_id)
        if message is not None and span.name == SHELL_SPAN:
            message.shell.append(span)
    return ordered


def continuity_gaps(prompts: list[Prompt]) -> list[str]:
    """`message.count` is the transcript length (dekopon-agent prompt.rs, `messages.len()`), not a
    per-event sequence. Within one model session a `full` prompt carries the whole transcript and a
    `delta` prompt carries only what was appended since the previous prompt, so each declared
    length must equal what the session's prompts actually carry."""
    gaps = []
    sessions: dict[str, list[Prompt]] = {}
    for prompt in prompts:
        sessions.setdefault(prompt.session, []).append(prompt)
    for session, items in sessions.items():
        previous: int | None = None
        for prompt in items:
            where = f"session {session} turn {prompt.turn}"
            if prompt.count is None or prompt.messages is None or prompt.scope not in ("full", "delta"):
                gaps.append(f"{where}: prompt lacks message.count, transcript.scope or a messages array")
                previous = None
                continue
            if prompt.scope == "full":
                expected = len(prompt.messages)
            elif previous is None:
                gaps.append(f"{where}: delta prompt has no earlier prompt in its session")
                previous = prompt.count
                continue
            else:
                expected = previous + len(prompt.messages)
            if prompt.count != expected:
                gaps.append(f"{where}: message.count {prompt.count} but the transcript carries {expected}")
            previous = prompt.count
    return gaps
