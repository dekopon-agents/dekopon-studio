"""Offline grading of a written bundle: the same completeness check and grader the run used."""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from typing import Any

from . import completeness, grade, scenario as scenarios
from .bundle import MANIFEST, sha256


def regrade(root: Path) -> dict[str, Any]:
    """Recompute the grade from on-disk evidence. Anything that stops a structured grade (an
    unreadable file, a hash that no longer matches, an invalid scenario, an unexpected error) is an
    infrastructure error, never a model result."""
    try:
        return _regrade(root)
    except Exception as error:
        return _infrastructure(f"regrade failed: {type(error).__name__}: {error}")


def _regrade(root: Path) -> dict[str, Any]:
    try:
        manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
        scenario = json.loads((root / "config" / "scenario.json").read_text(encoding="utf-8"))
        driver = json.loads((root / "driver.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return _infrastructure(f"bundle unreadable: {error}")
    if not isinstance(manifest, dict) or manifest.get("bundleVersion") not in (1, 2) or manifest.get("kind") != "trial":
        return _infrastructure("not a supported trial bundle")
    if manifest["bundleVersion"] == 2 and (manifest.get("seedDigest") != driver.get("seed", {}).get("digest") or
            manifest.get("armId") != driver.get("seed", {}).get("armId")):
        return _infrastructure("seeded trial identity does not match its driver evidence")
    for reference in _references(manifest):
        relative = PurePosixPath(reference["path"])
        if relative.is_absolute() or ".." in relative.parts:
            return _infrastructure(f"{reference['path']} escapes the bundle")
        path = root.joinpath(*relative.parts)
        if not path.is_file() or sha256(path) != reference["sha256"]:
            return _infrastructure(f"{reference['path']} does not match its manifest hash")
    try:
        scenarios.validate(scenario, allow_empty=manifest["bundleVersion"] == 2)
    except scenarios.ScenarioError as error:
        return _infrastructure(f"scenario invalid: {error}")
    result, export = completeness.check(root, len(scenario["messages"]), driver)
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
