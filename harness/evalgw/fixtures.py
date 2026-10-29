"""Loopback fixtures: an OpenAI-compatible stub model and a synthetic HTTP service.

Both bind 127.0.0.1 on an ephemeral port, answer only what the scenario scripts, and record every
deviation as a violation. A violation makes the bundle incomplete: a scripted model that was asked
something its script did not foresee is an infrastructure fault, not a model result.
"""

from __future__ import annotations

import http.server
import json
import threading
from typing import Any

MAX_REQUEST_BYTES = 1024 * 1024
MODEL_PATH = "/v1/chat/completions"


def _text(content: Any) -> str:
    """Flatten a chat message's content, string or list of parts, into text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(_text(part.get("text") if isinstance(part, dict) else part) for part in content)
    return ""


def unmet(expect: dict[str, Any], messages: list[dict[str, Any]]) -> list[str]:
    """The scripted request predicates this chat request fails."""
    users = [_text(m.get("content")) for m in messages if m.get("role") == "user"]
    tools = [_text(m.get("content")) for m in messages if m.get("role") == "tool"]
    # History is what came before the current prompt from the conversation itself: on a
    # journal-backed route 0.62.0 replays earlier turns in an earlier user message ("[memory: ...]"),
    # not as assistant messages. The final prompt and system prompts never count, so a question that
    # merely repeats the fact cannot satisfy it.
    history = [_text(m.get("content")) for m in messages[:-1] if m.get("role") in ("user", "tool", "assistant")]
    failures = []
    if "lastUserContains" in expect and not (users and expect["lastUserContains"] in users[-1]):
        failures.append(f"last user message lacks {expect['lastUserContains']!r}")
    if "toolContains" in expect and not any(expect["toolContains"] in text for text in tools):
        failures.append(f"no tool result contains {expect['toolContains']!r}")
    if "historyContains" in expect and not any(expect["historyContains"] in text for text in history):
        failures.append(f"no earlier conversation message carries {expect['historyContains']!r}")
    return failures


def completion(respond: dict[str, Any], index: int) -> dict[str, Any]:
    if "bash" in respond:
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": f"evalgw-call-{index}",
                    "type": "function",
                    "function": {"name": "bash", "arguments": json.dumps({"command": respond["bash"]})},
                }
            ],
        }
    else:
        message = {"role": "assistant", "content": respond["answer"], "tool_calls": []}
    return {"choices": [{"message": message, "finish_reason": "stop" if "answer" in respond else "tool_calls"}]}


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


class Fixture:
    """A loopback HTTP server whose handler is `respond(method, path, body) -> (status, json)`."""

    def __init__(self, name: str, port: int = 0) -> None:
        self.name = name
        self.requests: list[dict[str, Any]] = []
        self.violations: list[str] = []
        self.lock = threading.Lock()
        self.started = False
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass  # Request lines and headers stay out of the operator console.

            def _serve(self) -> None:
                self.connection.settimeout(10)
                size = int(self.headers.get("Content-Length") or 0)
                if size > MAX_REQUEST_BYTES:
                    status, body = 413, {"error": "request too large"}
                    with fixture.lock:
                        fixture.violations.append(f"{self.command} {self.path}: {size} byte body")
                else:
                    raw = self.rfile.read(size) if size else b""
                    with fixture.lock:
                        status, body = fixture.respond(self.command, self.path, raw)
                encoded = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            do_GET = do_POST = _serve

        self.server = _Server(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, name=f"evalgw-{name}", daemon=True)

    @property
    def authority(self) -> str:
        return f"127.0.0.1:{self.server.server_port}"

    def start(self) -> "Fixture":
        self.thread.start()
        self.started = True
        return self

    def stop(self) -> None:
        """Safe before start: `shutdown()` waits for a serve loop that would never come."""
        if self.started:
            self.server.shutdown()
            self.thread.join(timeout=10)
        self.server.server_close()

    def respond(self, method: str, path: str, raw: bytes) -> tuple[int, Any]:
        raise NotImplementedError

    def record(self) -> dict[str, Any]:
        with self.lock:
            return {"requests": list(self.requests), "violations": list(self.violations)}


class StubModel(Fixture):
    """Serves the scenario's completions in order: bounded, non-streaming, no API key."""

    def __init__(self, completions: list[dict[str, Any]], *, port: int = 0,
                 summaries: dict[str, Any] | None = None) -> None:
        super().__init__("model", port)
        self.completions = completions
        self.summaries = summaries
        self.main_count = 0
        self.summary_count = 0

    def respond(self, method: str, path: str, raw: bytes) -> tuple[int, Any]:
        index = len(self.requests)
        entry: dict[str, Any] = {"index": index, "method": method, "path": path}
        self.requests.append(entry)
        if method != "POST" or path != MODEL_PATH:
            self.violations.append(f"request {index}: unexpected {method} {path}")
            return 404, {"error": "unexpected model request"}
        try:
            request = json.loads(raw)
            messages = request["messages"]
        except (ValueError, KeyError, TypeError, RecursionError):
            self.violations.append(f"request {index}: not a chat completion request")
            return 400, {"error": "not a chat completion request"}
        if self.summaries and request.get("model") == self.summaries["model"]:
            entry["kind"] = "summary"
            self.summary_count += 1
            text = "\n".join(_text(m.get("content")) for m in messages if m.get("role") != "system")
            answer = self.summaries["defaultAnswer"]
            for rule in self.summaries.get("responses", []):
                if rule["inputContains"] in text:
                    answer = rule["answer"]
                    break
            return 200, completion({"answer": answer}, index)
        script_index = self.main_count
        self.main_count += 1
        entry["kind"] = "main"
        if script_index >= len(self.completions):
            self.violations.append(f"request {index}: beyond the {len(self.completions)} scripted completions")
            return 500, {"error": "no scripted completion"}
        entry["messageCount"] = len(messages)
        entry["stream"] = request.get("stream")
        script = self.completions[script_index]
        failures = unmet(script.get("expect", {}), messages)
        if failures:
            self.violations.extend(f"request {index}: {failure}" for failure in failures)
            return 500, {"error": "request did not match the script"}
        return 200, completion(script["respond"], index)

    def record(self) -> dict[str, Any]:
        record = super().record()
        served = self.main_count
        if served < len(self.completions):
            record["violations"].append(f"only {served} of {len(self.completions)} scripted completions were requested")
        return record


