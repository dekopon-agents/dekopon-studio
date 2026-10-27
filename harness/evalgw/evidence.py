"""Per-message evidence reconstructed from one trial's OTLP export.

A message is anchored by its `gateway.message` span; the driver sends strictly one message at a
time, so ordering anchors by start time gives message ordinals. Everything in an anchor's trace
belongs to that message. Model sessions are `prompt.session` spans: each `agent.model.prompt`
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


@dataclass
class Prompt:
    session: str
    turn: int | None
    scope: str | None
    count: int | None
    messages: list[Any] | None
    event: Event


@dataclass
class Message:
    ordinal: int
    anchor: Span
    prompts: list[Prompt] = field(default_factory=list)
    answers: list[Event] = field(default_factory=list)
    shell: list[Span] = field(default_factory=list)
    selections: list[Event] = field(default_factory=list)

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


def _integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _session(event: Event, spans: dict[tuple[str, str], Span]) -> str:
    span = spans.get((event.trace_id, event.span_id))
    if span is not None and span.name == TURN_SPAN and span.parent_span_id:
        return f"{event.trace_id}/{span.parent_span_id}"
    return f"{event.trace_id}/{event.span_id}"


def _prompt(event: Event, spans: dict[tuple[str, str], Span]) -> Prompt:
    messages = event.attributes.get("messages")
    candidate = embedded_json(messages)
    decoded = candidate if isinstance(candidate, list) else None
    scope = event.attributes.get("transcript.scope")
    return Prompt(
        session=_session(event, spans),
        turn=_integer(event.attributes.get("model.turn")),
        scope=scope if isinstance(scope, str) else None,
        count=_integer(event.attributes.get("message.count")),
        messages=decoded,
        event=event,
    )


def messages(export: Export) -> list[Message]:
    spans = export.span_index()
    anchors = sorted((span for span in export.spans if span.name == ANCHOR_SPAN), key=lambda span: span.start)
    by_trace: dict[str, Message] = {}
    ordered = []
    for ordinal, anchor in enumerate(anchors, 1):
        message = Message(ordinal=ordinal, anchor=anchor)
        ordered.append(message)
        by_trace.setdefault(anchor.trace_id, message)
    for event in export.events():
        message = by_trace.get(event.trace_id)
        if message is None:
            continue
        if event.kind == PROMPT_EVENT:
            message.prompts.append(_prompt(event, spans))
        elif event.kind == ANSWER_EVENT:
            message.answers.append(event)
        elif event.kind == SELECTION_EVENT:
            message.selections.append(event)
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
