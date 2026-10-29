"""One attempt: Collector, fixtures, brokerd, gatewayd, N strictly sequential messages, SIGTERM drain.

Setup follows dekopon's examples/otel-traces/drive-turn.py: owner-only files and directories,
socket readiness that checks type, mode and owner, a clean allowlisted child environment, and
bounded shutdown. Every process is stopped through its own handle; nothing is matched by name.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from . import artifacts, completeness, grade, scenario as scenarios
from .bundle import Bundle, now, sha256, write_json
from .collector import CONFIG as COLLECTOR_CONFIG, Collector
from .fixtures import Service, StubModel

READY_SECONDS = 60
BROKER_STOP_SECONDS = 25
REPLY_SECONDS = 120
DRAIN_MARGIN_SECONDS = 15
STANDING_GAPS = [
    "seedDigest: seed continuation and branch execution are not implemented in bundle v1",
    "model settings: only what model.complete reports is known; effective sampling settings are unknown",
]


def child_environment(home: Path) -> dict[str, str]:
    """No ambient credentials, proxies or OTLP headers reach a daemon."""
    return {"PATH": os.defpath, "HOME": str(home), "RUST_LOG": "warn"}


def version(binary: Path, home: Path) -> str:
    result = subprocess.run(
        [str(binary), "--version"], env=child_environment(home), capture_output=True, text=True, timeout=30, check=False
    )
    text = result.stdout.strip()
    if result.returncode != 0 or artifacts.DEKOPON_VERSION not in text.split():
        raise artifacts.ArtifactError(f"{binary.name} --version printed {text!r}, not {artifacts.DEKOPON_VERSION}")
    return text


def ready(path: Path, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + READY_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"daemon exited {process.returncode} before {path.name} was ready")
        if path.exists():
            mode = path.lstat()
            if not stat.S_ISSOCK(mode.st_mode) or stat.S_IMODE(mode.st_mode) != 0o600:
                raise RuntimeError(f"{path.name} is not a private socket")
            if mode.st_uid != os.geteuid():
                raise RuntimeError(f"{path.name} owner mismatch")
            return
        time.sleep(0.1)
    raise TimeoutError(f"{path.name} readiness deadline")


def stop(process: subprocess.Popen[bytes], seconds: float) -> dict[str, Any]:
    """SIGTERM, wait, and only past the deadline kill. A kill is recorded; it voids the freeze."""
    record: dict[str, Any] = {"signal": "SIGTERM", "forcedKill": False}
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
            record["forcedKill"] = True
    else:
        record["signal"] = None
    record["exitCode"] = process.returncode
    return record


def converse(path: Path, scenario: dict[str, Any], record: list[dict[str, Any]]) -> None:
    """Send message N, read N's whole reply line, then send N+1. Nothing is pipelined."""
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(scenario.get("replyTimeoutSeconds", REPLY_SECONDS))
        client.connect(str(path))
        with client.makefile("rb") as reader:
            for ordinal, message in enumerate(scenario["messages"], 1):
                line = scenarios.request_line(scenario, message["text"])
                entry: dict[str, Any] = {"ordinal": ordinal, "text": message["text"], "sentAt": now(), "reply": None}
                record.append(entry)
                client.sendall(line)
                reply = reader.readline(scenarios.MAX_LINE_BYTES + 1)
                entry["repliedAt"] = now()
                if not reply.endswith(b"\n") or len(reply) > scenarios.MAX_LINE_BYTES:
                    raise RuntimeError(f"message {ordinal}: reply line missing or over {scenarios.MAX_LINE_BYTES} bytes")
                # Transport evidence only: the gateway cuts replies, so grading never reads this.
                entry["reply"] = json.loads(reply)


def copy_journal(runtime: Path, bundle: Bundle) -> str:
    """Verbatim copy of the gateway journal, taken only once the gateway has exited."""
    # The journal root also holds private runtime state (including the prompt-cache key).
    # Bundle v1 carries only conversation transcripts, never those sibling files.
    for source in (runtime / "journal").glob("*/*.jsonl"):
        if source.is_file():
            destination = bundle.path("journal/" + source.relative_to(runtime / "journal").as_posix())
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            os.chmod(destination, 0o600)
    return now()


def wait_summaries(runtime: Path, records: int, prior_turns: set[str]) -> None:
    from .bridge import call
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        snapshot = call("journals", runtime)["records"]
        if sum(r["turn"] not in prior_turns for r in snapshot) >= records and all(not r["plan"] or
                all(slot["state"] == "generated" for slot in r["summaries"]) for r in snapshot):
            return
        if any(slot["state"] == "error" for r in snapshot for slot in r["summaries"]):
            raise RuntimeError("Reference summary generation failed; no generated-summary freeze can be claimed")
        time.sleep(0.1)
    raise TimeoutError("summary publication deadline before freeze")


