"""Operator calls into the Studio's sole seed importer and trial reader."""

from __future__ import annotations

import base64
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]


class SeedError(ValueError):
    def __init__(self, message: str, *, errors: list[dict[str, Any]] | None = None,
                 notes: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.errors = errors or []
        self.notes = notes or []


def call(operation: str, path: Path, **values: Any) -> dict[str, Any]:
    request = {"operation": operation, "path": str(path.resolve()), **values}
    result = subprocess.run(["node", str(ROOT / "harness/record.mjs")], input=json.dumps(request),
                            capture_output=True, text=True, timeout=120, cwd=ROOT)
    if result.returncode:
        raise SeedError(f"record adapter failed: {result.stderr[-2000:]}")
    decoded = json.loads(result.stdout)
    if not decoded["ok"]:
        raise SeedError(json.dumps(decoded["errors"]), errors=decoded["errors"], notes=decoded["notes"])
    return decoded


@dataclass(frozen=True)
class Seed:
    digest: str
    files: dict[str, bytes]
    record: dict[str, Any]
    messages: list[dict[str, str]]

    @classmethod
    def read(cls, path: Path) -> "Seed":
        result = call("seed", path)
        return cls(result["seedDigest"], {f["path"]: base64.b64decode(f["base64"]) for f in result["files"]},
                   result["record"], result["continuationMessages"])

    def json(self, path: str) -> Any:
        try:
            return json.loads(self.files[path])
        except (KeyError, UnicodeError, ValueError) as error:
            raise SeedError(f"Required executable synthetic fixture missing or invalid: {path}") from error
