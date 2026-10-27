"""Read OTLP JSON lines written by the OpenTelemetry Collector `file` exporter.

Each line is one export request: `{"resourceSpans": [...]}` or `{"resourceLogs": [...]}`.
Dekopon audit records reach the export two ways: as span events on the span that was current
when they were emitted (gatewayd exports `dekopon_agent::audit` only through traces) and as log
records (brokerd and gatewayd's `job`/`meter` targets). `events()` folds both into one shape and
drops correlated copies, so a grader never counts one record twice.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class ExportError(ValueError):
    """An export file is missing, unreadable or not OTLP JSON lines."""


def any_value(value: dict[str, Any]) -> Any:
    """Decode one OTLP AnyValue. intValue arrives as a JSON string under proto3 JSON mapping."""
    if not isinstance(value, dict) or not value:
        return None
    kind, inner = next(iter(value.items()))
    if kind == "stringValue":
        return inner
    if kind == "intValue":
        return int(inner)
    if kind == "doubleValue":
        return float(inner)
    if kind == "boolValue":
        return bool(inner)
    if kind == "arrayValue":
        return [any_value(item) for item in inner.get("values", [])]
    if kind == "kvlistValue":
        return attributes(inner.get("values", []))
    if kind == "bytesValue":
        return inner
    raise ExportError(f"unknown OTLP AnyValue kind {kind!r}")


def attributes(items: list[dict[str, Any]] | None) -> dict[str, Any]:
    return {item["key"]: any_value(item.get("value", {})) for item in items or []}


@dataclass(frozen=True)
class Span:
    service: str | None
    trace_id: str
    span_id: str
    parent_span_id: str
    name: str
    start: int
    end: int
    attributes: dict[str, Any]
    status: dict[str, Any]


@dataclass(frozen=True)
class Event:
    """One audit-bearing record, from a span event or a log record."""

    source: str  # "span" or "log"
    service: str | None
    trace_id: str
    span_id: str
    time: int
    name: str
    severity: str | None
    attributes: dict[str, Any] = field(hash=False)

    @property
    def kind(self) -> str:
        """The record's stable name: `audit.event`, else gateway `event`, else the message."""
        for key in ("audit.event", "event"):
            value = self.attributes.get(key)
            if isinstance(value, str) and value:
                return value
        return self.name


# Attributes the two export paths add differently for one tracing event; they never decide identity.
_PATH_ATTRIBUTES = ("level", "target", "name", "message")
_PATH_PREFIXES = ("code.", "thread.", "log.", "busy_ns", "idle_ns")


def _identity(event: Event) -> tuple[str, str, str, str]:
    kept = {
        key: value
        for key, value in event.attributes.items()
        if key not in _PATH_ATTRIBUTES and not key.startswith(_PATH_PREFIXES)
    }
    return (event.trace_id, event.span_id, event.kind, json.dumps(kept, sort_keys=True))


def read_lines(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise ExportError(f"{path.name} is missing")
    requests = []
    with path.open("rb") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as error:
                raise ExportError(f"{path.name}:{number} is not JSON: {error.msg}") from None
            if not isinstance(request, dict):
                raise ExportError(f"{path.name}:{number} is not an OTLP export object")
            requests.append(request)
    return requests


def _service(resource: dict[str, Any]) -> str | None:
    value = attributes(resource.get("attributes")).get("service.name")
    return value if isinstance(value, str) else None


@dataclass
class Export:
    spans: list[Span]
    log_events: list[Event]

    @classmethod
    def load(cls, traces: Path, logs: Path) -> "Export":
        spans: list[Span] = []
        log_events: list[Event] = []
        for request in read_lines(traces):
            if "resourceSpans" not in request:
                raise ExportError(f"{traces.name} holds a non-trace export")
            for resource in request["resourceSpans"]:
                service = _service(resource.get("resource", {}))
                for scope in resource.get("scopeSpans", []):
                    for span in scope.get("spans", []):
                        spans.append(
                            Span(
                                service=service,
                                trace_id=span.get("traceId", ""),
                                span_id=span.get("spanId", ""),
                                parent_span_id=span.get("parentSpanId", ""),
                                name=span.get("name", ""),
                                start=int(span.get("startTimeUnixNano", 0)),
                                end=int(span.get("endTimeUnixNano", 0)),
                                attributes=attributes(span.get("attributes")),
                                status=span.get("status", {}),
                            )
                        )
                        for item in span.get("events", []):
                            log_events.append(
                                Event(
                                    source="span",
                                    service=service,
                                    trace_id=span.get("traceId", ""),
                                    span_id=span.get("spanId", ""),
                                    time=int(item.get("timeUnixNano", 0)),
                                    name=item.get("name", ""),
                                    severity=None,
                                    attributes=attributes(item.get("attributes")),
                                )
                            )
        for request in read_lines(logs):
            if "resourceLogs" not in request:
                raise ExportError(f"{logs.name} holds a non-log export")
            for resource in request["resourceLogs"]:
                service = _service(resource.get("resource", {}))
                for scope in resource.get("scopeLogs", []):
                    for record in scope.get("logRecords", []):
                        body = any_value(record.get("body", {}))
                        log_events.append(
                            Event(
                                source="log",
                                service=service,
                                trace_id=record.get("traceId", ""),
                                span_id=record.get("spanId", ""),
                                time=int(record.get("timeUnixNano") or record.get("observedTimeUnixNano") or 0),
                                name=body if isinstance(body, str) else "",
                                severity=record.get("severityText"),
                                attributes=attributes(record.get("attributes")),
                            )
                        )
        return cls(spans=spans, log_events=log_events)

    def events(self) -> list[Event]:
        """Every audit record once, in time order; a span-event copy wins over its log copy."""
        seen: set[tuple[str, str, str, str]] = set()
        unique = []
        for event in sorted(self.log_events, key=lambda item: (item.source != "span", item.time)):
            identity = _identity(event)
            if identity in seen:
                continue
            seen.add(identity)
            unique.append(event)
        return sorted(unique, key=lambda item: item.time)

    def span_index(self) -> dict[tuple[str, str], Span]:
        return {(span.trace_id, span.span_id): span for span in self.spans}