def run(scenario_path: Path | None, output: Path, cache: Path, *, restored: Any = None) -> tuple[dict[str, Any], dict[str, Any]]:
    cache = cache.resolve()
    scenario = restored.scenario if restored is not None else scenarios.load(scenario_path)
    attempt = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    bundle = Bundle.create(output, attempt, scenario["id"],
                           seed_digest=restored.seed_digest if restored is not None else None,
                           arm_id=restored.arm_id if restored is not None else None)
    if restored is None:
        shutil.copyfile(scenario_path, bundle.path("config/scenario.json"))
    else:
        write_json(bundle.path("config/scenario.json"), scenario)
    os.chmod(bundle.path("config/scenario.json"), 0o600)

    runtime = Path(tempfile.mkdtemp(prefix="evalgw-"))
    home = runtime / "home"
    home.mkdir(mode=0o700)
    (runtime / "journal").mkdir(mode=0o700)
    (runtime / "assets").mkdir(mode=0o700)
    driver: dict[str, Any] = {"attempt": attempt, "messages": [], "processes": {}, "fixtures": {}, "failure": None}
    if restored is not None:
        driver["seed"] = {"digest": restored.seed_digest, "armId": restored.arm_id,
                          "notes": restored.seed.record["notes"], "gaps": restored.seed.record["gaps"],
                          "completeness": restored.seed.record["completeness"]}
    dekopon: dict[str, Any] = {"version": artifacts.DEKOPON_VERSION, "source": artifacts.DEKOPON.source, "binaries": {}}
    providers: list[dict[str, Any]] = []
    collector_record: dict[str, Any] = {"image": artifacts.COLLECTOR_IMAGE}
    freeze = None
    started: list[tuple[str, subprocess.Popen[bytes], float]] = []
    handles = []
    # Fixtures bind their sockets inside the try, so a failure there still finalizes the attempt.
    fixtures: dict[str, StubModel | Service] = {}
    collector = Collector(f"evalgw-{attempt}", output.resolve(), runtime / "collector.yaml")
    try:
        binaries = artifacts.daemons(cache)
        dekopon["artifact"] = artifacts.describe(artifacts.DEKOPON, artifacts.fetch(artifacts.DEKOPON, cache))
        for name, binary in binaries.items():
            dekopon["binaries"][name] = {"sha256": sha256(binary), "version": version(binary, home)}
        provider_paths = {}
        for name in scenario["providers"]:
            pinned = artifacts.PROVIDERS[name]
            provider_paths[name] = artifacts.fetch(pinned, cache)
            providers.append({"id": name, **artifacts.describe(pinned, provider_paths[name])})

        scenarios.write_private(runtime / "collector.yaml", COLLECTOR_CONFIG)
        shutil.copyfile(runtime / "collector.yaml", bundle.path("config/collector.yaml"))
        collector.start()
        model = fixtures["model"] = StubModel(scenario["model"]["completions"],
                                               port=restored.model_port if restored is not None else 0,
                                               summaries=scenario["model"].get("summaries"))
        service = fixtures["service"] = Service(scenario["service"]["routes"],
                                               port=restored.service_port if restored is not None else 0)
        model.start()
        service.start()
        config = scenarios.assemble(
            scenario,
            runtime,
            providers=provider_paths,
            model_authority=model.authority,
            service_authority=service.authority,
            collector_endpoint=collector.endpoint,
            uid=os.geteuid(),
        )
        if restored is not None:
            config = restored.apply(config)
            restored.stage(runtime)
        # Refuse before any daemon starts: every HTTP grant and provider endpoint is the fixture.
        scenarios.check_assembled(config, scenario["providers"], service.authority)
        files = {
            "catalog.json": restored.seed.files["config/catalog.json"].decode() if restored is not None
                            else json.dumps(config["catalog"], indent=2),
            "policies.cedar": config["policies"],
            "broker.json": json.dumps(config["broker"], indent=2),
            "gateway.json": json.dumps(config["gateway"], indent=2),
        }
        for name, text in files.items():
            scenarios.write_private(runtime / name, text)
            scenarios.write_private(bundle.path(f"config/{name}"), text)

        def launch(name: str, binary: Path, config_file: str, stop_seconds: float) -> subprocess.Popen[bytes]:
            stdout = bundle.path(f"stdout/{name}.jsonl").open("wb")
            stderr = bundle.path(f"stdout/{name}.stderr").open("wb")
            handles.extend([stdout, stderr])
            process = subprocess.Popen(
                [str(binary), "--config", str(runtime / config_file)],
                env=child_environment(home), stdout=stdout, stderr=stderr, cwd=runtime,
            )
            started.append((name, process, stop_seconds))
            return process

        broker = launch("broker", binaries["dekopon-brokerd"], "broker.json", BROKER_STOP_SECONDS)
        ready(runtime / "broker.sock", broker)
        drain = config["gateway"]["shutdownGraceMs"] / 1000 + DRAIN_MARGIN_SECONDS
        if restored is not None:
            restored.verify_staged(runtime)
        gateway = launch("gateway", binaries["dekopon-gatewayd"], "gateway.json", drain)
        ready(runtime / "local.sock", gateway)
        converse(runtime / "local.sock", scenario, driver["messages"])
        if scenario["model"].get("summaries"):
            wait_summaries(runtime, len(scenario["messages"]),
                           {r["turn"] for r in restored.seed.record["journals"]} if restored is not None else set())

        # Gateway first: its SIGTERM drains sessions and flushes telemetry while broker,
        # fixtures and Collector are still up. Only a clean, unforced exit is a freeze.
        driver["processes"]["gateway"] = stop(gateway, drain)
        driver["processes"]["broker"] = stop(broker, BROKER_STOP_SECONDS)
        started.clear()
        copied = copy_journal(runtime, bundle)
        gateway_record = driver["processes"]["gateway"]
        if gateway_record["exitCode"] == 0 and not gateway_record["forcedKill"] and gateway_record["signal"] == "SIGTERM":
            stems = sorted(
                path.relative_to(runtime / "journal").with_suffix("").as_posix()
                for path in (runtime / "journal").rglob("*.jsonl")
            )
            freeze = {
                "lastRepliedMessage": len([m for m in driver["messages"] if m["reply"] is not None]),
                "conversation": scenario["conversation"],
                "journalStems": stems,
                "gateway": {"signal": "SIGTERM", "drained": True, "exitCode": 0},
                "copiedAt": copied,
            }
    except Exception as error:  # Every failure is kept as evidence; the attempt stays on disk.
        driver["failure"] = f"{type(error).__name__}: {error}"
    finally:
        for name, process, seconds in started:
            driver["processes"][name] = stop(process, seconds)
        if started:
            # A failed attempt keeps whatever journal exists; without a clean drain it is no freeze.
            copy_journal(runtime, bundle)
        for handle in handles:
            handle.close()
        for name, fixture in fixtures.items():
            fixture.stop()
            driver["fixtures"][name] = fixture.record()
        try:
            collector_record.update(collector.stop(bundle.path("stdout/collector.log")))
        except Exception as error:
            collector_record["error"] = f"{type(error).__name__}: {error}"
        driver["processes"]["collector"] = {
            "exitCode": collector_record.get("exitCode"),
            "forcedKill": collector_record.get("forcedKill", False),
        }
        shutil.rmtree(runtime, ignore_errors=True)

    write_json(bundle.path("driver.json"), driver)
    return finish(bundle, scenario, driver, dekopon, providers, collector_record, freeze, restored=restored)


