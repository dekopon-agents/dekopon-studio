"""Decide whether a trial bundle is complete evidence (SHARED.md R6 as summarized in the brief).

A bundle is incomplete when either daemon's console reports a telemetry loss, when an export is
missing or malformed, when a process or the receiver failed, when a sent message lacks its
evidence, or when a model session's `message.count` is discontinuous. An incomplete bundle is an
infrastructure error: it never yields a model score.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import evidence
from .otlp import Export, ExportError, embedded_json

DAEMONS = ("gateway", "broker")

# Console signals that mean exported evidence may be missing (R6).
CONSOLE_DROPPED = "telemetry.console.dropped"
SHUTDOWN_FAILED = "gateway_telemetry_shutdown_failed"
SESSIONS_ABANDONED = "gateway_sessions_abandoned"
# Startup text the telemetry crate prints to stderr when it cannot build an exporter.
STDERR_EXPORTER_DISABLED = ("telemetry disabled:", "log export disabled:")
# Reason codes that come from the daemons' own consoles; the manifest lists them as loss signals.
CONSOLE_CODES = (
    "opentelemetry_diagnostic",
    "telemetry_console_dropped",
    SHUTDOWN_FAILED,
    SESSIONS_ABANDONED,
    "console_missing",
    "console_malformed",
)


@dataclass(frozen=True)
class Reason:
    code: str
    detail: str

    def to_json(self) -> dict[str, str]:
        return {"code": self.code, "detail": self.detail}


def console_signals(daemon: str, stdout: Path, stderr: Path) -> list[Reason]:
    """Every R6 loss signal in one daemon's console streams, in line order."""
    reasons: list[Reason] = []
    if not stdout.is_file():
        return [Reason("console_missing", f"{daemon} stdout was not captured")]
    for number, raw in enumerate(stdout.read_bytes().splitlines(), 1):
        if not raw.strip():
            continue
        where = f"{daemon} stdout line {number}"
        line = embedded_json(raw.decode("utf-8", "replace"))
        if not isinstance(line, dict):
            reasons.append(Reason("console_malformed", f"{where} is not a JSON object"))
            continue
        reasons.extend(_line_signals(where, line))
    if not stderr.is_file():
        reasons.append(Reason("console_missing", f"{daemon} stderr was not captured"))
        return reasons
    for number, raw in enumerate(stderr.read_bytes().splitlines(), 1):
        text = raw.decode("utf-8", "replace")
        where = f"{daemon} stderr line {number}"
        line = embedded_json(text)
        if isinstance(line, dict):
            reasons.extend(_line_signals(where, line))
            continue
        lowered = text.lower()
        if "opentelemetry" in lowered or any(marker in lowered for marker in STDERR_EXPORTER_DISABLED):
            reasons.append(Reason("opentelemetry_diagnostic", f"{where}: {text.strip()[:200]}"))
        elif SHUTDOWN_FAILED in text or "gateway.telemetry.shutdown.failed" in text:
            reasons.append(Reason(SHUTDOWN_FAILED, where))
        elif SESSIONS_ABANDONED in text or "gateway.sessions.abandoned" in text:
            reasons.append(Reason(SESSIONS_ABANDONED, where))
        elif CONSOLE_DROPPED in text:
            reasons.append(Reason("telemetry_console_dropped", where))
    return reasons


def _line_signals(where: str, line: dict[str, Any]) -> list[Reason]:
    reasons = []
    level = str(line.get("level", "")).upper()
    target = str(line.get("target", ""))
    names = {line.get("audit.event"), line.get("event"), line.get("message")}
    if target.startswith("opentelemetry") and level in ("WARN", "ERROR"):
        reasons.append(Reason("opentelemetry_diagnostic", f"{where}: {level} from {target}"))
    if CONSOLE_DROPPED in names:
        reasons.append(Reason("telemetry_console_dropped", f"{where}: {line.get('console.dropped.lines')} lines"))
    if SHUTDOWN_FAILED in names or "gateway.telemetry.shutdown.failed" in names:
        reasons.append(Reason(SHUTDOWN_FAILED, where))
    if SESSIONS_ABANDONED in names or "gateway.sessions.abandoned" in names:
        reasons.append(Reason(SESSIONS_ABANDONED, where))
    return reasons


