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
from typing import Any, Iterator


class ExportError(ValueError):
    """An export file is missing, unreadable or not OTLP JSON lines."""


def _object(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ExportError(f"{where} is not an object")
    return value


def _array(container: dict[str, Any], key: str, where: str) -> list[Any]:
    """An OTLP repeated field: absent means empty, anything but a list is malformed."""
    value = container.get(key, [])
    if not isinstance(value, list):
        raise ExportError(f"{where}.{key} is not a list")
    return value


def _string(container: dict[str, Any], key: str, where: str) -> str:
    value = container.get(key, "")
    if not isinstance(value, str):
        raise ExportError(f"{where}.{key} is not a string")
    return value


def _nanos(container: dict[str, Any], key: str, where: str) -> int:
    """fixed64 fields arrive as decimal strings under the proto3 JSON mapping."""
    value = container.get(key, 0)
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ExportError(f"{where}.{key} is not a timestamp")
    try:
        return int(value)
    except ValueError:
        raise ExportError(f"{where}.{key} is not a timestamp") from None


def any_value(value: Any, where: str = "value") -> Any:
    """Decode one OTLP AnyValue. intValue arrives as a JSON string under proto3 JSON mapping."""
    value = _object(value, where)
    if not value:
        return None
    if len(value) != 1:
        raise ExportError(f"{where} holds more than one AnyValue kind")
    kind, inner = next(iter(value.items()))
    try:
        if kind in ("stringValue", "bytesValue") and isinstance(inner, str):
            return inner
        if kind == "intValue" and isinstance(inner, (int, str)) and not isinstance(inner, bool):
            return int(inner)
        if kind == "doubleValue" and isinstance(inner, (int, float, str)) and not isinstance(inner, bool):
            return float(inner)
        if kind == "boolValue" and isinstance(inner, bool):
            return inner
    except ValueError:
        raise ExportError(f"{where}.{kind} is malformed") from None
    if kind == "arrayValue":
        items = _array(_object(inner, f"{where}.arrayValue"), "values", f"{where}.arrayValue")
        return [any_value(item, f"{where}.arrayValue.values") for item in items]
    if kind == "kvlistValue":
        return attributes(_array(_object(inner, f"{where}.kvlistValue"), "values", f"{where}.kvlistValue"), where)
    raise ExportError(f"{where} has malformed or unknown AnyValue kind {kind!r}")


def attributes(items: Any, where: str = "attributes") -> dict[str, Any]:
    if items is None:
        return {}
    if not isinstance(items, list):
        raise ExportError(f"{where} is not a list")
    decoded = {}
    for item in items:
        item = _object(item, where)
        key = item.get("key")
        if not isinstance(key, str):
            raise ExportError(f"{where} entry has no string key")
        decoded[key] = any_value(item.get("value", {}), f"{where}[{key}]")
    return decoded


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


def read_lines(path: Path) -> Iterator[tuple[str, dict[str, Any]]]:
    """Each export request with its location, one line at a time."""
    if not path.is_file():
        raise ExportError(f"{path.name} is missing")
    with path.open("rb") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            where = f"{path.name}:{number}"
            try:
                request = json.loads(line)
            # ValueError covers JSONDecodeError and CPython's integer digit limit (4300 digits).
            except ValueError as error:
                raise ExportError(f"{where} is not JSON: {error}") from None
            yield where, _object(request, where)


def _service(resource: dict[str, Any], where: str) -> str | None:
    resource = _object(resource.get("resource", {}), f"{where}.resource")
    value = attributes(resource.get("attributes"), f"{where}.resource.attributes").get("service.name")
    return value if isinstance(value, str) else None


def _spans(path: Path) -> Iterator[tuple[Span, list[Event]]]:
    for line, request in read_lines(path):
        if "resourceSpans" not in request:
            raise ExportError(f"{line} holds a non-trace export")
        for resource in _array(request, "resourceSpans", line):
            resource = _object(resource, f"{line} resourceSpans")
            service = _service(resource, line)
            for scope in _array(resource, "scopeSpans", line):
                scope = _object(scope, f"{line} scopeSpans")
                for raw in _array(scope, "spans", line):
                    where = f"{line} span"
                    raw = _object(raw, where)
                    trace_id, span_id = _string(raw, "traceId", where), _string(raw, "spanId", where)
                    span = Span(
                        service=service,
                        trace_id=trace_id,
                        span_id=span_id,
                        parent_span_id=_string(raw, "parentSpanId", where),
                        name=_string(raw, "name", where),
                        start=_nanos(raw, "startTimeUnixNano", where),
                        end=_nanos(raw, "endTimeUnixNano", where),
                        attributes=attributes(raw.get("attributes"), f"{where}.attributes"),
                        status=_object(raw.get("status", {}), f"{where}.status"),
                    )
                    events = []
                    for item in _array(raw, "events", where):
                        item = _object(item, f"{where} event")
                        events.append(
                            Event(
                                source="span",
                                service=service,
                                trace_id=trace_id,
                                span_id=span_id,
                                time=_nanos(item, "timeUnixNano", f"{where} event"),
                                name=_string(item, "name", f"{where} event"),
                                severity=None,
                                attributes=attributes(item.get("attributes"), f"{where} event.attributes"),
                            )
                        )
                    yield span, events


def _logs(path: Path) -> Iterator[Event]:
    for line, request in read_lines(path):
        if "resourceLogs" not in request:
            raise ExportError(f"{line} holds a non-log export")
        for resource in _array(request, "resourceLogs", line):
            resource = _object(resource, f"{line} resourceLogs")
            service = _service(resource, line)
            for scope in _array(resource, "scopeLogs", line):
                scope = _object(scope, f"{line} scopeLogs")
                for record in _array(scope, "logRecords", line):
                    where = f"{line} logRecord"
                    record = _object(record, where)
                    body = any_value(record.get("body", {}), f"{where}.body")
                    time = _nanos(record, "timeUnixNano", where) or _nanos(record, "observedTimeUnixNano", where)
                    severity = record.get("severityText")
                    yield Event(
                        source="log",
                        service=service,
                        trace_id=_string(record, "traceId", where),
                        span_id=_string(record, "spanId", where),
                        time=time,
                        name=body if isinstance(body, str) else "",
                        severity=severity if isinstance(severity, str) else None,
                        attributes=attributes(record.get("attributes"), f"{where}.attributes"),
                    )


@dataclass
class Export:
    spans: list[Span]
    log_events: list[Event]

    @classmethod
    def load(cls, traces: Path, logs: Path) -> "Export":
        """Both exports, read one request at a time; any malformed shape is an ExportError."""
        spans: list[Span] = []
        events: list[Event] = []
        for span, span_events in _spans(traces):
            spans.append(span)
            events.extend(span_events)
        events.extend(_logs(logs))
        return cls(spans=spans, log_events=events)

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