def finish(
    bundle: Bundle,
    scenario: dict[str, Any],
    driver: dict[str, Any],
    dekopon: dict[str, Any],
    providers: list[dict[str, Any]],
    collector_record: dict[str, Any],
    freeze: dict[str, Any] | None,
    *, restored: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Completeness, grade and the final manifest for a bundle whose evidence is on disk."""
    sent = len(scenario["messages"])
    try:
        result, export = completeness.check(bundle.root, sent, driver)
        if restored is not None:
            bundle.finalize(scenario_id=scenario["id"], dekopon=dekopon, providers=providers,
                            collector=collector_record, freeze=freeze, loss_signals=[], gaps=[],
                            completeness={"status": "incomplete", "reasons": [{"code": "first_projection_pending",
                                            "detail": "first-projection comparison has not finished"}]})
            driver["firstProjection"] = restored.check(bundle.root)
            write_json(bundle.path("driver.json"), driver)
            result["reasons"] = [r for r in result["reasons"] if not r["code"].startswith("first_projection_")]
            result["reasons"].extend(r.to_json() for r in completeness.projection_failures(driver))
            result["status"] = "incomplete" if result["reasons"] else "complete"
        graded = grade.grade(export, scenario["expect"]["rules"], result)
    except Exception as error:  # A finalization defect is still an unscored, finished attempt.
        detail = f"{type(error).__name__}: {error}"
        result = {"status": "incomplete", "reasons": [{"code": "finalization_error", "detail": detail}]}
        graded = {"gradeVersion": grade.GRADE_VERSION, "status": "infrastructure_error", "score": None,
                  "reasons": [f"finalization_error: {detail}"], "rules": []}
    if restored is not None and "firstProjection" not in driver:
        driver["firstProjection"] = restored.unavailable("finalization_error")
        write_json(bundle.path("driver.json"), driver)
    write_json(bundle.path("grade.json"), graded)
    gaps = [gap for gap in STANDING_GAPS if restored is None or not gap.startswith("seedDigest:")]
    if not bundle.journal_files():
        gaps.append("journal: no journal file was copied")
    if freeze is None:
        gaps.append("freeze: the gateway did not drain cleanly, so no freeze point exists")
    loss = [r for r in result["reasons"] if r["code"] in completeness.CONSOLE_CODES]
    manifest = bundle.finalize(
        scenario_id=scenario["id"],
        dekopon=dekopon,
        providers=providers,
        collector=collector_record,
        freeze=freeze,
        loss_signals=loss,
        completeness=result,
        gaps=gaps,
    )
    return manifest, graded
