#!/usr/bin/env python3.12
"""Grade an existing trial bundle offline, from its own evidence, without changing it.

    python3.12 harness/verify.py /tmp/evalgw-attempt-001

Prints the recomputed grade. Exit status matches run.py: 0 passed, 1 failed, 2 infrastructure error.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from evalgw import verify  # noqa: E402

EXIT = {"passed": 0, "failed": 1, "infrastructure_error": 2}


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    graded = verify.regrade(Path(sys.argv[1]))
    json.dump(graded, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return EXIT[graded["status"]]


if __name__ == "__main__":
    sys.exit(main())
