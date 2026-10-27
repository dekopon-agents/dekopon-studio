# Harbor adapter (optional)

A Harbor 0.23.0 host agent and task that reuse the evalgw runner and grader. The core harness and its
CI tests do not need Harbor.

- `evalgw_agent.py`: `EvalgwHostAgent` runs `driver.run` on the Harbor host (real daemons, loopback
  fixtures, Collector) and writes the bundle into the agent's trial logs as `bundle/`. It then uploads
  the bundle, the `evalgw` package and `verify.py` to `/evalgw/` in the task environment.
- `task/`: a task whose environment is a digest-pinned `python:3.12.12-slim` with no network. Its
  `tests/test.sh` runs `verify.py` on the uploaded bundle: the same completeness check and grader.
  `passed` writes reward 1 and `failed` reward 0. An infrastructure error writes no reward and fails
  the verifier, so Harbor records an error, never a zero model score.

Install Harbor from the hashed lock (resolved for CPython 3.12 on Linux x86_64):

```sh
python3.12 -m venv .venv-harbor
.venv-harbor/bin/pip install --require-hashes --no-deps -r harness/harbor/requirements.lock
PYTHONPATH=harness/harbor .venv-harbor/bin/harbor run --path harness/harbor/task \
  --agent evalgw_agent:EvalgwHostAgent --agent-kwarg scenario=two-message.json
```

Every Harbor trial directory keeps its bundle; nothing is deleted on failure.
