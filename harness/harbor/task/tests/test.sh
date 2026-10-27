#!/bin/sh
# Offline verifier: regrade the uploaded bundle with the same grader the run used, then reward only
# a structured passed/failed grade. An infrastructure error, a crash or missing JSON writes no reward
# and fails the verifier, so Harbor records an error rather than a zero model score.
set -u
mkdir -p /logs/verifier
python3 -I /evalgw/verify.py /evalgw/bundle > /logs/verifier/grade.json
python3 -I /tests/reward.py /logs/verifier/grade.json /logs/verifier/reward.txt
