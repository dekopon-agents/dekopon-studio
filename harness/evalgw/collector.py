"""The pinned OpenTelemetry Collector: OTLP/HTTP in on loopback, OTLP JSON lines out to the bundle."""

from __future__ import annotations

import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .artifacts import COLLECTOR_IMAGE

CONFIG = """\
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file/traces:
    path: /bundle/trace/traces.jsonl
    format: json
  file/logs:
    path: /bundle/trace/logs.jsonl
    format: json
extensions:
  health_check:
    endpoint: 0.0.0.0:13133
service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file/traces]
    logs:
      receivers: [otlp]
      exporters: [file/logs]
"""
STOP_SECONDS = 30
READY_SECONDS = 60


def _docker(*arguments: str, timeout: float = 60) -> str:
    result = subprocess.run(
        ["docker", *arguments], capture_output=True, text=True, timeout=timeout, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(f"docker {arguments[0]} failed: {result.stderr.strip()[:300]}")
    return result.stdout.strip()


class Collector:
    def __init__(self, name: str, bundle: Path, config: Path) -> None:
        self.name = name
        self.bundle = bundle
        self.config = config
        self.endpoint = ""
        self.started = False

    def start(self) -> None:
        _docker(
            "run", "--detach", "--name", self.name,
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--publish", "127.0.0.1::4318", "--publish", "127.0.0.1::13133",
            "--volume", f"{self.bundle / 'trace'}:/bundle/trace",
            "--volume", f"{self.config}:/etc/otelcol-contrib/config.yaml:ro",
            COLLECTOR_IMAGE,
            "--config", "/etc/otelcol-contrib/config.yaml",
            timeout=300,
        )
        self.started = True
        receiver = _docker("port", self.name, "4318/tcp").splitlines()[0].rsplit(":", 1)[1]
        health = _docker("port", self.name, "13133/tcp").splitlines()[0].rsplit(":", 1)[1]
        self.endpoint = f"http://127.0.0.1:{receiver}"
        deadline = time.monotonic() + READY_SECONDS
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{health}/", timeout=2) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            time.sleep(0.25)
        raise TimeoutError("collector readiness deadline")

    def stop(self, log: Path) -> dict[str, Any]:
        """SIGTERM lets the file exporters flush; the exit code says whether they did."""
        if not self.started:
            return {"exitCode": None, "forcedKill": False, "started": False}
        record: dict[str, Any] = {"image": COLLECTOR_IMAGE}
        try:
            _docker("stop", "--time", str(STOP_SECONDS), self.name, timeout=STOP_SECONDS + 30)
            state = _docker("inspect", "--format", "{{.State.ExitCode}} {{.State.OOMKilled}}", self.name)
            code, oom = state.split()
            record["exitCode"] = int(code)
            # docker stop escalates to SIGKILL after --time; that shows as 137.
            record["forcedKill"] = int(code) == 137 or oom == "true"
        finally:
            with log.open("wb") as handle:
                subprocess.run(["docker", "logs", self.name], stdout=handle, stderr=subprocess.STDOUT, timeout=60, check=False)
            subprocess.run(["docker", "rm", "--force", self.name], capture_output=True, timeout=60, check=False)
        return record
