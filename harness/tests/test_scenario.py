import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
from evalgw import scenario as scenarios  # noqa: E402
from evalgw.fixtures import Service, StubModel  # noqa: E402


class ScenarioTest(unittest.TestCase):
    def test_acceptance_scenario_is_valid(self):
        scenarios.validate(synthetic.scenario())

    def test_an_external_url_is_refused(self):
        data = synthetic.scenario()
        data["broker"]["providerSettings"]["gh"]["baseUrl"] = "https://api.github.com"
        with self.assertRaisesRegex(scenarios.ScenarioError, "URL"):
            scenarios.validate(data)

    def test_text_over_the_transport_limit_is_refused_before_sending(self):
        data = synthetic.scenario()
        data["messages"][0]["text"] = "x" * (scenarios.MAX_TEXT_BYTES + 1)
        with self.assertRaisesRegex(scenarios.ScenarioError, "exceeds"):
            scenarios.validate(data)

    def test_a_provider_without_a_fixture_origin_is_refused(self):
        data = synthetic.scenario()
        del data["broker"]["providerSettings"]["gh"]["baseUrl"]
        data["broker"]["capabilities"]["gh"]["constraints"]["http"]["allowedHosts"] = ["api.github.com"]
        with self.assertRaisesRegex(scenarios.ScenarioError, "fixture service origin"):
            scenarios.validate(data)

    def test_a_grant_beyond_the_fixture_authority_is_refused(self):
        data = synthetic.scenario()
        data["broker"]["capabilities"]["gh"]["capabilities"]["gh.repo.read"] = {
            "constraints": {"http": {"allowedHosts": ["{{service.authority}}", "api.github.com"]}}
        }
        with self.assertRaisesRegex(scenarios.ScenarioError, "exactly the fixture authority"):
            scenarios.validate(data)

    def test_a_credential_binding_is_refused(self):
        data = synthetic.scenario()
        data["broker"]["capabilities"]["gh"]["credential"] = "api-token"
        with self.assertRaisesRegex(scenarios.ScenarioError, "credential is not allowed"):
            scenarios.validate(data)

    def test_a_scenario_cannot_replace_generated_broker_inputs(self):
        """Policy path and provider selection come from assembly, so the bundle records what runs."""
        for key, value in (("policiesPath", "/operator/other.cedar"),
                           ("providers", ["/operator/unchecked-provider.wasm"]),
                           ("identities", []), ("telemetry", {})):
            data = synthetic.scenario()
            data["broker"][key] = value
            with self.assertRaisesRegex(scenarios.ScenarioError, f"broker.{key} is not allowed"):
                scenarios.validate(data)

    def test_launch_config_admits_only_the_fixture_authority(self):
        arguments = dict(
            providers={"gh": Path("/cache/gh-provider.wasm")}, model_authority="127.0.0.1:4001",
            service_authority="127.0.0.1:4002", collector_endpoint="http://127.0.0.1:4003", uid=1000,
        )
        config = scenarios.assemble(synthetic.scenario(), Path("/run/evalgw"), **arguments)
        scenarios.check_assembled(config, ["gh"], "127.0.0.1:4002")
        config["broker"]["capabilities"]["gh"]["constraints"]["http"]["allowedHosts"] = ["api.github.com"]
        with self.assertRaisesRegex(scenarios.ScenarioError, "exactly the fixture authority"):
            scenarios.check_assembled(config, ["gh"], "127.0.0.1:4002")
        del config["broker"]["providerSettings"]["gh"]
        with self.assertRaisesRegex(scenarios.ScenarioError, "fixture service origin"):
            scenarios.check_assembled(config, ["gh"], "127.0.0.1:4002")

    def test_an_unknown_rule_key_is_refused(self):
        data = synthetic.scenario()
        data["expect"]["rules"].append({"rule": "fact", "message": 1, "all_of": ["NOT IN ANSWER"]})
        with self.assertRaisesRegex(scenarios.ScenarioError, r"fact does not support \['all_of'\]"):
            scenarios.validate(data)

    def test_a_rule_without_a_predicate_is_refused(self):
        data = synthetic.scenario()
        data["expect"]["rules"].append({"rule": "fact", "message": 1})
        with self.assertRaisesRegex(scenarios.ScenarioError, "needs one of"):
            scenarios.validate(data)

    def test_a_rule_value_of_the_wrong_type_is_refused(self):
        data = synthetic.scenario()
        data["expect"]["rules"].append({"rule": "output", "message": 1, "count": {"x": [2, 1]}})
        with self.assertRaisesRegex(scenarios.ScenarioError, "wrong type"):
            scenarios.validate(data)

    def test_an_unknown_rule_is_refused(self):
        data = synthetic.scenario()
        data["expect"]["rules"].append({"rule": "python", "message": 1})
        with self.assertRaisesRegex(scenarios.ScenarioError, "unknown kind"):
            scenarios.validate(data)

    def test_assembly_admits_only_the_fixture_authority_without_credentials(self):
        config = scenarios.assemble(
            synthetic.scenario(), Path("/run/evalgw"), providers={"gh": Path("/cache/gh-provider.wasm")},
            model_authority="127.0.0.1:4001", service_authority="127.0.0.1:4002",
            collector_endpoint="http://127.0.0.1:4003", uid=1000,
        )
        gh = config["broker"]["capabilities"]["gh"]
        self.assertEqual(gh["constraints"]["http"]["allowedHosts"], ["127.0.0.1:4002"])
        self.assertNotIn("credential", gh)
        self.assertEqual(config["broker"]["providerSettings"]["gh"]["baseUrl"], "http://127.0.0.1:4002")
        self.assertNotIn("apiKeyEnv", config["gateway"]["models"][0])
        self.assertEqual(config["gateway"]["models"][0]["endpoint"], "http://127.0.0.1:4001/v1")
        self.assertIn('Dekopon::Principal::"synthetic-user"', config["policies"])
        self.assertNotIn("{{", json.dumps(config))


