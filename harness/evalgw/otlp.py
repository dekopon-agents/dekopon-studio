"""Read OTLP JSON lines written by the OpenTelemetry Collector `file` exporter.

Each line is one export request: `{"resourceSpans": [...]}` or `{"resourceLogs": [...]}`.
Dekopon audit records reach the export two ways: as span events on the span that was current
when they were emitted (gatewayd exports `dekopon_agent::audit` only through traces) and as log
records (brokerd and gatewayd's `job`/`meter` targets). `events()` folds both into one shape and
drops correlated copies, so a grader never counts one record twice.
"""

from __future__ import annotations

import json
import math
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
    """An OTLP repeated field: absent means empty; anything but a list, explicit null included, is
    malformed. The Collector's file exporter never writes null, so a null marks a damaged export."""
    value = container.get(key, [])
    if not isinstance(value, list):
        raise ExportError(f"{where}.{key} is not a list")
    return value


# OTLP fixed64/int64 ranges; JSON can carry far larger numbers than the protobuf field holds.
MAX_UNSIGNED = 2**64 - 1
INT64 = (-(2**63), 2**63 - 1)
MAX_VALUE_DEPTH = 32
# Every conversion of an untrusted value can raise one of these; none may escape as anything but
# ExportError, or finalization would stop before writing its grade.
CONVERSION_ERRORS = (ValueError, OverflowError, TypeError, RecursionError, MemoryError)


def scalar(value: Any, kind: str, where: str) -> Any:
    """The one conversion every untrusted OTLP scalar goes through.

    `string`: a JSON string. `nanos`: a fixed64 timestamp, as a decimal string or integer.
    `int64`: an intValue, likewise. `double`: a finite doubleValue. `bool`: a JSON boolean.
    """
    try:
        if kind == "string" and isinstance(value, str):
            return value
        if kind == "bool" and isinstance(value, bool):
            return value
        if kind in ("nanos", "int64") and not isinstance(value, bool) and isinstance(value, (int, str)):
            if isinstance(value, str) and not (value.isascii() and value.lstrip("-").isdigit() and len(value) <= 20):
                raise ValueError("not a bounded decimal integer")
            number = int(value)
            low, high = (0, MAX_UNSIGNED) if kind == "nanos" else INT64
            if low <= number <= high:
                return number
        if kind == "double" and not isinstance(value, bool) and isinstance(value, (int, float, str)):
            if isinstance(value, int) and abs(value) > 2**1024:
                raise OverflowError("integer too large for a double")
            number = float(value)
            if math.isfinite(number):
                return number
    except CONVERSION_ERRORS as error:
        raise ExportError(f"{where} is not a valid {kind}: {type(error).__name__}") from None
    raise ExportError(f"{where} is not a valid {kind}")


def embedded_json(text: Any) -> Any:
    """Decode JSON carried inside a string attribute; anything undecodable is None, never an error."""
    if not isinstance(text, str):
        return None
    try:
        return json.loads(text)
    except CONVERSION_ERRORS:
        return None


def _string(container: dict[str, Any], key: str, where: str) -> str:
    return scalar(container.get(key, ""), "string", f"{where}.{key}")


def _nanos(container: dict[str, Any], key: str, where: str) -> int:
    """fixed64 fields arrive as decimal strings under the proto3 JSON mapping."""
    return scalar(container.get(key, 0), "nanos", f"{where}.{key}")


def any_value(value: Any, where: str = "value", depth: int = 0) -> Any:
    """Decode one OTLP AnyValue. intValue arrives as a JSON string under proto3 JSON mapping."""
    if depth > MAX_VALUE_DEPTH:
        raise ExportError(f"{where} nests deeper than {MAX_VALUE_DEPTH}")
    value = _object(value, where)
    if not value:
        return None
    if len(value) != 1:
        raise ExportError(f"{where} holds more than one AnyValue kind")
    kind, inner = next(iter(value.items()))
    scalars = {"stringValue": "string", "bytesValue": "string", "intValue": "int64", "doubleValue": "double", "boolValue": "bool"}
    if kind in scalars:
        return scalar(inner, scalars[kind], f"{where}.{kind}")
    if kind == "arrayValue":
        items = _array(_object(inner, f"{where}.arrayValue"), "values", f"{where}.arrayValue")
        return [any_value(item, f"{where}.arrayValue.values", depth + 1) for item in items]
    if kind == "kvlistValue":
        return attributes(_array(_object(inner, f"{where}.kvlistValue"), "values", f"{where}.kvlistValue"), where, depth + 1)
    raise ExportError(f"{where} has unknown AnyValue kind {kind!r}")


def attributes(items: Any, where: str = "attributes", depth: int = 0) -> dict[str, Any]:
    if not isinstance(items, list):
        raise ExportError(f"{where} is not a list")
    decoded = {}
    for item in items:
        item = _object(item, where)
        key = scalar(item.get("key"), "string", f"{where} key")
        decoded[key] = any_value(item.get("value", {}), f"{where}[{key}]", depth)
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
            # JSONDecodeError, CPython's integer digit limit and deep nesting all land here.
            except CONVERSION_ERRORS as error:
                raise ExportError(f"{where} is not JSON: {error}") from None
            yield where, _object(request, where)


def _service(resource: dict[str, Any], where: str) -> str | None:
    resource = _object(resource.get("resource", {}), f"{where}.resource")
    value = attributes(_array(resource, "attributes", f"{where}.resource"), f"{where}.resource.attributes").get("service.name")
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
                _string(_object(scope.get("scope", {}), f"{line} scope"), "name", f"{line} scope")
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
                        attributes=attributes(_array(raw, "attributes", where), f"{where}.attributes"),
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
                                attributes=attributes(_array(item, "attributes", f"{where} event"), f"{where} event.attributes"),
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
                _string(_object(scope.get("scope", {}), f"{line} scope"), "name", f"{line} scope")
                for record in _array(scope, "logRecords", line):
                    where = f"{line} logRecord"
                    record = _object(record, where)
                    body = any_value(record.get("body", {}), f"{where}.body")
                    time = _nanos(record, "timeUnixNano", where) or _nanos(record, "observedTimeUnixNano", where)
                    severity = _string(record, "severityText", where) if "severityText" in record else None
                    yield Event(
                        source="log",
                        service=service,
                        trace_id=_string(record, "traceId", where),
                        span_id=_string(record, "spanId", where),
                        time=time,
                        name=body if isinstance(body, str) else "",
                        severity=severity,
                        attributes=attributes(_array(record, "attributes", where), f"{where}.attributes"),
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
