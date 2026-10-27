"""Harbor 0.23.0 host agent: run one evalgw scenario on the host and hand the bundle to the verifier.

The daemons, fixtures and Collector run on the Harbor host, exactly as `harness/run.py` runs them;
the task environment only receives the finished bundle and the grading code. The bundle is also kept
in this agent's trial logs. Import path: `evalgw_agent:EvalgwHostAgent` with `harness/harbor` on
`PYTHONPATH`, agent kwarg `scenario` naming a file under `harness/scenarios/`.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.agents.options import AgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import Field

HARNESS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HARNESS))

from evalgw import driver  # noqa: E402

# Where the verifier finds what this agent uploads (see task/tests/test.sh).
ENVIRONMENT_ROOT = "/evalgw"


class Options(AgentOptions):
    scenario: str = Field(default="two-message.json", description="Scenario file under harness/scenarios/")


class EvalgwHostAgent(BaseAgent):
    options_model = Options

    @staticmethod
    def name() -> str:
        return "evalgw-host"

    def version(self) -> str:
        return "1"

    async def setup(self, environment: BaseEnvironment) -> None:
        return

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        scenario = (HARNESS / "scenarios" / self.options.scenario).resolve()
        if scenario.parent != (HARNESS / "scenarios").resolve() or not scenario.is_file():
            raise ValueError(f"unknown scenario {self.options.scenario!r}")
        bundle = self.logs_dir / "bundle"
        manifest, graded = await asyncio.to_thread(driver.run, scenario, bundle, HARNESS / ".cache")
        await environment.upload_dir(bundle, f"{ENVIRONMENT_ROOT}/bundle")
        await environment.upload_dir(HARNESS / "evalgw", f"{ENVIRONMENT_ROOT}/evalgw")
        await environment.upload_file(HARNESS / "verify.py", f"{ENVIRONMENT_ROOT}/verify.py")
        # The stub model is not billed and reports no usage; token and cost fields stay unknown.
        context.metadata = {
            "evalgw": {
                "attempt": manifest["attempt"]["id"],
                "completeness": manifest["completeness"]["status"],
                "grade": graded,
            }
        }
