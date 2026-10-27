"""Write a Harbor reward only for a structured model grade.

    python3 -I reward.py <grade.json> <reward.txt>

`passed` with score 1.0 writes 1 and `failed` with score 0.0 writes 0. Anything else (an
infrastructure error, missing or malformed JSON, a status and score that disagree) writes nothing
and exits 1, so Harbor records a verifier error instead of a model score.
"""

import json
import sys
from pathlib import Path

REWARDS = {("passed", 1.0): 1, ("failed", 0.0): 0}


def reward(grade_path: Path) -> int | None:
    try:
        grade = json.loads(grade_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(grade, dict) or grade.get("gradeVersion") != 1:
        return None
    score = grade.get("score")
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        return None
    return REWARDS.get((grade.get("status"), float(score)))


def main() -> int:
    grade_path, reward_path = (Path(argument) for argument in sys.argv[1:3])
    value = reward(grade_path)
    if value is None:
        print("evalgw: no model grade; see grade.json", file=sys.stderr)
        return 1
    reward_path.write_text(f"{value}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
