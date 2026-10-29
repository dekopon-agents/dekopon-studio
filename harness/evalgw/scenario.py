"""Scenario data and the ordinary Dekopon configuration it assembles into.

A scenario is JSON data: catalog agent, broker capabilities/settings, Cedar policy lines, route
settings, ordered messages, scripted completions, fixture routes and grading rules. It carries no
code and no external URL. The only substitutions are the attempt's own loopback values, written as
`{{service.authority}}`, `{{service.origin}}`, `{{principal}}` and `{{agent}}`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .grade import RuleError, validate_rule

SCENARIO_VERSION = 1
BROKER_API = "dekopon.dev/brokerd/v1alpha1"
GATEWAY_API = "dekopon.dev/gatewayd/v1alpha1"
CATALOG_API = "dekopon.dev/v1alpha1"
GATEWAY_PRINCIPAL = "dekopon-gatewayd"
TRANSPORT = "evalgw"
MODEL = "evalgw-stub"
# Refuse before the local transport would truncate (16 KiB text, 64 KiB line).
MAX_TEXT_BYTES = 16 * 1024
MAX_LINE_BYTES = 64 * 1024
REQUIRED = ("scenarioVersion", "id", "agent", "subject", "conversation", "providers", "broker",
            "policies", "gateway", "model", "service", "messages", "expect")
COMPLETION_PREDICATES = {"lastUserContains", "toolContains", "historyContains"}


# Where each pinned provider takes its origin. A scenario may use a provider only when that origin is
# the attempt's loopback service: the gh provider falls back to api.github.com when baseUrl is absent.
FIXTURE_ENDPOINTS = {"gh": "baseUrl"}
BROKER_KEYS = {"capabilities", "providerSettings", "strict"}
# Paths, provider selection, identities and telemetry belong to assembly alone, so the bundle's
# recorded policy and provider artifacts are always the ones the broker reads.
GENERATED_BROKER_KEYS = {"apiVersion", "socketPath", "policiesPath", "providers", "identities", "principals", "telemetry"}
# Credential and secret plumbing has no place in a stub-only trial, at any depth.
CREDENTIAL_KEYS = {"credential", "credentialsPath", "secretMapPath", "secretUse", "defaultSecretUse"}


class ScenarioError(ValueError):
    pass


def _grant_problems(broker: Any, providers: list[str], authority: str, origin: str, *, assembled: bool) -> list[str]:
    """Everything in a broker section that could reach past the fixture service. A scenario's own
    section holds only BROKER_KEYS; the generated keys are accepted only in assembled config."""
    if not isinstance(broker, dict):
        return ["broker is not an object"]
    allowed = BROKER_KEYS | GENERATED_BROKER_KEYS if assembled else BROKER_KEYS
    problems = [f"broker.{key} is not allowed" for key in sorted(set(broker) - allowed)]
    settings = broker.get("providerSettings", {})
    for provider in providers:
        key = FIXTURE_ENDPOINTS.get(provider)
        if key is None:
            problems.append(f"provider {provider!r} has no fixture-backed endpoint")
        elif not isinstance(settings, dict) or not isinstance(settings.get(provider), dict) or settings[provider].get(key) != origin:
            problems.append(f"providerSettings.{provider}.{key} must be the fixture service origin")

    def walk(value: Any, where: str) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in CREDENTIAL_KEYS:
                    problems.append(f"{where}.{key} is not allowed")
                elif key == "allowedHosts" and item != [authority]:
                    problems.append(f"{where}.allowedHosts must be exactly the fixture authority")
                elif key == "http" and where == "broker":
                    problems.append("broker.http is not allowed")
                else:
                    walk(item, f"{where}.{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, f"{where}[{index}]")

    walk(broker, "broker")
    return problems


def check_assembled(config: dict[str, Any], providers: list[str], service_authority: str) -> None:
    """The configuration about to be launched admits only the attempt's loopback fixtures."""
    problems = _grant_problems(config["broker"], providers, service_authority, f"http://{service_authority}", assembled=True)
    if not service_authority.startswith("127.0.0.1:"):
        problems.append("fixture service is not on loopback")
    for model in config["gateway"]["models"]:
        if not str(model.get("endpoint", "")).startswith("http://127.0.0.1:") or "apiKeyEnv" in model:
            problems.append(f"model {model.get('name')!r} is not the loopback stub")
    if problems:
        raise ScenarioError("; ".join(problems))


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _strings(item)]
    if isinstance(value, list):
        return [text for item in value for text in _strings(item)]
    return []


def request_line(scenario: dict[str, Any], text: str) -> bytes:
    line = json.dumps(
        {"subject": scenario["subject"]["external"], "conversation": scenario["conversation"], "text": text},
        separators=(",", ":"),
    ).encode() + b"\n"
    return line