def collector_errors(log: Path) -> list[Reason]:
    """The Collector's console uses zap's tab-separated encoder; an `error` level line means an
    export may not have reached its file even when the process exits 0."""
    if not log.is_file():
        return [Reason("receiver_failure", "collector log was not captured")]
    reasons = []
    for number, raw in enumerate(log.read_bytes().splitlines(), 1):
        fields = raw.decode("utf-8", "replace").split("\t")
        if len(fields) > 1 and fields[1].strip().lower() in ("error", "dpanic", "panic", "fatal"):
            reasons.append(Reason("receiver_failure", f"collector log line {number}: {fields[1].strip()}"))
    return reasons


def driver_failures(driver: dict[str, Any] | None, sent: int) -> list[Reason]:
    if driver is None:
        return [Reason("driver_record_missing", "driver.json was not written")]
    reasons = []
    if driver.get("failure"):
        reasons.append(Reason("driver_failure", str(driver["failure"])))
    for name, process in sorted((driver.get("processes") or {}).items()):
        if process.get("forcedKill"):
            reasons.append(Reason("process_failure", f"{name} was killed after its shutdown deadline"))
        elif process.get("exitCode") != 0:
            reasons.append(Reason("process_failure", f"{name} exited {process.get('exitCode')!r}"))
    for name in ("gateway", "broker", "collector"):
        if name not in (driver.get("processes") or {}):
            reasons.append(Reason("process_failure", f"{name} has no recorded exit"))
    replies = [item for item in driver.get("messages", []) if item.get("reply") is not None]
    if len(replies) != sent:
        reasons.append(Reason("reply_missing", f"{len(replies)} of {sent} messages received a reply line"))
    for fixture, record in sorted((driver.get("fixtures") or {}).items()):
        for item in record.get("violations", []):
            reasons.append(Reason("fixture_violation", f"{fixture}: {item}"))
    return reasons


def export_evidence(trace: Path, logs: Path, sent: int) -> tuple[list[Reason], Export | None]:
    try:
        export = Export.load(trace, logs)
    except ExportError as error:
        code = "export_missing" if "missing" in str(error) else "export_malformed"
        return [Reason(code, str(error))], None
    reasons = []
    messages = evidence.messages(export)
    if len(messages) != sent:
        reasons.append(
            Reason("message_evidence_missing", f"{len(messages)} {evidence.ANCHOR_SPAN} spans for {sent} sent messages")
        )
    prompts = []
    for message in messages:
        if not message.prompts:
            reasons.append(Reason("message_evidence_missing", f"message {message.ordinal} has no {evidence.PROMPT_EVENT}"))
        if message.final_answer() is None:
            reasons.append(Reason("message_evidence_missing", f"message {message.ordinal} has no final {evidence.ANSWER_EVENT}"))
        prompts.extend(message.prompts)
    for gap in evidence.continuity_gaps(prompts):
        reasons.append(Reason("message_count_discontinuity", gap))
    return reasons, export


def check(bundle: Path, sent: int, driver: dict[str, Any] | None) -> tuple[dict[str, Any], Export | None]:
    """The verdict and the parsed export (None when unreadable), so grading reads the files once."""
    reasons: list[Reason] = []
    for daemon in DAEMONS:
        reasons.extend(
            console_signals(daemon, bundle / "stdout" / f"{daemon}.jsonl", bundle / "stdout" / f"{daemon}.stderr")
        )
    reasons.extend(collector_errors(bundle / "stdout" / "collector.log"))
    reasons.extend(driver_failures(driver, sent))
    exported, export = export_evidence(bundle / "trace" / "traces.jsonl", bundle / "trace" / "logs.jsonl", sent)
    reasons.extend(exported)
    result = {
        "status": "incomplete" if reasons else "complete",
        "reasons": [reason.to_json() for reason in reasons],
    }
    return result, export