class Service(Fixture):
    """Exact method and path routes with fixed synthetic JSON; anything else is a 404 violation."""

    def __init__(self, routes: list[dict[str, Any]], *, port: int = 0) -> None:
        super().__init__("service", port)
        self.routes = {(route["method"], route["path"]): route for route in routes}

    def respond(self, method: str, path: str, raw: bytes) -> tuple[int, Any]:
        self.requests.append({"method": method, "path": path})
        route = self.routes.get((method, path))
        if route is None:
            self.violations.append(f"unexpected {method} {path}")
            return 404, {"message": "Not Found"}
        if "decisionChoice" in route:
            try:
                request = json.loads(raw)
                labels = list(request["questions"]["decision"]["criteria"])
                choice = route["decisionChoice"]
                if choice not in labels or request["model"] != "typesafe/jev-1.13":
                    raise ValueError("invalid decision fixture input")
            except (KeyError, TypeError, ValueError):
                self.violations.append("invalid decision fixture input")
                return 400, {"error": "invalid decision fixture input"}
            self.requests[-1].update(kind="decider", labels=labels, choice=choice)
            return 200, {"model": request["model"], "answers": {"decision": {
                "type": "choice", "choice": choice,
                "probabilities": {label: float(label == choice) for label in labels}}}}
        return route.get("status", 200), route["json"]