def validate(scenario: dict[str, Any]) -> None:
    missing = [key for key in REQUIRED if key not in scenario]
    if missing:
        raise ScenarioError(f"scenario lacks {missing}")
    if scenario["scenarioVersion"] != SCENARIO_VERSION:
        raise ScenarioError(f"scenarioVersion must be {SCENARIO_VERSION}")
    for text in _strings(scenario):
        if "://" in text:
            raise ScenarioError(f"scenario names a URL ({text[:60]!r}); use {{{{service.origin}}}}")
    if not isinstance(scenario["providers"], list) or not all(isinstance(p, str) for p in scenario["providers"]):
        raise ScenarioError("providers must be a list of names")
    problems = _grant_problems(
        scenario["broker"], scenario["providers"], "{{service.authority}}", "{{service.origin}}", assembled=False
    )
    if problems:
        raise ScenarioError("; ".join(problems))
    if not scenario["messages"]:
        raise ScenarioError("scenario sends no messages")
    for index, message in enumerate(scenario["messages"], 1):
        text = message["text"]
        if len(text.encode()) > MAX_TEXT_BYTES:
            raise ScenarioError(f"message {index} exceeds {MAX_TEXT_BYTES} bytes")
        if len(request_line(scenario, text)) > MAX_LINE_BYTES:
            raise ScenarioError(f"message {index} request line exceeds {MAX_LINE_BYTES} bytes")
    for index, entry in enumerate(scenario["model"]["completions"]):
        unknown = set(entry.get("expect", {})) - COMPLETION_PREDICATES
        respond = entry.get("respond", {})
        if unknown or len(respond) != 1 or not ({"answer", "bash"} & set(respond)):
            raise ScenarioError(f"completion {index} must use known predicates and one answer or bash")
    for index, rule in enumerate(scenario["expect"]["rules"]):
        try:
            validate_rule(rule)
        except RuleError as error:
            raise ScenarioError(f"rule {index}: {error}") from None
        if rule["message"] > len(scenario["messages"]):
            raise ScenarioError(f"rule {index} names no sent message")


def load(path: Path) -> dict[str, Any]:
    scenario = json.loads(path.read_text(encoding="utf-8"))
    validate(scenario)
    return scenario


def _substitute(value: Any, values: dict[str, str]) -> Any:
    if isinstance(value, str):
        for key, replacement in values.items():
            value = value.replace("{{" + key + "}}", replacement)
        return value
    if isinstance(value, dict):
        return {key: _substitute(item, values) for key, item in value.items()}
    if isinstance(value, list):
        return [_substitute(item, values) for item in value]
    return value


def assemble(
    scenario: dict[str, Any],
    runtime: Path,
    *,
    providers: dict[str, Path],
    model_authority: str,
    service_authority: str,
    collector_endpoint: str,
    uid: int,
) -> dict[str, Any]:
    """The four daemon inputs for one attempt: catalog, policies, broker and gateway config."""
    agent = scenario["agent"]["name"]
    values = {
        "service.authority": service_authority,
        "service.origin": f"http://{service_authority}",
        "principal": scenario["subject"]["principal"],
        "agent": agent,
    }
    namespace = scenario["subject"]["external"].split(".", 1)[0]
    telemetry = {"endpoint": collector_endpoint, "transport": "http", "exportTimeoutMs": 10000}
    broker_section = _substitute(scenario["broker"], values)
    catalog = {
        "apiVersion": CATALOG_API,
        "kind": "Agent",
        "metadata": {"name": agent},
        "spec": {key: value for key, value in scenario["agent"].items() if key != "name"},
    }
    policies = "\n".join(_substitute(scenario["policies"], values)) + "\n"
    broker = {
        **broker_section,  # first, so no scenario key can replace a generated one
        "apiVersion": BROKER_API,
        "socketPath": str(runtime / "broker.sock"),
        "policiesPath": str(runtime / "policies.cedar"),
        "providers": [str(providers[name]) for name in scenario["providers"]],
        "identities": [
            {
                "uid": uid,
                "principal": GATEWAY_PRINCIPAL,
                "actor": {"type": "service", "principal": GATEWAY_PRINCIPAL},
                "attestor": {"namespaces": [namespace]},
            }
        ],
        "principals": {scenario["subject"]["principal"]: {"subjects": [scenario["subject"]["external"]]}},
        "telemetry": {**telemetry, "serviceName": "dekopon-brokerd"},
    }
    route = _substitute(scenario["gateway"]["route"], values)
    gateway = {
        "apiVersion": GATEWAY_API,
        "catalogPath": str(runtime / "catalog.json"),
        "broker": {"socketPath": str(runtime / "broker.sock"), "serverUid": uid},
        "transports": [{"name": TRANSPORT, "kind": "local", "socketPath": str(runtime / "local.sock")}],
        # The stub answers one JSON completion, which is what `stream: false` exists for.
        "models": [
            {
                "name": MODEL,
                "kind": "openaiCompatible",
                "model": scenario["model"].get("model", MODEL),
                "endpoint": f"http://{model_authority}/v1",
                "timeoutMs": 15000,
                "classes": [scenario["agent"]["modelClass"]],
                "stream": False,
            }
        ],
        "routes": [
            {
                "transport": TRANSPORT,
                "conversation": {"kind": [scenario["conversation"]["kind"]]},
                "agent": agent,
                **route,
            }
        ],
        # Journal-backed sessions keep both stores inside the private runtime.
        "sessions": {
            **scenario["gateway"].get("sessions", {}),
            "journal": {"path": str(runtime / "journal")},
            "assets": {"path": str(runtime / "assets")},
        },
        "shutdownGraceMs": scenario["gateway"].get("shutdownGraceMs", 15000),
        "telemetry": {**telemetry, "serviceName": "dekopon-gatewayd"},
    }
    return {"catalog": catalog, "policies": policies, "broker": broker, "gateway": gateway}


def write_private(path: Path, text: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