def post(fixture, path, body):
    request = urllib.request.Request(
        f"http://{fixture.authority}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


class FixtureTest(unittest.TestCase):
    def test_stub_model_serves_the_script_in_order_and_refuses_the_rest(self):
        model = StubModel(synthetic.scenario()["model"]["completions"][:1]).start()
        try:
            status, body = post(model, "/v1/chat/completions",
                                {"messages": [{"role": "user", "content": "What is the default branch of synthetic-org/fixture-repo?"}]})
            self.assertEqual(status, 200)
            call = body["choices"][0]["message"]["tool_calls"][0]["function"]
            self.assertEqual(json.loads(call["arguments"]), {"command": "gh repo view synthetic-org/fixture-repo"})
            status, _ = post(model, "/v1/chat/completions", {"messages": []})
            self.assertEqual(status, 500)
        finally:
            model.stop()
        self.assertEqual(model.record()["violations"], ["request 1: beyond the 1 scripted completions"])

    def test_stub_model_refuses_a_request_its_script_did_not_foresee(self):
        model = StubModel(synthetic.scenario()["model"]["completions"]).start()
        try:
            status, _ = post(model, "/v1/chat/completions", {"messages": [{"role": "user", "content": "something else"}]})
        finally:
            model.stop()
        self.assertEqual(status, 500)
        self.assertIn("lacks", model.record()["violations"][0])

    def test_stopping_a_fixture_that_never_started_returns(self):
        for fixture in (StubModel([]), Service([])):
            stopper = threading.Thread(target=fixture.stop, daemon=True)
            stopper.start()
            stopper.join(timeout=5)
            self.assertFalse(stopper.is_alive(), f"{fixture.name} stop() hung before start()")

    def test_service_answers_only_exact_routes(self):
        service = Service(synthetic.scenario()["service"]["routes"]).start()
        try:
            with urllib.request.urlopen(f"http://{service.authority}/repos/synthetic-org/fixture-repo", timeout=5) as response:
                self.assertEqual(json.loads(response.read())["default_branch"], "trunk-synthetic")
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(f"http://{service.authority}/repos/other/repo", timeout=5)
        finally:
            service.stop()
        self.assertEqual(service.record()["violations"], ["unexpected GET /repos/other/repo"])


if __name__ == "__main__":
    unittest.main()
