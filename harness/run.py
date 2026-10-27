#!/usr/bin/env python3.12
"""Run one evalgw scenario against stock Dekopon daemons and write a trial bundle.

    python3.12 harness/run.py harness/scenarios/two-message.json --output /tmp/evalgw-attempt-001

Exit status: 0 passed, 1 failed (a model result), 2 infrastructure error (no model score).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from evalgw import driver  # noqa: E402

EXIT = {"passed": 0, "failed": 1, "infrastructure_error": 2}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scenario", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="new attempt directory; must not exist")
    parser.add_argument("--cache", type=Path, default=HERE / ".cache", help="verified artifact cache")
    arguments = parser.parse_args()
    manifest, graded = driver.run(arguments.scenario, arguments.output, arguments.cache)
    json.dump({"manifest": manifest, "grade": graded}, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return EXIT[graded["status"]]


if __name__ == "__main__":
    sys.exit(main())
