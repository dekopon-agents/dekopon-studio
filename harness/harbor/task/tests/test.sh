#!/bin/sh
# Offline verifier: regrade the uploaded bundle with the same grader the run used.
# passed -> reward 1, failed -> reward 0. An infrastructure error writes no reward and fails the
# verifier, so Harbor records an error rather than a zero model score.
set -u
mkdir -p /logs/verifier
python3 /evalgw/verify.py /evalgw/bundle > /logs/verifier/grade.json
status=$?
case "$status" in
  0) echo 1 > /logs/verifier/reward.txt ;;
  1) echo 0 > /logs/verifier/reward.txt ;;
  *) echo "evalgw: infrastructure error; see grade.json" >&2; exit 1 ;;
esac
