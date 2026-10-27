"""Offline grading of a written bundle: the same completeness check and grader the run used."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import completeness, grade
from .bundle import MANIFEST, sha256
from .otlp import Export, ExportError


def regrade(root: Path) -> dict[str, Any]:
    """Recompute the grade from on-disk evidence. A manifest whose hashes no longer match is an
    infrastructure error: the evidence is not what the run recorded."""
    try:
        manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
        scenario = json.loads((root / "config" / "scenario.json").read_text(encoding="utf-8"))
        driver = json.loads((root / "driver.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return _infrastructure(f"bundle unreadable: {error}")
    if manifest.get("bundleVersion") != 1 or manifest.get("kind") != "trial":
        return _infrastructure("not a version 1 trial bundle")
    for reference in _references(manifest):
        path = root / reference["path"]
        if not path.is_file() or sha256(path) != reference["sha256"]:
            return _infrastructure(f"{reference['path']} does not match its manifest hash")
    result = completeness.check(root, len(scenario["messages"]), driver)
    try:
        export: Export | None = Export.load(root / "trace" / "traces.jsonl", root / "trace" / "logs.jsonl")
    except (ExportError, KeyError, TypeError, ValueError):
        export = None
    return grade.grade(export, scenario["expect"]["rules"], result)


def _references(value: Any) -> list[dict[str, Any]]:
    """Every `{path, sha256}` reference in the manifest except grade.json, which a regrade replaces."""
    found = []
    if isinstance(value, dict):
        if isinstance(value.get("path"), str) and isinstance(value.get("sha256"), str):
            if value["path"] != "grade.json":
                found.append(value)
        for item in value.values():
            found.extend(_references(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(_references(item))
    return found


def _infrastructure(reason: str) -> dict[str, Any]:
    return {"gradeVersion": grade.GRADE_VERSION, "status": "infrastructure_error", "score": None, "reasons": [reason], "rules": []}
