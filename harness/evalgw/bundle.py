"""Trial bundle v1: one exclusive directory per attempt with a versioned manifest (BUNDLE.md)."""

from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from typing import Any

BUNDLE_VERSION = 1
MANIFEST = "manifest.json"
SUBDIRECTORIES = ("trace", "journal", "config", "stdout")
TRACE_FORMAT = "otlp-jsonl"
JOURNAL_FORMAT = "dekopon-gatewayd-journal (internal, unversioned on disk; v2 at dekopon 0.62.0)"


def now() -> str:
    return datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    """Owner-only, atomically replaced: a reader never sees a half-written file."""
    temporary = path.with_name(f".{path.name}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class Bundle:
    """An attempt directory. Creation is exclusive; nothing here deletes or reuses one."""

    def __init__(self, root: Path, attempt: str, scenario: str, started: str) -> None:
        self.root = root
        self.attempt = attempt
        self.scenario = scenario
        self.started = started

    @classmethod
    def create(cls, root: Path, attempt: str, scenario: str) -> "Bundle":
        root.mkdir(mode=0o700)  # FileExistsError: an attempt directory is never reused.
        for name in SUBDIRECTORIES:
            (root / name).mkdir(mode=0o700)
        bundle = cls(root, attempt, scenario, now())
        write_json(root / MANIFEST, bundle.initial_manifest())
        return bundle

    def initial_manifest(self) -> dict[str, Any]:
        return {
            "bundleVersion": BUNDLE_VERSION,
            "kind": "trial",
            "attempt": {"id": self.attempt, "startedAt": self.started, "finishedAt": None},
            "scenario": {"id": self.scenario, "config": None},
            "completeness": {
                "status": "incomplete",
                "reasons": [{"code": "not_finalized", "detail": "the attempt has not finished"}],
            },
            "grade": None,
        }

    def path(self, relative: str) -> Path:
        pure = PurePosixPath(relative)
        if pure.is_absolute() or ".." in pure.parts:
            raise ValueError(f"bundle path {relative!r} escapes the bundle")
        return self.root.joinpath(*pure.parts)

    def ref(self, relative: str) -> dict[str, Any] | None:
        """A manifest reference: relative path, SHA-256 and size, or None when the file is absent."""
        path = self.path(relative)
        if not path.is_file():
            return None
        return {"path": relative, "sha256": sha256(path), "bytes": path.stat().st_size}

    def journal_files(self) -> list[dict[str, Any]]:
        base = self.root / "journal"
        files = sorted(path for path in base.rglob("*") if path.is_file())
        return [self.ref(path.relative_to(self.root).as_posix()) for path in files]

    def finalize(
        self,
        *,
        scenario_id: str,
        dekopon: dict[str, Any],
        providers: list[dict[str, Any]],
        collector: dict[str, Any],
        freeze: dict[str, Any] | None,
        loss_signals: list[dict[str, str]],
        completeness: dict[str, Any],
        gaps: list[str],
    ) -> dict[str, Any]:
        journal = self.journal_files()
        manifest = {
            "bundleVersion": BUNDLE_VERSION,
            "kind": "trial",
            "attempt": {"id": self.attempt, "startedAt": self.started, "finishedAt": now()},
            "scenario": {"id": scenario_id, "config": self.ref("config/scenario.json")},
            "dekopon": dekopon,
            "providers": providers,
            "collector": collector,
            "trace": {"format": TRACE_FORMAT, **(self.ref("trace/traces.jsonl") or {"path": None})},
            "logs": {"format": TRACE_FORMAT, **(self.ref("trace/logs.jsonl") or {"path": None})},
            "journal": {"format": JOURNAL_FORMAT, "files": journal} if journal else None,
            "freeze": freeze,
            "config": {
                name: self.ref(f"config/{file}")
                for name, file in (
                    ("scenario", "scenario.json"),
                    ("catalog", "catalog.json"),
                    ("broker", "broker.json"),
                    ("gateway", "gateway.json"),
                    ("policies", "policies.cedar"),
                    ("collector", "collector.yaml"),
                )
            },
            "stdout": {
                "gateway": {"stdout": self.ref("stdout/gateway.jsonl"), "stderr": self.ref("stdout/gateway.stderr")},
                "broker": {"stdout": self.ref("stdout/broker.jsonl"), "stderr": self.ref("stdout/broker.stderr")},
                "collector": self.ref("stdout/collector.log"),
                "lossSignals": loss_signals,
            },
            "driver": self.ref("driver.json"),
            "completeness": completeness,
            "grade": self.ref("grade.json"),
            "gaps": gaps,
            "seedDigest": None,
        }
        write_json(self.root / MANIFEST, manifest)
        return manifest
